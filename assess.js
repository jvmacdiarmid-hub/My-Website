#!/usr/bin/env node
/**
 * NVCA Pro Forma — Dataset Accuracy Assessor
 *
 * Loads test-data.json (or any JSON file you specify), runs each deal
 * through the engine, and compares computed outputs against your expected
 * values. Designed to scale from a handful of deals to thousands.
 *
 * Usage:
 *   node assess.js                        # run test-data.json
 *   node assess.js --file my-deals.json   # run a different file
 *   node assess.js --verbose              # show passing checks too
 *   node assess.js --no-color             # plain output (CI-friendly)
 *
 * Exit code: 0 if every check passes, 1 if any fail.
 *
 * ── Deal schema (each item in the JSON array) ─────────────────────────
 *
 *   {
 *     "label":       string          (printed in output)
 *     "description": string          (shown with --verbose)
 *     "stakeholders": [...]          (same shape as ProFormaEngine.buildProForma arg 1)
 *     "config":      {...}           (same shape as ProFormaEngine.buildProForma arg 2)
 *     "options":     {...}           (optional: { roundingMethod })
 *     "tolerancePct": number         (default 0.001 = 0.1%  — applies to all numeric checks)
 *     "tolerances":  {               (optional per-field overrides)
 *       "pps": 0.001,
 *       "actualOptionPoolPct": 0.005
 *     }
 *
 *     "expected": {
 *       // Numeric fields (checked within tolerancePct unless overridden):
 *       "pps":                number
 *       "postMoneyValuation":  number   (always exact — no rounding)
 *       "newInvestorPct":      number   (e.g. 0.1667 for 16.67%)
 *       "actualOptionPoolPct": number   (e.g. 0.15 for 15%)
 *       "noteInterest":        number   (first note's accrued interest)
 *
 *       // Exact integer check:
 *       "convertedCount": number   (convertedInstruments.length)
 *
 *       // Exact string check:
 *       "analyzerStatus": "ok" | "warning" | "error"
 *
 *       // Code presence checks (all listed codes must appear):
 *       "expectedIssueCodes":   ["DOWN_ROUND", ...]
 *       "expectedWarningCodes": ["POOL_LARGE", "DEEP_DISCOUNT", ...]
 *       "expectedNoteCodes":    ["PARTICIPATING_PREFERRED", ...]
 *     }
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Node shim ─────────────────────────────────────────────────────────
if (typeof globalThis.performance === 'undefined') {
  const { performance } = require('perf_hooks');
  globalThis.performance = performance;
}

// ── Engine ────────────────────────────────────────────────────────────
globalThis.ProFormaEngine = require('./proforma-engine.js');
const E = ProFormaEngine;

// ── Args ──────────────────────────────────────────────────────────────
const argv     = process.argv.slice(2);
const useColor = !argv.includes('--no-color') && !process.env.NO_COLOR && process.stdout.isTTY;
const verbose  = argv.includes('--verbose') || argv.includes('-v');
const fileArg  = argValue('--file') || argValue('-f') || 'test-data.json';

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '',
    'Usage: node assess.js [options]',
    '',
    'Options:',
    '  --file, -f <path>   JSON dataset file  (default: test-data.json)',
    '  --verbose, -v       Show passing checks as well as failures',
    '  --no-color          Disable ANSI colour output',
    '  --help, -h          Show this help',
    '',
  ].join('\n'));
  process.exit(0);
}

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

// ── ANSI colours ──────────────────────────────────────────────────────
const col = useColor
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
      green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m',
      cyan:'\x1b[36m',  gray:'\x1b[90m', white:'\x1b[97m' }
  : Object.fromEntries(
      ['reset','bold','dim','green','red','yellow','cyan','gray','white']
        .map(k => [k, ''])
    );

// ── Formatters ────────────────────────────────────────────────────────
function fmtPct(n)  { return (n * 100).toFixed(3) + '%'; }
function fmtCur(n)  { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function fmtNum(n)  {
  if (typeof n !== 'number') return String(n);
  if (Math.abs(n) >= 100)   return fmtCur(n);
  return n.toFixed(6);
}

// ── Check helpers ─────────────────────────────────────────────────────

/** Numeric check with relative tolerance. */
function checkNumeric(label, actual, expected, tol) {
  if (typeof actual !== 'number' || !isFinite(actual)) {
    return { pass: false, label, msg: `got ${actual} (not a finite number)` };
  }
  const denom   = Math.abs(expected) > 1e-10 ? Math.abs(expected) : 1;
  const relDiff = Math.abs(actual - expected) / denom;
  const pass    = relDiff <= tol;
  const msg     = pass
    ? `${fmtNum(actual)}  (expected ~${fmtNum(expected)}, ±${fmtPct(tol)})`
    : `${fmtNum(actual)} ≠ ~${fmtNum(expected)} — off by ${fmtPct(relDiff)}  (tolerance ±${fmtPct(tol)})`;
  return { pass, label, msg };
}

