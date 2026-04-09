'use strict';
/**
 * proforma-excel-compare.js
 *
 * Semantic Excel comparator for NVCA-style pro forma workbooks.
 *
 * Three main jobs:
 *   1. parseWorkbook(wb)              → structured representation keyed by row label & col header
 *   2. compareWorkbooks(precWb, bldWb) → multi-level diff (sheet → row → cell)
 *   3. generatePatches(diff, src)      → search-replace patches for proforma.html
 *   4. applyPatches(src, patches)      → apply high-confidence patches, return modified source
 *
 * Works in Node.js. The XLSX module must be passed in (so the caller controls the version).
 */

// ─────────────────────────────────────────────────────────────────────────────
// PARSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * parseWorkbook — turn a raw xlsx workbook object into a comparable structure.
 *
 * @param {object} wb   - xlsx workbook (from XLSX.read / XLSX.readFile)
 * @param {object} XLSX - the xlsx module (passed in so caller controls version)
 * @returns {ParsedWorkbook}
 */
function parseWorkbook(wb, XLSX) {
  const sheets = {};
  for (const name of wb.SheetNames) {
    sheets[name] = parseSheet(wb.Sheets[name], name, XLSX);
  }
  return { sheetNames: wb.SheetNames, sheets };
}

/**
 * parseSheet — extract semantic rows from one worksheet.
 *
 * Strategy:
 *   • The first N rows that contain no "large integer" numeric cells are treated
 *     as header rows (NVCA sheets typically have 2-3 header rows).
 *   • Column identities are the concatenation of header-row values (lower-cased).
 *   • Data rows are indexed both by array position and by their label
 *     (first non-empty cell in the leftmost column).
 *   • Each cell captures: value (v), formula (f), type (t), number format (z).
 */
function parseSheet(ws, name, XLSX) {
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!range) return { name, colHeaders: [], rows: [], rowMap: {} };

  const rMin = range.s.r, rMax = range.e.r;
  const cMin = range.s.c, cMax = range.e.c;
  const numCols = cMax - cMin + 1;

  // ── raw cell matrix ──────────────────────────────────────────────
  const matrix = [];
  for (let r = rMin; r <= rMax; r++) {
    const row = [];
    for (let c = cMin; c <= cMax; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      row.push(ws[addr] || null);
    }
    matrix.push(row);
  }

  // ── detect header rows ──────────────────────────────────────────
  // A row is a header row if it has NO cell with a "large" integer value
  // (share counts are typically > 1000; we use > 500 as the threshold).
  let dataStart = 0;
  for (let r = 0; r < Math.min(matrix.length, 5); r++) {
    const hasLargeNum = matrix[r].some(cell =>
      cell && cell.t === 'n' && Math.abs(Number(cell.v)) > 500
    );
    if (hasLargeNum) { dataStart = r; break; }
    dataStart = r + 1;
  }
  dataStart = Math.min(dataStart, 4); // never skip more than 4 header rows

  // ── build column headers ─────────────────────────────────────────
  // Concatenate the text from each header row per column.
  const colHeaders = [];
  for (let c = 0; c < numCols; c++) {
    const parts = [];
    for (let r = 0; r < dataStart; r++) {
      const cell = matrix[r][c];
      if (cell && cell.v != null) {
        const s = String(cell.v).trim();
        if (s) parts.push(s);
      }
    }
    colHeaders.push(parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim());
  }

  // ── parse data rows ───────────────────────────────────────────────
  const rows = [];
  const rowMap = {}; // normalised label → row object

  for (let r = dataStart; r < matrix.length; r++) {
    const matRow = matrix[r];

    // Label = value of the first non-empty cell
    let label = '';
    let labelCol = 0;
    for (let c = 0; c < matRow.length; c++) {
      const cell = matRow[c];
      if (cell && cell.v != null) {
        const s = String(cell.v).trim();
        if (s) { label = s; labelCol = c; break; }
      }
    }
    if (!label) continue;

    // Cells keyed by column index (relative to cMin)
    const cells = {};
    for (let c = 0; c < matRow.length; c++) {
      const cell = matRow[c];
      if (!cell || cell.v == null) continue;
      cells[c] = {
        v: cell.v,
        f: cell.f || null,
        t: cell.t || 'n',
        z: cell.z || null,
      };
    }

    const rowObj = { label, labelCol, cells, rawIndex: r + rMin };
    rows.push(rowObj);

    // Allow multiple rows with the same label by appending '_N'
    const key = normaliseLabel(label);
    if (rowMap[key]) {
      let i = 2;
      while (rowMap[`${key}_${i}`]) i++;
      rowMap[`${key}_${i}`] = rowObj;
    } else {
      rowMap[key] = rowObj;
    }
  }

  return { name, colHeaders, rows, rowMap, dataStart };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * compareWorkbooks — compare a precedent workbook against a builder workbook.
 *
 * Returns a ComparisonResult with:
 *   sheetComparisons[]   per-sheet diff objects
 *   missingInBuilder[]   sheet names present in precedent but not builder
 *   extraInBuilder[]     sheet names present in builder but not precedent
 *   summary              aggregate counts
 */
