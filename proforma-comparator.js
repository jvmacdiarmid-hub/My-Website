/**
 * NVCA Pro Forma Comparator v1.0
 *
 * Three capabilities:
 *   1. diffProFormas(vA, vB)           — version-to-version diff
 *   2. checkConformance(pf, termSheet) — pro forma vs negotiated terms
 *   3. createDatabase()                — in-memory document store
 *
 * Works in Node.js (CommonJS) and browser (global ProFormaComparator).
 */
const ProFormaComparator = (function () {
  'use strict';

  // ============================================================
  // CONSTANTS
  // ============================================================

  const VALUATION_TOL = 0.0005;   // 0.05% tolerance for $$ fields
  const POOL_TOL      = 0.0010;   // 0.10 pp tolerance for option pool %
  const PPS_TOL_ABS   = 0.005;    // $0.005 absolute tolerance on PPS
  const PCT_TOL       = 0.0010;   // 0.10 pp tolerance for ownership %

  // ============================================================
  // HELPERS
  // ============================================================

  function toNum(v) {
    if (v == null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  function indexBy(arr, key) {
    const m = {};
    for (const item of arr) m[item[key]] = item;
    return m;
  }

  function fmtCurrency(n) {
    if (n == null) return 'N/A';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function fmtPPS(n) {
    if (n == null) return 'N/A';
    return '$' + n.toFixed(4);
  }

  function fmtPct(n) {
    if (n == null) return 'N/A';
    return (n * 100).toFixed(2) + '%';
  }

  function fmtShares(n) {
    if (n == null) return 'N/A';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtMultiple(n) {
    if (n == null) return 'N/A';
    return n + 'x';
  }

  function fmtBool(v) {
    return v ? 'Yes' : 'No';
  }

  function pctDelta(a, b) {
    if (!a) return null;
    return (b - a) / Math.abs(a);
  }

  // ============================================================
  // TERM SHEET SCHEMA
  // ============================================================

  /**
   * Normalize a raw term sheet object into a canonical form.
   * All monetary fields are numbers; missing optional fields are null.
   */
  function normalizeTermSheet(raw) {
    return {
      dealName:               raw.dealName              || 'Unnamed Deal',
      roundName:              raw.roundName             || '',
      source:                 raw.source                || 'unknown',
      date:                   raw.date                  || null,

      // Core economics
      preMoneyValuation:      toNum(raw.preMoneyValuation),
      postMoneyValuation:     toNum(raw.postMoneyValuation),
      investmentAmount:       toNum(raw.investmentAmount),
      targetOptionPool:           toNum(raw.targetOptionPool),
      optionPoolMethod:           raw.optionPoolMethod      || null,
      // true when the TS says "X% unallocated" (exclusive of grants); false/null = total pool
      targetOptionPoolIsUnallocated: raw._optionPoolIsUnallocated || false,

      // Preferred stock terms
      liquidationMultiple:    toNum(raw.liquidationMultiple) ?? 1,
      participating:          raw.participating         != null ? Boolean(raw.participating) : null,
      participationCap:       raw.participationCap      != null ? toNum(raw.participationCap) : null,
      dividendRate:           toNum(raw.dividendRate),
      antiDilution:           raw.antiDilution          || null,

      // Ownership targets
      investorOwnershipTarget: toNum(raw.investorOwnershipTarget),
      founderOwnershipFloor:   toNum(raw.founderOwnershipFloor),

      // Explicitly stated PPS (if term sheet specifies it)
      statedPPS:              toNum(raw.statedPPS),

      // Conversion instruments referenced in the term sheet
      safeConversions:        raw.safeConversions  || [],
      noteConversions:        raw.noteConversions  || [],
    };
  }

  // ============================================================
  // CONFORMANCE CHECKING
  // ============================================================

  /**
   * Compare a built pro forma result against a negotiated term sheet.
   *
   * @param {Object} proFormaResult   return value of ProFormaEngine.buildProForma()
   * @param {Object} termSheet        raw or already-normalized term sheet object
   * @returns {ConformanceReport}
   */
  function checkConformance(proFormaResult, termSheet) {
    const ts = normalizeTermSheet(termSheet);
    const pf = proFormaResult;
    const rc = pf.roundConfig || {};
    const checks = [];

    // Helper to push a numeric check
    function numCheck(field, label, expected, actual, severity, fmt, tol) {
      if (expected == null || actual == null) return;
      const delta    = actual - expected;
      const relDelta = pctDelta(expected, actual);
      const absTol   = tol != null ? tol : Math.abs(expected) * VALUATION_TOL;
      const pass     = Math.abs(delta) <= absTol;
      checks.push({
        field, label, expected, actual, delta, pctDelta: relDelta, pass, severity,
        expectedFmt: fmt(expected), actualFmt: fmt(actual),
        note: pass ? null : `off by ${fmt(Math.abs(delta))} (${relDelta != null ? ((relDelta * 100).toFixed(2) + '%') : 'N/A'})`,
      });
    }

    // Helper to push a categorical check
    function catCheck(field, label, expected, actual, severity, fmt) {
      if (expected == null) return;
      const pass = expected === actual;
      checks.push({
        field, label, expected, actual, delta: null, pctDelta: null, pass, severity,
        expectedFmt: fmt ? fmt(expected) : String(expected),
        actualFmt:   fmt ? fmt(actual)   : String(actual),
        note: pass ? null : `expected "${expected}", got "${actual}"`,
      });
    }

    // 1. Pre-money valuation
    // If TS states pre-money explicitly → error.
    // If TS states only post-money + investment → derive and check as warning.
    {
      const impliedPre = (ts.postMoneyValuation != null && ts.investmentAmount != null)
        ? ts.postMoneyValuation - ts.investmentAmount : null;
      const expectedPre = ts.preMoneyValuation ?? impliedPre;
      if (expectedPre != null) {
        numCheck('preMoneyValuation', 'Pre-money valuation',
          expectedPre, pf.preMoneyValuation,
          ts.preMoneyValuation != null ? 'error' : 'warning', fmtCurrency);
      }
    }

    // 2. New investment
    numCheck('investmentAmount', 'New investment',
      ts.investmentAmount, pf.newInvestment, 'error', fmtCurrency);

    // 3. Post-money valuation
    // If TS states post-money explicitly → error.
    // If TS states only pre-money + investment → derive and check as warning.
    {
      const impliedPost = (ts.preMoneyValuation != null && ts.investmentAmount != null)
        ? ts.preMoneyValuation + ts.investmentAmount : null;
      const expectedPost = ts.postMoneyValuation ?? impliedPost;
      if (expectedPost != null) {
        numCheck('postMoneyValuation', 'Post-money valuation',
          expectedPost, pf.postMoneyValuation,
          ts.postMoneyValuation != null ? 'error' : 'warning', fmtCurrency);
      }
    }

    // 4. Stated PPS (if the term sheet explicitly specifies it)
    if (ts.statedPPS) {
      numCheck('pps', 'Price per share',
        ts.statedPPS, pf.pps, 'error', fmtPPS, PPS_TOL_ABS);
    }

    // 5. Option pool target %
    // Always prefer actualUnallocatedOptionPoolPct when available — term sheets virtually
    // always specify UNALLOCATED pool (exclusive of granted/promised shares).  The value is
    // read directly from the spreadsheet's post-closing "Available EIP Shares %" column and
    // is therefore independent of any engine recomputation.  Only fall back to the total-pool
    // figure when the unallocated value was not extracted.
    if (ts.targetOptionPool) {
      const hasUnalloc = pf.actualUnallocatedOptionPoolPct != null;
      const actualPool = hasUnalloc
        ? pf.actualUnallocatedOptionPoolPct
        : pf.actualOptionPoolPct;
      const poolLabel  = hasUnalloc
        ? 'Option pool target (unallocated)'
        : 'Option pool target';
      numCheck('optionPool', poolLabel,
        ts.targetOptionPool, actualPool, 'warning', fmtPct, POOL_TOL);
    }

    // 6. Option pool method
    if (ts.optionPoolMethod) {
      catCheck('optionPoolMethod', 'Option pool method',
        ts.optionPoolMethod, rc.optionPoolMethod, 'error');
    }

    // 7. Liquidation multiple
    if (ts.liquidationMultiple != null) {
      numCheck('liquidationMultiple', 'Liquidation multiple',
        ts.liquidationMultiple, toNum(rc.liquidationMultiple) ?? 1, 'error', fmtMultiple, 0.001);
    }

    // 8. Participating preferred
    if (ts.participating != null) {
      catCheck('participating', 'Participating preferred',
        ts.participating, Boolean(rc.participating), 'error', fmtBool);
    }

    // 9. Participation cap (only meaningful when participating)
    if (ts.participating && ts.participationCap != null) {
      const actualCap = rc.participationCap != null ? toNum(rc.participationCap) : null;
      if (ts.participationCap === null) {
        catCheck('participationCap', 'Participation cap (uncapped)',
          'uncapped', actualCap == null ? 'uncapped' : fmtMultiple(actualCap), 'warning');
      } else {
        numCheck('participationCap', 'Participation cap',
          ts.participationCap, actualCap, 'warning', fmtMultiple, 0.001);
      }
    }

    // 10. Investor ownership target
    if (ts.investorOwnershipTarget) {
      let actualOwnership = null;
      if (pf._investorOwnershipPct != null) {
        actualOwnership = pf._investorOwnershipPct;
      } else if (pf.ownershipTable) {
        const investorName = rc.newInvestorName || '';
        const investorRows = pf.ownershipTable.filter(r => r.name === investorName);
        actualOwnership = investorRows.reduce((s, r) => s + r.pct, 0);
      } else if (pf.newInvestorShares && pf.postFD) {
        actualOwnership = pf.newInvestorShares / pf.postFD;
      }
      if (actualOwnership != null) {
        numCheck('investorOwnership', 'Investor ownership',
          ts.investorOwnershipTarget, actualOwnership, 'warning', fmtPct, PCT_TOL);
      }
    }

    // 11. Founder ownership floor
    if (ts.founderOwnershipFloor && pf.ownershipTable) {
      const founderRows = pf.ownershipTable.filter(r => r.type === 'common');
      const totalFounder = founderRows.reduce((s, r) => s + r.pct, 0);
      const pass = totalFounder >= ts.founderOwnershipFloor - PCT_TOL;
      checks.push({
        field: 'founderOwnership', label: 'Founder ownership floor',
        expected: ts.founderOwnershipFloor, actual: totalFounder,
        delta: totalFounder - ts.founderOwnershipFloor,
        pctDelta: pctDelta(ts.founderOwnershipFloor, totalFounder),
        pass, severity: 'warning',
        expectedFmt: '>= ' + fmtPct(ts.founderOwnershipFloor),
        actualFmt:   fmtPct(totalFounder),
        note: pass ? null : `founders at ${fmtPct(totalFounder)}, below floor ${fmtPct(ts.founderOwnershipFloor)}`,
      });
    }

    // 12. SAFE conversion terms
    const convertedIdx = indexBy(pf.convertedInstruments || [], 'name');
    for (const safe of ts.safeConversions) {
      const ci = convertedIdx[safe.holderName];
      if (!ci) {
        checks.push({
          field: `safe_missing_${safe.holderName}`,
          label: `SAFE present: ${safe.holderName}`,
          expected: 'converted', actual: 'not found',
          delta: null, pctDelta: null, pass: false, severity: 'error',
          expectedFmt: 'converted', actualFmt: 'not found',
          note: 'SAFE listed in term sheet but not found in pro forma',
        });
        continue;
      }
      if (safe.valuationCap != null) {
        numCheck(`safe_cap_${safe.holderName}`, `SAFE cap: ${safe.holderName}`,
          safe.valuationCap, ci.valuationCap, 'error', fmtCurrency, 1);
      }
      if (safe.discountRate != null) {
        numCheck(`safe_discount_${safe.holderName}`, `SAFE discount: ${safe.holderName}`,
          safe.discountRate, ci.discountRate, 'error',
          v => v != null ? ((1 - v) * 100).toFixed(0) + '% discount' : 'none', 0.001);
      }
    }

    // 13. Note conversion terms
    for (const note of ts.noteConversions) {
      const ci = convertedIdx[note.holderName];
      if (!ci) {
        checks.push({
          field: `note_missing_${note.holderName}`,
          label: `Note present: ${note.holderName}`,
          expected: 'converted', actual: 'not found',
          delta: null, pctDelta: null, pass: false, severity: 'error',
          expectedFmt: 'converted', actualFmt: 'not found',
          note: 'Note listed in term sheet but not found in pro forma',
        });
        continue;
      }
      if (note.interestRate != null) {
        numCheck(`note_rate_${note.holderName}`, `Note interest rate: ${note.holderName}`,
          note.interestRate, ci.interestRate, 'warning',
          v => (v * 100).toFixed(1) + '%', 0.0001);
      }
    }

    const passed           = checks.filter(c => c.pass);
    const failed           = checks.filter(c => !c.pass);
    const criticalFailures = failed.filter(c => c.severity === 'error');
    const warningFailures  = failed.filter(c => c.severity === 'warning');

    return {
      dealName: ts.dealName,
      termSheet: ts,
      checks,
      passed,
      failed,
      criticalFailures,
      warningFailures,
      score:      checks.length > 0 ? passed.length / checks.length : 1,
      conformant: criticalFailures.length === 0,
    };
  }

  // ============================================================
  // VERSION DIFF
  // ============================================================

  /**
   * Compute a structured diff between two pro forma results.
   * Attach .meta = { name, version, date, source } to each result for labeling.
   *
   * @param {Object} vA   earlier pro forma result
   * @param {Object} vB   later pro forma result
   * @returns {DiffReport}
   */
  function diffProFormas(vA, vB) {
    const metaA = vA.meta || { name: 'Version A' };
    const metaB = vB.meta || { name: 'Version B' };

    const diff = {
      labelA:    `${metaA.name || ''} ${metaA.version || ''}`.trim(),
      labelB:    `${metaB.name || ''} ${metaB.version || ''}`.trim(),
      economics: [],
      ownership: [],
      issues:    { resolved: [], introduced: [], persistent: [] },
      warnings:  { resolved: [], introduced: [], persistent: [] },
      conversions: [],
    };

    // ── Economics ─────────────────────────────────────────────
    const econFields = [
      { key: 'pps',                label: 'Price per share',          fmt: fmtPPS,      highlight: 'pps'  },
      { key: 'preMoneyValuation',  label: 'Pre-money valuation',      fmt: fmtCurrency                    },
      { key: 'postMoneyValuation', label: 'Post-money valuation',     fmt: fmtCurrency                    },
      { key: 'newInvestment',      label: 'New investment',           fmt: fmtCurrency                    },
      { key: 'premoneyFD',         label: 'Pre-money FD shares',      fmt: fmtShares                      },
      { key: 'postFD',             label: 'Post-money FD shares',     fmt: fmtShares                      },
      { key: 'newInvestorShares',  label: 'New investor shares',      fmt: fmtShares                      },
      { key: 'optionExpansion',    label: 'Option pool expansion',    fmt: fmtShares,   highlight: 'pool' },
      { key: 'actualOptionPoolPct',label: 'Option pool %',            fmt: fmtPct,      highlight: 'pool' },
    ];

    for (const ef of econFields) {
      const a = vA[ef.key], b = vB[ef.key];
      if (a == null && b == null) continue;
      const delta     = (b ?? 0) - (a ?? 0);
      const relDelta  = pctDelta(a, b);
      const changed   = Math.abs(delta) > (a ? Math.abs(a) * 0.00005 : 0.00001);
      if (changed) {
        diff.economics.push({ ...ef, a, b, delta, pctDelta: relDelta, aFmt: ef.fmt(a), bFmt: ef.fmt(b) });
      }
    }

    // ── Ownership ─────────────────────────────────────────────
    const owA = indexBy(vA.ownershipTable || [], 'name');
    const owB = indexBy(vB.ownershipTable || [], 'name');
    const allNames = new Set([...Object.keys(owA), ...Object.keys(owB)]);

    for (const name of allNames) {
      const rA = owA[name], rB = owB[name];
      const pctA    = rA?.pct    ?? 0;
      const pctB    = rB?.pct    ?? 0;
      const sharesA = rA?.shares ?? 0;
      const sharesB = rB?.shares ?? 0;
      const dpct    = pctB - pctA;
      const changed = Math.abs(dpct) > 0.00005;

      if (changed || (!rA && rB) || (rA && !rB)) {
        diff.ownership.push({
          name,
          type:   (rB ?? rA).type,
          pctA, pctB, deltaPct: dpct,
          sharesA, sharesB, deltaShares: sharesB - sharesA,
          isNew:     !rA && !!rB,
          isRemoved: !!rA && !rB,
        });
      }
    }
    diff.ownership.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

    // ── Issues / Warnings ─────────────────────────────────────
    function diffFlags(listA, listB, bucket) {
      const cA = new Set((listA || []).map(i => i.code));
      const cB = new Set((listB || []).map(i => i.code));
      const all = new Set([...cA, ...cB]);
      for (const code of all) {
        const inA = cA.has(code), inB = cB.has(code);
        const obj = (listB || []).find(i => i.code === code) ||
                    (listA || []).find(i => i.code === code) || { code };
        if (inA && !inB)  bucket.resolved.push(obj);
        else if (!inA && inB) bucket.introduced.push(obj);
        else              bucket.persistent.push(obj);
      }
    }
    diffFlags(vA.issues,   vB.issues,   diff.issues);
    diffFlags(vA.warnings, vB.warnings, diff.warnings);

    // ── Conversion changes ────────────────────────────────────
    const ciA = indexBy(vA.convertedInstruments || [], 'name');
    const ciB = indexBy(vB.convertedInstruments || [], 'name');
    const ciNames = new Set([...Object.keys(ciA), ...Object.keys(ciB)]);

    for (const name of ciNames) {
      const ca = ciA[name], cb = ciB[name];
      if (!ca || !cb) continue;
      const sharesDiff = Math.abs(ca.shares - cb.shares);
      const ppsDiff    = Math.abs(ca.conversionPPS - cb.conversionPPS);
      if (sharesDiff > 0.5 || ppsDiff > 0.0001) {
        diff.conversions.push({
          name,
          sharesA: ca.shares,     sharesB: cb.shares,
          ppsA:    ca.conversionPPS, ppsB: cb.conversionPPS,
          basisA:  ca.conversionBasis, basisB: cb.conversionBasis,
          deltaShares: cb.shares - ca.shares,
          deltaPPS:    cb.conversionPPS - ca.conversionPPS,
        });
      }
    }

    return diff;
  }

  // ============================================================
  // IN-MEMORY DOCUMENT DATABASE
  // ============================================================

  /**
   * Create a new document database.
   * Stores pro formas and term sheets; supports versioning and querying.
   *
   * Usage:
   *   const db = ProFormaComparator.createDatabase();
   *   db.add('proforma',  'Acme Series A', 'v1', proFormaResult, { date, source });
   *   db.add('termsheet', 'Acme Series A', 'signed', termSheetObj, { date });
   *   const all = db.list({ type: 'proforma' });
   *   const versions = db.getVersions('Acme Series A');
   */
  function createDatabase() {
    const records = [];
    let nextId = 1;

    function add(type, name, version, data, meta) {
      const record = {
        id:      nextId++,
        type,             // 'proforma' | 'termsheet'
        name,
        version,
        date:    meta?.date   || new Date().toISOString().slice(0, 10),
        source:  meta?.source || 'unknown',
        tags:    meta?.tags   || [],
        data,
      };
      records.push(record);
      return record;
    }

    function list(filter) {
      if (!filter) return [...records];
      return records.filter(r => {
        if (filter.type && r.type !== filter.type) return false;
        if (filter.name && r.name !== filter.name) return false;
        if (filter.source && r.source !== filter.source) return false;
        if (filter.tags) {
          const ft = Array.isArray(filter.tags) ? filter.tags : [filter.tags];
          if (!ft.every(t => r.tags.includes(t))) return false;
        }
        return true;
      });
    }

    function get(id) {
      return records.find(r => r.id === id) || null;
    }

    function getVersions(name) {
      return records
        .filter(r => r.name === name)
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    /**
     * Run checkConformance for every pro forma against matching term sheet(s).
     * Returns an array of { proFormaRecord, termSheetRecord, conformance }.
     */
    function auditAll() {
      const results = [];
      const proFormas  = list({ type: 'proforma' });
      const termSheets = list({ type: 'termsheet' });
      for (const pf of proFormas) {
        const matchingTS = termSheets.filter(ts => ts.name === pf.name);
        for (const ts of matchingTS) {
          results.push({
            proFormaRecord:  pf,
            termSheetRecord: ts,
            conformance:     checkConformance(pf.data, ts.data),
          });
        }
      }
      return results;
    }

    /**
     * Run diffProFormas for consecutive versions of each named deal.
     * Returns an array of { name, from, to, diff }.
     */
    function diffAll() {
      const results = [];
      const names   = [...new Set(records.filter(r => r.type === 'proforma').map(r => r.name))];
      for (const name of names) {
        const versions = getVersions(name).filter(r => r.type === 'proforma');
        for (let i = 0; i < versions.length - 1; i++) {
          results.push({
            name,
            from: versions[i].version,
            to:   versions[i + 1].version,
            diff: diffProFormas(versions[i].data, versions[i + 1].data),
          });
        }
      }
      return results;
    }

    function toJSON() {
      return JSON.stringify({ records, nextId }, null, 2);
    }

    function fromJSON(json) {
      const parsed = JSON.parse(json);
      records.length = 0;
      records.push(...parsed.records);
      nextId = parsed.nextId;
    }

    return { add, list, get, getVersions, auditAll, diffAll, toJSON, fromJSON,
      get size() { return records.length; } };
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    checkConformance,
    diffProFormas,
    normalizeTermSheet,
    createDatabase,
    // Formatters (exposed for CLI use)
    fmt: { currency: fmtCurrency, pps: fmtPPS, pct: fmtPct, shares: fmtShares, multiple: fmtMultiple },
  };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProFormaComparator;
}