/** Exact equality check for integers and strings. */
function checkExact(label, actual, expected) {
  const pass = actual === expected;
  const msg  = pass
    ? `${JSON.stringify(actual)}`
    : `${JSON.stringify(actual)} ≠ expected ${JSON.stringify(expected)}`;
  return { pass, label, msg };
}

/** Check that every listed code appears in the items array. */
function checkCodes(label, items, codes) {
  const found   = new Set(items.map(i => i.code));
  const missing = codes.filter(code => !found.has(code));
  const pass    = missing.length === 0;
  const msg     = pass
    ? `found: [${codes.join(', ')}]`
    : `missing: [${missing.join(', ')}]  —  present: [${[...found].join(', ')}]`;
  return { pass, label, msg };
}

// ── Main ──────────────────────────────────────────────────────────────
function main() {
  const dataPath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(dataPath)) {
    console.error(`${col.red}File not found: ${dataPath}${col.reset}`);
    process.exit(1);
  }

  let deals;
  try {
    deals = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) {
    console.error(`${col.red}Failed to parse ${fileArg}: ${err.message}${col.reset}`);
    process.exit(1);
  }

  if (!Array.isArray(deals) || deals.length === 0) {
    console.error(`${col.red}${fileArg} must be a non-empty JSON array.${col.reset}`);
    process.exit(1);
  }

  // ── Header ─────────────────────────────────────────────────────────
  console.log(`\n${col.bold}${col.white}NVCA Pro Forma — Accuracy Assessment${col.reset}`);
  console.log(`${col.gray}File : ${dataPath}${col.reset}`);
  console.log(`${col.gray}Deals: ${deals.length}${col.reset}`);
  console.log(`${col.gray}${'─'.repeat(62)}${col.reset}`);

  let totalChecks = 0;
  let totalPassed = 0;
  const allFailures = [];

  // ── Process each deal ───────────────────────────────────────────────
  for (let idx = 0; idx < deals.length; idx++) {
    const deal  = deals[idx];
    const label = deal.label || `Deal ${idx + 1}`;
    const exp   = deal.expected || {};

    // Per-field tolerances: deal.tolerances[field] > deal.tolerancePct > default
    const defaultTol = deal.tolerancePct ?? 0.001;
    const fieldTol   = deal.tolerances   || {};
    function tol(field, fallback) {
      return fieldTol[field] ?? fallback ?? defaultTol;
    }

    console.log(`\n  ${col.cyan}${col.bold}▸ [${idx + 1}/${deals.length}] ${label}${col.reset}`);
    if (deal.description && verbose) {
      console.log(`    ${col.dim}${deal.description}${col.reset}`);
    }

    // ── Build ───────────────────────────────────────────────────────
    let result, analysis;
    try {
      result   = E.buildProForma(deal.stakeholders, deal.config, deal.options || {});
      analysis = E.analyzeProForma(result, deal.stakeholders, deal.config);
    } catch (err) {
      console.log(`    ${col.red}✗ Engine error: ${err.message}${col.reset}`);
      totalChecks++;
      allFailures.push({ label, field: 'engine', msg: err.message });
      continue;
    }

    // ── Collect checks ──────────────────────────────────────────────
    const checks = [];

    // Numeric fields
    if (exp.pps !== undefined)
      checks.push(checkNumeric('pps', result.pps, exp.pps, tol('pps')));

    if (exp.postMoneyValuation !== undefined)
      checks.push(checkNumeric('postMoneyValuation', result.postMoneyValuation, exp.postMoneyValuation, tol('postMoneyValuation', 0)));

    if (exp.newInvestorPct !== undefined) {
      const actual = result.postFD > 0 ? result.newInvestorShares / result.postFD : 0;
      checks.push(checkNumeric('newInvestorPct', actual, exp.newInvestorPct, tol('newInvestorPct')));
    }

    if (exp.actualOptionPoolPct !== undefined)
      checks.push(checkNumeric('actualOptionPoolPct', result.actualOptionPoolPct, exp.actualOptionPoolPct, tol('actualOptionPoolPct', 0.005)));

    if (exp.noteInterest !== undefined) {
      const note   = result.convertedInstruments.find(ci => ci.originalType === 'note');
      const actual = note ? note.interest : NaN;
      checks.push(checkNumeric('noteInterest', actual, exp.noteInterest, tol('noteInterest')));
    }

    // Exact integer
    if (exp.convertedCount !== undefined)
      checks.push(checkExact('convertedCount', result.convertedInstruments.length, exp.convertedCount));

    // Analyzer status
    if (exp.analyzerStatus !== undefined)
      checks.push(checkExact('analyzerStatus', analysis.summary.status, exp.analyzerStatus));

    // Code presence
    if (Array.isArray(exp.expectedIssueCodes)   && exp.expectedIssueCodes.length)
      checks.push(checkCodes('issue codes',   analysis.issues,   exp.expectedIssueCodes));

    if (Array.isArray(exp.expectedWarningCodes) && exp.expectedWarningCodes.length)
      checks.push(checkCodes('warning codes', analysis.warnings, exp.expectedWarningCodes));

    if (Array.isArray(exp.expectedNoteCodes)    && exp.expectedNoteCodes.length)
      checks.push(checkCodes('note codes',    analysis.notes,    exp.expectedNoteCodes));

    // ── Print results ───────────────────────────────────────────────
    if (checks.length === 0) {
      console.log(`    ${col.yellow}(no expected values defined — add an "expected" object to this deal)${col.reset}`);
      continue;
    }

    let dealPassed = 0;
    for (const ck of checks) {
      totalChecks++;
      if (ck.pass) {
        totalPassed++;
        dealPassed++;
        if (verbose)
          console.log(`    ${col.green}✓${col.reset} ${col.dim}${ck.label}:${col.reset} ${ck.msg}`);
      } else {
        console.log(`    ${col.red}✗${col.reset} ${col.bold}${ck.label}:${col.reset} ${col.red}${ck.msg}${col.reset}`);
        allFailures.push({ label, field: ck.label, msg: ck.msg });
      }
    }

    const allPass   = dealPassed === checks.length;
    const passColor = allPass ? col.green : col.red;
    console.log(`    ${col.dim}→${col.reset} ${passColor}${dealPassed}/${checks.length} checks passed${col.reset}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  const failed      = totalChecks - totalPassed;
  const accuracyPct = totalChecks > 0 ? (totalPassed / totalChecks * 100).toFixed(1) : '—';

  console.log(`\n${col.gray}${'─'.repeat(62)}${col.reset}`);

  if (failed === 0) {
    console.log(`${col.green}${col.bold}  ✓ All ${totalChecks} checks passed — ${accuracyPct}% accuracy${col.reset}\n`);
  } else {
    console.log(`${col.red}${col.bold}  ✗ ${failed} check(s) failed${col.reset}  ${col.green}${totalPassed} passed${col.reset}  ${col.gray}accuracy: ${accuracyPct}%${col.reset}`);
    if (!verbose && allFailures.length) {
      console.log(`\n${col.bold}  Failed checks:${col.reset}`);
      allFailures.forEach((f, i) => {
        console.log(`    ${col.red}${i + 1}. [${f.label}] ${f.field}${col.reset}`);
        console.log(`       ${col.dim}${f.msg}${col.reset}`);
      });
    }
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