function compareWorkbooks(precParsed, bldParsed) {
  const result = {
    sheetComparisons: [],
    missingInBuilder: [],
    extraInBuilder: [],
    summary: { totalCells: 0, matching: 0, diffs: 0, missingRows: 0, extraRows: 0 },
  };

  const bldSet = new Set(bldParsed.sheetNames);
  const precSet = new Set(precParsed.sheetNames);

  for (const name of precParsed.sheetNames) {
    // Find the builder counterpart — exact name first, then fuzzy
    let bldName = null;
    if (bldSet.has(name)) {
      bldName = name;
    } else {
      bldName = bldParsed.sheetNames.find(n =>
        n.toLowerCase() === name.toLowerCase() ||
        n.toLowerCase().includes(name.toLowerCase().split(' ')[0]) ||
        name.toLowerCase().includes(n.toLowerCase().split(' ')[0])
      ) || null;
      if (!bldName) result.missingInBuilder.push(name);
    }

    const precSheet = precParsed.sheets[name];
    const bldSheet  = bldName ? bldParsed.sheets[bldName] : null;

    const sc = bldSheet
      ? compareSheets(precSheet, bldSheet, bldName !== name)
      : { precedentName: name, builderName: null, missingRows: precSheet.rows.map(r => ({ label: r.label })), extraRows: [], cellDiffs: [], styleDiffs: [], totalCells: 0, matching: 0, diffs: 0 };

    result.sheetComparisons.push(sc);

    result.summary.totalCells  += sc.totalCells;
    result.summary.matching    += sc.matching;
    result.summary.diffs       += sc.diffs;
    result.summary.missingRows += sc.missingRows.length;
    result.summary.extraRows   += sc.extraRows.length;
  }

  for (const name of bldParsed.sheetNames) {
    if (!precSet.has(name)) result.extraInBuilder.push(name);
  }

  return result;
}

/**
 * compareSheets — semantic row-by-row, column-by-column diff.
 */
