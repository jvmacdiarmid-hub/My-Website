#!/usr/bin/env node
/**
 * run-compare.js — NVCA Pro Forma Comparison & Conformance CLI
 *
 * Loads uploaded pro formas and term sheets into a database, then runs:
 *   1. Version diffs   (compare drafts of the same deal)
 *   2. Conformance     (check pro forma against negotiated term sheet)
 *   3. Cross-deal      (summary table across all deals)
 *
 * Usage:
 *   node run-compare.js                  full report
 *   node run-compare.js --deal acme      filter to one deal
 *   node run-compare.js --no-color       plain text
 *   node run-compare.js --json           machine-readable output
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

globalThis.ProFormaEngine    = require('./proforma-engine.js');
const ProFormaComparator     = require('./proforma-comparator.js');
const { checkConformance, diffProFormas, createDatabase } = ProFormaComparator;
const { fmt } = ProFormaComparator;

// ─────────────────────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const NO_COLOR  = args.includes('--no-color');
const JSON_OUT  = args.includes('--json');
const dealIdx   = args.indexOf('--deal');
const DEAL_FILTER = dealIdx >= 0 ? args[dealIdx + 1]?.toLowerCase() : null;

// ─────────────────────────────────────────────────────────────────────────────
// COLOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const RAW = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',  dim:    '\x1b[2m',
  red:    '\x1b[31m', green:  '\x1b[32m', yellow: '\x1b[33m',
  blue:   '\x1b[34m', cyan:   '\x1b[36m', white:  '\x1b[37m',
};
const C = NO_COLOR
  ? Object.fromEntries(Object.keys(RAW).map(k => [k, '']))
  : RAW;

const LINE65  = '═'.repeat(65);
const LINE60  = '─'.repeat(60);

function header(text) {
  console.log(`\n${C.bold}${C.cyan}${LINE65}${C.reset}`);
  console.log(`${C.bold}${C.white}  ${text}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${LINE65}${C.reset}`);
}

function section(text) {
  console.log(`\n${C.bold}${C.blue}  ── ${text}${C.reset}`);
  console.log(`  ${C.dim}${LINE60}${C.reset}`);
}

function row(label, value, color) {
  const col = color || C.reset;
  console.log(`  ${C.dim}${label.padEnd(32)}${C.reset}${col}${value}${C.reset}`);
}

function colFor(delta, higherIsBetter) {
  if (Math.abs(delta) < 0.00001) return C.dim;
  return (delta > 0) === higherIsBetter ? C.green : C.red;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD HELPER  (calls engine + analyzer, attaches .meta)
// ─────────────────────────────────────────────────────────────────────────────

function build(preRound, roundConfig, meta) {
  const result   = ProFormaEngine.buildProForma(preRound, roundConfig);
  const analysis = ProFormaEngine.analyzeProForma(result, preRound, roundConfig);
  // Merge analyzer output on top of the build result's own issues/warnings
  result.issues   = analysis.issues   || result.issues   || [];
  result.warnings = analysis.warnings || result.warnings || [];
  result.notes    = analysis.notes    || [];
  result.meta     = meta;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
// DEAL DATA
// Three realistic deals, each with multiple pro forma versions
// and a negotiated term sheet.
// ═══════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DEAL 1 — ACME INC. SERIES A
// Key issue: option pool method dispute (company wants post-money, investor wants
// pre-money "shuffle").  Final agreed: pre-money.
// ─────────────────────────────────────────────────────────────────────────────

const acme_preRound = [
  { name: 'Alice Chen (Founder)',  type: 'common',    shares: 3_000_000 },
  { name: 'Bob Tanaka (Founder)',  type: 'common',    shares: 2_000_000 },
  { name: 'Option Pool',          type: 'option',    shares:   800_000 },
  { name: 'YC SAFE',              type: 'safe',      shares: 0, principal: 125_000,
    valuationCap: 5_000_000, discountRate: null, safeType: 'post-money' },
  { name: 'Angel SAFE',           type: 'safe',      shares: 0, principal: 500_000,
    valuationCap: 8_000_000, discountRate: 0.80, safeType: 'pre-money' },
  { name: 'Bridge Note',          type: 'note',      shares: 0, principal: 250_000,
    interestRate: 0.06, issueDate: '2023-01-15',
    valuationCap: 10_000_000, discountRate: 0.80 },
];

// v1 — Company counsel draft: post-money option pool (better for founders)
const acme_v1 = build(acme_preRound, {
  roundName: 'Series A', preMoneyValuation: 10_000_000, newInvestment: 2_000_000,
  optionPoolTargetPct: 0.15, optionPoolMethod: 'post-money',
  newShareClass: 'Series A Preferred', newInvestorName: 'Sequoia Capital',
  liquidationMultiple: 1, participating: false, participationCap: null,
  closingDate: '2024-03-01',
}, { name: 'Acme Inc. Series A', version: 'v1 (company draft)', date: '2024-01-15', source: 'company' });

// v2 — Investor counsel draft: pre-money option pool shuffle
const acme_v2 = build(acme_preRound, {
  roundName: 'Series A', preMoneyValuation: 10_000_000, newInvestment: 2_000_000,
  optionPoolTargetPct: 0.15, optionPoolMethod: 'pre-money',
  newShareClass: 'Series A Preferred', newInvestorName: 'Sequoia Capital',
  liquidationMultiple: 1, participating: false, participationCap: null,
  closingDate: '2024-03-01',
}, { name: 'Acme Inc. Series A', version: 'v2 (investor draft)', date: '2024-01-22', source: 'investor' });

// v3 — Final: investor wins on pool method; 1x non-participating agreed
const acme_v3 = build(acme_preRound, {
  roundName: 'Series A', preMoneyValuation: 10_000_000, newInvestment: 2_000_000,
  optionPoolTargetPct: 0.15, optionPoolMethod: 'pre-money',
  newShareClass: 'Series A Preferred', newInvestorName: 'Sequoia Capital',
  liquidationMultiple: 1, participating: false, participationCap: null,
  closingDate: '2024-03-01',
}, { name: 'Acme Inc. Series A', version: 'v3 (final)', date: '2024-02-01', source: 'agreed' });

const acme_termSheet = {
  dealName: 'Acme Inc. Series A', roundName: 'Series A', source: 'agreed', date: '2024-01-10',
  preMoneyValuation: 10_000_000, investmentAmount: 2_000_000,
  targetOptionPool: 0.15, optionPoolMethod: 'pre-money',
  liquidationMultiple: 1, participating: false, participationCap: null,
  antiDilution: 'broad-based-weighted-average',
  safeConversions: [
    { holderName: 'YC SAFE',    principal: 125_000, valuationCap: 5_000_000, discountRate: null },
    { holderName: 'Angel SAFE', principal: 500_000, valuationCap: 8_000_000, discountRate: 0.80 },
  ],
  noteConversions: [
    { holderName: 'Bridge Note', principal: 250_000, interestRate: 0.06,
      valuationCap: 10_000_000, discountRate: 0.80 },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// DEAL 2 — BETA CO. SERIES A
// Key issue: participating preferred in v1; term sheet requires non-participating.
// Also: option pool target increases from 12% → 15% between drafts.
// ─────────────────────────────────────────────────────────────────────────────

const beta_preRound = [
  { name: 'Maria Santos (Founder)', type: 'common', shares: 4_000_000 },
  { name: 'James Liu (Founder)',    type: 'common', shares: 3_000_000 },
  { name: 'Option Pool',           type: 'option', shares: 1_000_000 },
  { name: 'Seed SAFE',             type: 'safe', shares: 0, principal: 750_000,
    valuationCap: 6_000_000, discountRate: null, safeType: 'pre-money' },
];

// v1 — participating preferred, 12% pool (both wrong per term sheet)
const beta_v1 = build(beta_preRound, {
  roundName: 'Series A', preMoneyValuation: 15_000_000, newInvestment: 3_000_000,
  optionPoolTargetPct: 0.12, optionPoolMethod: 'pre-money',
  newShareClass: 'Series A Preferred', newInvestorName: 'Accel Partners',
  liquidationMultiple: 1, participating: true, participationCap: 3,
  closingDate: '2024-04-01',
}, { name: 'Beta Co. Series A', version: 'v1 (initial draft)', date: '2024-03-01', source: 'company' });

// v2 — non-participating (fixed), pool still at 12%
const beta_v2 = build(beta_preRound, {
  roundName: 'Series A', preMoneyValuation: 15_000_000, newInvestment: 3_000_000,
  optionPoolTargetPct: 0.12, optionPoolMethod: 'pre-money',
  newShareClass: 'Series A Preferred', newInvestorName: 'Accel Partners',
  liquidationMultiple: 1, participating: false, participationCap: null,
  closingDate: '2024-04-01',
}, { name: 'Beta Co. Series A', version: 'v2 (non-participating fix)', date: '2024-03-15', source: 'negotiated' });

// v3 — final: 15% pool per term sheet
const beta_v3 = build(beta_preRound, {
  roundName: 'Series A', preMoneyValuation: 15_000_000, newInvestment: 3_000_000,
  optionPoolTargetPct: 0.15, optionPoolMethod: 'pre-money',
  newShareClass: 'Series A Preferred', newInvestorName: 'Accel Partners',
  liquidationMultiple: 1, participating: false, participationCap: null,
  closingDate: '2024-04-01',
}, { name: 'Beta Co. Series A', version: 'v3 (final)', date: '2024-04-01', source: 'agreed' });

const beta_termSheet = {
  dealName: 'Beta Co. Series A', roundName: 'Series A', source: 'agreed', date: '2024-02-15',
  preMoneyValuation: 15_000_000, investmentAmount: 3_000_000,
  targetOptionPool: 0.15, optionPoolMethod: 'pre-money',
  liquidationMultiple: 1, participating: false, participationCap: null,
  antiDilution: 'broad-based-weighted-average',
  safeConversions: [
    { holderName: 'Seed SAFE', principal: 750_000, valuationCap: 6_000_000, discountRate: null },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// DEAL 3 — GAMMA HEALTH SEED ROUND
// Key issue: note conversion with accrued interest — v1 uses wrong closing date
// (no interest), v2 corrects it.  Also a 2x liquidation multiple is agreed but
// v1 shows 1x.
// ─────────────────────────────────────────────────────────────────────────────

const gamma_preRound = [
  { name: 'Dr. Sara Okonkwo (Founder)', type: 'common', shares: 5_000_000 },
  { name: 'Tech Co-founder',            type: 'common', shares: 2_500_000 },
  { name: 'Option Pool',                type: 'option', shares:   500_000 },
  { name: 'Friends & Family Note',      type: 'note', shares: 0, principal: 300_000,
    interestRate: 0.05, issueDate: '2022-06-01',
    valuationCap: 7_000_000, discountRate: 0.85 },
];

// v1 — wrong closing date (same as issue date → 0 interest), wrong liq multiple
const gamma_v1 = build(gamma_preRound, {
  roundName: 'Seed', preMoneyValuation: 7_000_000, newInvestment: 1_500_000,
  optionPoolTargetPct: 0.10, optionPoolMethod: 'pre-money',
  newShareClass: 'Seed Preferred', newInvestorName: 'HealthTech Ventures',
  liquidationMultiple: 1,  // ← error: should be 2x
  participating: false, participationCap: null,
  closingDate: '2022-06-01',  // ← same as issue date → no interest
}, { name: 'Gamma Health Seed', version: 'v1 (errors: liq+interest)', date: '2024-02-01', source: 'company' });

// v2 — corrected closing date (18 months of interest) + 2x liq multiple
const gamma_v2 = build(gamma_preRound, {
  roundName: 'Seed', preMoneyValuation: 7_000_000, newInvestment: 1_500_000,
  optionPoolTargetPct: 0.10, optionPoolMethod: 'pre-money',
  newShareClass: 'Seed Preferred', newInvestorName: 'HealthTech Ventures',
  liquidationMultiple: 2,  // ← corrected
  participating: false, participationCap: null,
  closingDate: '2023-12-01',  // ← 18 months after issue date → accrues interest
}, { name: 'Gamma Health Seed', version: 'v2 (corrected)', date: '2024-02-15', source: 'agreed' });

const gamma_termSheet = {
  dealName: 'Gamma Health Seed', roundName: 'Seed', source: 'agreed', date: '2024-01-20',
  preMoneyValuation: 7_000_000, investmentAmount: 1_500_000,
  targetOptionPool: 0.10, optionPoolMethod: 'pre-money',
  liquidationMultiple: 2, participating: false, participationCap: null,
  antiDilution: 'broad-based-weighted-average',
  noteConversions: [
    { holderName: 'Friends & Family Note', principal: 300_000,
      interestRate: 0.05, valuationCap: 7_000_000, discountRate: 0.85 },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// POPULATE DATABASE
// ─────────────────────────────────────────────────────────────────────────────

const db = createDatabase();

db.add('proforma',  'Acme Inc. Series A', 'v1', acme_v1,  { date: '2024-01-15', source: 'company'    });
db.add('proforma',  'Acme Inc. Series A', 'v2', acme_v2,  { date: '2024-01-22', source: 'investor'   });
db.add('proforma',  'Acme Inc. Series A', 'v3', acme_v3,  { date: '2024-02-01', source: 'agreed'     });
db.add('termsheet', 'Acme Inc. Series A', 'signed', acme_termSheet, { date: '2024-01-10', source: 'agreed' });

db.add('proforma',  'Beta Co. Series A', 'v1', beta_v1,   { date: '2024-03-01', source: 'company'    });
db.add('proforma',  'Beta Co. Series A', 'v2', beta_v2,   { date: '2024-03-15', source: 'negotiated' });
db.add('proforma',  'Beta Co. Series A', 'v3', beta_v3,   { date: '2024-04-01', source: 'agreed'     });
db.add('termsheet', 'Beta Co. Series A', 'signed', beta_termSheet, { date: '2024-02-15', source: 'agreed' });

db.add('proforma',  'Gamma Health Seed', 'v1', gamma_v1,  { date: '2024-02-01', source: 'company'    });
db.add('proforma',  'Gamma Health Seed', 'v2', gamma_v2,  { date: '2024-02-15', source: 'agreed'     });
db.add('termsheet', 'Gamma Health Seed', 'signed', gamma_termSheet, { date: '2024-01-20', source: 'agreed' });

// ─────────────────────────────────────────────────────────────────────────────
// JSON OUTPUT MODE
// ─────────────────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  const diffs       = db.diffAll();
  const conformance = db.auditAll();
  console.log(JSON.stringify({ diffs, conformance }, null, 2));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
// REPORT RENDERING
// ═══════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

header('NVCA PRO FORMA — COMPARISON & CONFORMANCE ENGINE');

// ── Database contents ─────────────────────────────────────
section('DATABASE CONTENTS');
const allPFs = db.list({ type: 'proforma' });
const allTSs = db.list({ type: 'termsheet' });
console.log(`  ${C.bold}${allPFs.length} pro formas  |  ${allTSs.length} term sheets${C.reset}\n`);

console.log(`  ${C.dim}${'#'.padEnd(4)}${'Deal'.padEnd(28)}${'Version'.padEnd(30)}${'Date'.padEnd(12)}Source${C.reset}`);
for (const r of [...allPFs, ...allTSs]) {
  const tag  = r.type === 'termsheet' ? `${C.yellow}[TS] ${C.reset}` : `${C.cyan}[PF] ${C.reset}`;
  console.log(`  ${tag}${C.dim}[${r.id}]${C.reset} ${r.name.padEnd(28)}${r.version.padEnd(30)}${r.date.padEnd(12)}${r.source}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-DEAL SECTION
// ─────────────────────────────────────────────────────────────────────────────

const DEALS = [
  { name: 'Acme Inc. Series A', versions: [acme_v1, acme_v2, acme_v3], termSheet: acme_termSheet, final: acme_v3 },
  { name: 'Beta Co. Series A',  versions: [beta_v1, beta_v2, beta_v3], termSheet: beta_termSheet,  final: beta_v3 },
  { name: 'Gamma Health Seed',  versions: [gamma_v1, gamma_v2],         termSheet: gamma_termSheet, final: gamma_v2 },
];

for (const deal of DEALS) {
  if (DEAL_FILTER && !deal.name.toLowerCase().includes(DEAL_FILTER)) continue;

  header(`DEAL: ${deal.name.toUpperCase()}`);

  // ── Version diffs ──────────────────────────────────────────
  for (let i = 0; i < deal.versions.length - 1; i++) {
    const vA  = deal.versions[i];
    const vB  = deal.versions[i + 1];
    const diff = diffProFormas(vA, vB);

    section(`VERSION DIFF  ${diff.labelA}  →  ${diff.labelB}`);

    // Economics changes
    if (diff.economics.length === 0) {
      console.log(`  ${C.dim}  (no economic changes)${C.reset}`);
    } else {
      console.log(`  ${C.bold}  Economics:${C.reset}`);
      for (const e of diff.economics) {
        const arrow = e.delta > 0 ? '▲' : '▼';
        let col;
        if (e.highlight === 'pps')  col = e.delta < 0 ? C.red : C.green;
        else if (e.highlight === 'pool') col = C.yellow;
        else col = C.reset;
        const pctStr = e.pctDelta != null
          ? ` (${e.pctDelta >= 0 ? '+' : ''}${(e.pctDelta * 100).toFixed(2)}%)`
          : '';
        console.log(`  ${col}    ${arrow} ${e.label.padEnd(26)} ${e.aFmt.padStart(14)}  →  ${e.bFmt}${pctStr}${C.reset}`);
      }
    }

    // Ownership changes
    const owChanged = diff.ownership.filter(o => Math.abs(o.deltaPct) > 0.0001);
    if (owChanged.length > 0) {
      console.log(`\n  ${C.bold}  Ownership shifts:${C.reset}`);
      console.log(`  ${C.dim}    ${'Stakeholder'.padEnd(30)} ${'Before'.padStart(8)} ${'After'.padStart(8)} ${'Δ (pp)'.padStart(9)}${C.reset}`);
      for (const o of owChanged) {
        const sign = o.deltaPct >= 0 ? '+' : '';
        const col  = o.isNew ? C.cyan
                   : o.type === 'option' ? C.yellow
                   : o.deltaPct < -0.0001 ? C.red
                   : o.deltaPct > 0.0001  ? C.green
                   : C.dim;
        const tag = o.isNew ? ' [new]' : o.isRemoved ? ' [removed]' : '';
        console.log(`  ${col}    ${(o.name + tag).padEnd(30)} ${fmt.pct(o.pctA).padStart(8)} ${fmt.pct(o.pctB).padStart(8)} ${(sign + fmt.pct(o.deltaPct)).padStart(9)}${C.reset}`);
      }
    }

    // Issues/warnings
    if (diff.issues.resolved.length || diff.issues.introduced.length) {
      console.log(`\n  ${C.bold}  Issues:${C.reset}`);
      for (const i of diff.issues.resolved)    console.log(`  ${C.green}    ✓ RESOLVED  [${i.code}] ${i.message || ''}${C.reset}`);
      for (const i of diff.issues.introduced)  console.log(`  ${C.red}    ✗ NEW       [${i.code}] ${i.message || ''}${C.reset}`);
    }
    if (diff.warnings.resolved.length || diff.warnings.introduced.length) {
      console.log(`\n  ${C.bold}  Warnings:${C.reset}`);
      for (const w of diff.warnings.resolved)   console.log(`  ${C.green}    ✓ RESOLVED  [${w.code}] ${w.message || ''}${C.reset}`);
      for (const w of diff.warnings.introduced) console.log(`  ${C.yellow}    ⚠ NEW       [${w.code}] ${w.message || ''}${C.reset}`);
    }

    // Conversion changes
    if (diff.conversions.length > 0) {
      console.log(`\n  ${C.bold}  Conversion changes:${C.reset}`);
      for (const cv of diff.conversions) {
        const shareSign = cv.deltaShares >= 0 ? '+' : '';
        const ppsSign   = cv.deltaPPS >= 0    ? '+' : '';
        console.log(`  ${C.cyan}    ${cv.name}${C.reset}`);
        console.log(`    ${C.dim}  shares: ${fmt.shares(cv.sharesA)} → ${fmt.shares(cv.sharesB)} (${shareSign}${Math.round(cv.deltaShares).toLocaleString()})${C.reset}`);
        console.log(`    ${C.dim}  conv PPS: ${fmt.pps(cv.ppsA)} → ${fmt.pps(cv.ppsB)} (${ppsSign}${cv.deltaPPS.toFixed(4)})${C.reset}`);
        if (cv.basisA !== cv.basisB) {
          console.log(`    ${C.yellow}  conv basis: ${cv.basisA} → ${cv.basisB}${C.reset}`);
        }
      }
    }
  }

  // ── Final pro forma snapshot ───────────────────────────────
  const final = deal.final;
  section(`FINAL PRO FORMA SNAPSHOT  (${final.meta.version})`);

  row('Price per share',        fmt.pps(final.pps));
  row('Pre-money valuation',    fmt.currency(final.preMoneyValuation));
  row('New investment',         fmt.currency(final.newInvestment));
  row('Post-money valuation',   fmt.currency(final.postMoneyValuation));
  row('Pre-money FD shares',    fmt.shares(final.premoneyFD));
  row('Post-money FD shares',   fmt.shares(final.postFD));
  row('Option pool %',          fmt.pct(final.actualOptionPoolPct));
  row('Pool expansion (shares)',fmt.shares(final.optionExpansion));

  if (final.convertedInstruments?.length > 0) {
    console.log(`\n  ${C.bold}  Converted instruments:${C.reset}`);
    console.log(`  ${C.dim}    ${'Name'.padEnd(28)} ${'Type'.padEnd(8)} ${'Conv PPS'.padStart(10)} ${'Basis'.padStart(10)} ${'Shares'.padStart(12)}${C.reset}`);
    for (const ci of final.convertedInstruments) {
      console.log(`  ${C.cyan}    ${ci.name.padEnd(28)} ${(ci.originalType || '').padEnd(8)} ${fmt.pps(ci.conversionPPS).padStart(10)} ${(ci.conversionBasis || '').padStart(10)} ${fmt.shares(ci.shares).padStart(12)}${C.reset}`);
    }
  }

  console.log(`\n  ${C.bold}  Post-round cap table:${C.reset}`);
  console.log(`  ${C.dim}    ${'Name'.padEnd(30)} ${'Type'.padEnd(10)} ${'Shares'.padStart(12)} ${'Ownership'.padStart(10)}${C.reset}`);
  const sorted = [...(final.ownershipTable || [])].sort((a, b) => b.pct - a.pct);
  for (const r of sorted) {
    const col = r.type === 'option' ? C.yellow
              : r.type === 'preferred' ? C.cyan
              : C.reset;
    console.log(`  ${col}    ${r.name.padEnd(30)} ${r.type.padEnd(10)} ${fmt.shares(r.shares).padStart(12)} ${fmt.pct(r.pct).padStart(10)}${C.reset}`);
  }

  // ── Conformance report ────────────────────────────────────
  const conf = checkConformance(final, deal.termSheet);
  section(`CONFORMANCE  (final pro forma vs. signed term sheet)`);

  const score     = Math.round(conf.score * 100);
  const scoreCol  = score >= 90 ? C.green : score >= 70 ? C.yellow : C.red;
  const confLabel = conf.conformant ? `${C.green}✓ CONFORMANT${C.reset}` : `${C.red}✗ NON-CONFORMANT${C.reset}`;

  console.log(`  ${C.bold}  Score: ${scoreCol}${score}%${C.reset}  (${conf.passed.length}/${conf.checks.length} checks)   ${confLabel}`);

  if (conf.criticalFailures.length > 0) {
    console.log(`\n  ${C.red}${C.bold}  CRITICAL FAILURES:${C.reset}`);
    for (const ch of conf.criticalFailures) {
      console.log(`  ${C.red}    ✗ ${ch.label}${C.reset}`);
      console.log(`      ${C.dim}Expected: ${ch.expectedFmt.padEnd(20)}  Actual: ${ch.actualFmt}${C.reset}`);
      if (ch.note) console.log(`      ${C.dim}→ ${ch.note}${C.reset}`);
    }
  }

  if (conf.warningFailures.length > 0) {
    console.log(`\n  ${C.yellow}${C.bold}  WARNINGS:${C.reset}`);
    for (const ch of conf.warningFailures) {
      console.log(`  ${C.yellow}    ⚠ ${ch.label}${C.reset}`);
      console.log(`      ${C.dim}Expected: ${ch.expectedFmt.padEnd(20)}  Actual: ${ch.actualFmt}${C.reset}`);
      if (ch.note) console.log(`      ${C.dim}→ ${ch.note}${C.reset}`);
    }
  }

  if (conf.passed.length > 0) {
    console.log(`\n  ${C.green}${C.bold}  PASSING CHECKS:${C.reset}`);
    for (const ch of conf.passed) {
      console.log(`  ${C.green}    ✓ ${ch.label}: ${ch.actualFmt}${C.reset}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-DEAL SUMMARY TABLE
// ─────────────────────────────────────────────────────────────────────────────

if (!DEAL_FILTER) {
  header('CROSS-DEAL SUMMARY');

  section('All Final Pro Formas');
  const COL = [35, 10, 12, 14, 8, 7];
  const hdr = ['Deal (final version)', 'PPS', 'Pre-$M', 'Post-$M', 'Pool%', 'Conf%'];
  console.log(`  ${C.dim}${hdr[0].padEnd(COL[0])}${hdr[1].padStart(COL[1])}${hdr[2].padStart(COL[2])}${hdr[3].padStart(COL[3])}${hdr[4].padStart(COL[4])}${hdr[5].padStart(COL[5])}${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(COL.reduce((a, b) => a + b))}${C.reset}`);

  const finals = [
    { r: acme_v3, ts: acme_termSheet },
    { r: beta_v3, ts: beta_termSheet },
    { r: gamma_v2, ts: gamma_termSheet },
  ];
  for (const { r, ts } of finals) {
    const conf  = checkConformance(r, ts);
    const score = Math.round(conf.score * 100);
    const sCol  = score >= 90 ? C.green : score >= 70 ? C.yellow : C.red;
    const label = `${r.meta.name} (${r.meta.version})`;
    console.log(
      `  ${label.padEnd(COL[0])}` +
      `${fmt.pps(r.pps).padStart(COL[1])}` +
      `${fmt.currency(r.preMoneyValuation).padStart(COL[2])}` +
      `${fmt.currency(r.postMoneyValuation).padStart(COL[3])}` +
      `${fmt.pct(r.actualOptionPoolPct).padStart(COL[4])}` +
      `${sCol}${String(score + '%').padStart(COL[5])}${C.reset}`
    );
  }

  section('Version-over-Version PPS Movement');
  for (const { r, ts } of finals) {
    const versions = db.getVersions(r.meta.name).filter(x => x.type === 'proforma');
    if (versions.length < 2) continue;
    const ppsList = versions.map(v => `${v.version}: ${fmt.pps(v.data.pps)}`);
    console.log(`  ${C.bold}${r.meta.name}${C.reset}`);
    for (const p of ppsList) console.log(`    ${C.dim}${p}${C.reset}`);
  }

  console.log(`\n  ${C.dim}Run with --deal <name> to filter to one deal.${C.reset}`);
  console.log(`  ${C.dim}Run with --json for machine-readable output.${C.reset}`);
  console.log(`  ${C.dim}Run with --no-color for plain text.\n${C.reset}`);
}