function compareSheets(precSheet, bldSheet, nameMismatch) {
  const diff = {
    precedentName: precSheet.name,
    builderName:   bldSheet.name,
    nameMismatch:  !!nameMismatch,
    missingRows:   [],
    extraRows:     [],
    cellDiffs:     [],
    styleDiffs:    [],
    totalCells:    0,
    matching:      0,
    diffs:         0,
  };

  // Build column header map for the builder sheet
  // We want to match precedent column c_p to builder column c_b by header string.
  const bldColMap = buildColMap(bldSheet.colHeaders);   // header → col index
  const precColMap = buildColMap(precSheet.colHeaders);

  // Build a lookup of builder rows
  const bldRowLookup = new Map(
    bldSheet.rows.map(r => [normaliseLabel(r.label), r])
  );

  // ── compare each precedent row ────────────────────────────────────
  for (const precRow of precSheet.rows) {
    const key = normaliseLabel(precRow.label);
    const bldRow = bldRowLookup.get(key);

    if (!bldRow) {
      diff.missingRows.push({
        label:    precRow.label,
        rowIndex: precRow.rawIndex,
        cells:    Object.fromEntries(
          Object.entries(precRow.cells).map(([c, cell]) => [
            precSheet.colHeaders[+c] || `col_${c}`, cell.v
          ])
        ),
      });
      continue;
    }

    // Compare cells column-by-column using header matching
    for (const [cStr, precCell] of Object.entries(precRow.cells)) {
      const cP = +cStr;
      const hdr = precSheet.colHeaders[cP] || '';
      if (!hdr || hdr === normaliseLabel(precRow.label)) continue; // skip label col

      // Find matching builder column
      const cB = matchCol(hdr, bldColMap, cP);
      const bldCell = cB !== null ? bldRow.cells[cB] : null;

      diff.totalCells++;

      const cellDiff = compareCells(precCell, bldCell, precRow.label, hdr);
      if (!cellDiff) {
        diff.matching++;
      } else {
        diff.diffs++;
        if (cellDiff.isStyleOnly) diff.styleDiffs.push(cellDiff);
        else diff.cellDiffs.push(cellDiff);
      }
    }
  }

  // ── find extra builder rows ───────────────────────────────────────
  const precRowKeys = new Set(precSheet.rows.map(r => normaliseLabel(r.label)));
  for (const bldRow of bldSheet.rows) {
    if (!precRowKeys.has(normaliseLabel(bldRow.label))) {
      diff.extraRows.push({ label: bldRow.label, rowIndex: bldRow.rawIndex });
    }
  }

  return diff;
}

/**
 * compareCells — produce a CellDiff or null (no diff).
 */
function compareCells(precCell, bldCell, rowLabel, colHeader) {
  if (!precCell) return null;

  const diffs = [];

  if (!bldCell) {
    diffs.push({ kind: 'missing', precedentValue: precCell.v, precedentFormula: precCell.f });
  } else {
    // ── value ────────────────────────────────────────────────────────
    if (precCell.t === 'n' && bldCell.t === 'n') {
      const pv = Number(precCell.v);
      const bv = Number(bldCell.v);
      if (!isNaN(pv) && !isNaN(bv) && Math.abs(pv - bv) > 0.005) {
        diffs.push({
          kind:           'value',
          precedentValue: pv,
          builderValue:   bv,
          delta:          bv - pv,
          deltaPct:       pv !== 0 ? ((bv - pv) / Math.abs(pv)) * 100 : null,
        });
      }
    } else if (precCell.t === 's' || bldCell.t === 's') {
      const pv = String(precCell.v ?? '').trim();
      const bv = String(bldCell.v ?? '').trim();
      if (pv !== bv) diffs.push({ kind: 'text', precedentValue: pv, builderValue: bv });
    }

    // ── formula ──────────────────────────────────────────────────────
    if (precCell.f && !bldCell.f) {
      diffs.push({ kind: 'formula_missing', precedentFormula: precCell.f, builderValue: bldCell.v });
    } else if (!precCell.f && bldCell.f) {
      diffs.push({ kind: 'formula_unexpected', builderFormula: bldCell.f, precedentValue: precCell.v });
    } else if (precCell.f && bldCell.f && normaliseFormula(precCell.f) !== normaliseFormula(bldCell.f)) {
      diffs.push({ kind: 'formula', precedentFormula: precCell.f, builderFormula: bldCell.f });
    }

    // ── number format ────────────────────────────────────────────────
    if (precCell.z && bldCell.z && precCell.z !== bldCell.z) {
      diffs.push({ kind: 'format', precedentFormat: precCell.z, builderFormat: bldCell.z });
    }
  }

  if (diffs.length === 0) return null;

  const isStyleOnly = diffs.every(d => d.kind === 'format');
  return { rowLabel, colHeader, diffs, isStyleOnly, severity: diffs.some(d => d.kind === 'value' || d.kind === 'missing') ? 'high' : diffs.some(d => d.kind === 'formula') ? 'medium' : 'low' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generatePatches — map diff entries to proforma.html code changes.
 *
 * Two patch types:
 *   'search_replace' — a literal string find-and-replace (high/medium confidence)
 *   'manual'         — a human-readable recommendation (low confidence / structural)
 *
 * Patches are sorted high-confidence first.
 */
function generatePatches(diff, builderSrc) {
  const patches = [];

  for (const sc of diff.sheetComparisons) {
    // ── number-format patches (search_replace) ─────────────────────────
    const fmtPatches = deriveFormatPatches(sc, builderSrc);
    patches.push(...fmtPatches);

    // ── missing-row patches (manual guidance) ─────────────────────────
    for (const mr of sc.missingRows) {
      patches.push({
        type:        'manual',
        confidence:  'low',
        severity:    'medium',
        sheetName:   sc.precedentName,
        description: `Add missing row "${mr.label}" to ${sc.precedentName} sheet`,
        guidance:
          `In _build${builderFnName(sc.precedentName)}() in proforma.html, ` +
          `add a new row labelled "${mr.label}". ` +
          `Precedent values: ${JSON.stringify(mr.cells)}`,
      });
    }

    // ── formula-missing patches (manual guidance) ──────────────────────
    for (const cd of sc.cellDiffs) {
      for (const d of cd.diffs) {
        if (d.kind === 'formula_missing') {
          patches.push({
            type:        'manual',
            confidence:  'low',
            severity:    'medium',
            sheetName:   sc.precedentName,
            description: `Row "${cd.rowLabel}" / col "${cd.colHeader}": precedent uses formula "${d.precedentFormula}"`,
            guidance:
              `Find the sc() call that writes row "${cd.rowLabel}" in ` +
              `_build${builderFnName(sc.precedentName)}() and replace the num() cell ` +
              `with fml("${d.precedentFormula}", value, fmt).`,
          });
        }

        if (d.kind === 'formula') {
          patches.push({
            type:        'manual',
            confidence:  'low',
            severity:    'low',
            sheetName:   sc.precedentName,
            description: `Row "${cd.rowLabel}" / col "${cd.colHeader}": formula mismatch`,
            guidance:
              `Precedent formula: "${d.precedentFormula}". ` +
              `Builder formula:   "${d.builderFormula}". ` +
              `Update the fml() call in _build${builderFnName(sc.precedentName)}().`,
          });
        }

        if (d.kind === 'value' && Math.abs(d.delta) > 1) {
          patches.push({
            type:        'manual',
            confidence:  'low',
            severity:    'high',
            sheetName:   sc.precedentName,
            description:
              `Row "${cd.rowLabel}" / col "${cd.colHeader}": value differs ` +
              `(precedent=${fmt(d.precedentValue)}, builder=${fmt(d.builderValue)}, Δ=${fmt(d.delta)})`,
            guidance:
              `Check whether this is a deal-parameter difference (term sheet → engine) ` +
              `or a builder bug. If a bug, trace the sc() call in ` +
              `_build${builderFnName(sc.precedentName)}().`,
          });
        }
      }
    }
  }

  // Sort: high-confidence search_replace first, then by severity
  const sevOrder = { high: 0, medium: 1, low: 2 };
  const confOrder = { high: 0, medium: 1, low: 2 };
  patches.sort((a, b) =>
    confOrder[a.confidence] - confOrder[b.confidence] ||
    sevOrder[a.severity]   - sevOrder[b.severity]
  );

  return patches;
}

/**
 * deriveFormatPatches — find number-format mismatches and generate search_replace patches.
 * Only patches that the search string appears in builderSrc are included.
 */
function deriveFormatPatches(sheetDiff, src) {
  const patches = [];
  const seen = new Set();

  const allDiffs = [...sheetDiff.cellDiffs, ...sheetDiff.styleDiffs];
  for (const cd of allDiffs) {
    for (const d of cd.diffs) {
      if (d.kind !== 'format') continue;
      const key = `${d.builderFormat}→${d.precedentFormat}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (src.includes(d.builderFormat)) {
        patches.push({
          type:        'search_replace',
          confidence:  'medium',
          severity:    'low',
          sheetName:   sheetDiff.precedentName,
          description: `Number format "${d.builderFormat}" → "${d.precedentFormat}" in ${sheetDiff.precedentName}`,
          search:      d.builderFormat,
          replace:     d.precedentFormat,
        });
      }
    }
  }

  return patches;
}

// ─────────────────────────────────────────────────────────────────────────────
// APPLY PATCHES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyPatches — apply search_replace patches to the builder source.
 * Manual patches are skipped (returned in `skipped`).
 */
function applyPatches(src, patches) {
  let result = src;
  const applied = [];
  const skipped = [];

  for (const p of patches) {
    if (p.type !== 'search_replace') {
      skipped.push({ patch: p, reason: 'manual — needs human review' });
      continue;
    }
    if (!result.includes(p.search)) {
      skipped.push({ patch: p, reason: `search string not found in source` });
      continue;
    }
    result = result.split(p.search).join(p.replace);
    applied.push(p);
  }

  return { src: result, applied, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normaliseLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normaliseFormula(f) {
  return String(f || '').replace(/\s+/g, '').toUpperCase();
}

function buildColMap(colHeaders) {
  const m = new Map();
  colHeaders.forEach((h, i) => { if (h) m.set(h, i); });
  return m;
}

/**
 * matchCol — find builder column index for a given precedent header string.
 * Falls back to the same positional index if no header match.
 */
function matchCol(hdr, bldColMap, fallback) {
  if (bldColMap.has(hdr)) return bldColMap.get(hdr);
  // Try partial match: all words of hdr appear in some builder header
  const words = hdr.split(' ').filter(w => w.length > 2);
  for (const [bh, bi] of bldColMap) {
    if (words.length > 0 && words.every(w => bh.includes(w))) return bi;
  }
  return fallback; // positional fallback
}

/** Map sheet name to the camelCase fragment used in the builder function name */
function builderFnName(sheetName) {
  return sheetName
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function fmt(n) {
  if (n == null) return 'N/A';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(3) + 'M';
  if (Math.abs(n) >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return Number(n).toFixed(4);
}

// ─────────────────────────────────────────────────────────────────────────────
// TERM-SHEET PARSING (docx / xlsx / plain text)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * parseTermSheet — extract key deal parameters from an uploaded term sheet.
 * Supports .xlsx (reads all cells as text) and .txt/.docx text blobs.
 *
 * Returns a freeform object with whatever fields can be detected:
 *   { roundName, preMoneyValuation, investmentAmount, optionPoolPct, pricePerShare, ... }
 */
function parseTermSheet(text) {
  const ts = {};
  const t = text;

  const match = (re) => { const m = t.match(re); return m ? m[1] : null; };
  const dollar = (s) => s ? parseFloat(s.replace(/[$,M\s]/g, '')) * (s.includes('M') ? 1e6 : 1) : null;
  const pct    = (s) => s ? parseFloat(s.replace(/[%\s]/g, '')) / 100 : null;

  ts.roundName          = match(/(?:series|round)[:\s]+([A-Za-z0-9\- ]+?)(?:\n|preferred|financing)/i);
  ts.preMoneyValuation  = dollar(match(/pre[\s-]*money[\s\S]{0,30}?(\$[\d,.]+M?)/i));
  ts.investmentAmount   = dollar(match(/(?:aggregate|total)?[\s\S]{0,20}investment[\s\S]{0,20}?(\$[\d,.]+M?)/i));
  ts.pricePerShare      = dollar(match(/price[\s\S]{0,30}?(\$[\d.]+)/i));
  ts.optionPoolPct      = pct(match(/option\s+pool[\s\S]{0,50}?([\d.]+)\s*%/i));
  ts.liquidationPref    = match(/liquidation\s+preference[\s\S]{0,30}?(\d+(?:\.\d+)?x)/i);
  ts.participationCap   = match(/participation[\s\S]{0,30}?(capped|uncapped|non[\s-]*participating)/i);
  ts.dividendRate       = pct(match(/dividend[\s\S]{0,30}?([\d.]+)\s*%/i));
  ts.antiDilution       = match(/anti[\s-]*dilution[\s\S]{0,50}?(broad[\s-]*base|narrow[\s-]*base|full[\s-]*ratchet|none)/i);

  // Clean up nulls
  Object.keys(ts).forEach(k => { if (ts[k] == null) delete ts[k]; });
  return ts;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { parseWorkbook, compareWorkbooks, generatePatches, applyPatches, parseTermSheet, fmt };
