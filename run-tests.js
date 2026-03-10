#!/usr/bin/env node
/**
 * NVCA Pro Forma — Node.js CLI Test Runner
 *
 * Usage:
 *   node run-tests.js              # run all tests
 *   node run-tests.js --category PPS        # run one category
 *   node run-tests.js --filter "SAFE"       # run tests whose name contains "SAFE"
 *   node run-tests.js --list                # list all tests
 *   node run-tests.js --no-color            # plain output (CI-friendly)
 *
 * Exit code: 0 if all tests pass, 1 if any fail.
 */

'use strict';

// ── Node.js version check ─────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 14) {
  console.error('Node.js 14+ is required. Current version:', process.version);
  process.exit(1);
}

// ── Shims required by engine/test files ───────────────────────────
// performance.now() — available natively in Node 16+, polyfill for 14/15
if (typeof globalThis.performance === 'undefined') {
  const { performance } = require('perf_hooks');
  globalThis.performance = performance;
}

// ── Load engine (sets global ProFormaEngine for test suite) ───────
globalThis.ProFormaEngine = require('./proforma-engine.js');

// ── Load test suite (needs ProFormaEngine global already set) ──────
const ProFormaTests = require('./proforma-tests.js');

// ── ANSI colours (disabled with --no-color or NO_COLOR env var) ───
const argv        = process.argv.slice(2);
const useColor    = !argv.includes('--no-color') && !process.env.NO_COLOR && process.stdout.isTTY;

const c = useColor
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
      green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m',
      cyan:'\x1b[36m', gray:'\x1b[90m', white:'\x1b[97m' }
  : Object.fromEntries(
      ['reset','bold','dim','green','red','yellow','cyan','gray','white']
        .map(k => [k, ''])
    );

// ── Arg parsing ───────────────────────────────────────────────────
const listOnly    = argv.includes('--list');
const catArg      = argValue('--category') || argValue('-c');
const filterArg   = argValue('--filter')   || argValue('-f');

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

// ── --list ────────────────────────────────────────────────────────
if (listOnly) {
  const cats = ProFormaTests.getCategories();
  console.log(`\n${c.bold}Available categories:${c.reset}`);
  cats.forEach(cat => {
    const tests = ProFormaTests.registry.filter(t => t.category === cat);
    console.log(`  ${c.cyan}${cat}${c.reset} (${tests.length} tests)`);
    tests.forEach(t => console.log(`    ${c.dim}· ${t.name}${c.reset}`));
  });
  console.log(`\n${c.bold}Total: ${ProFormaTests.registry.length} tests${c.reset}\n`);
  process.exit(0);
}

// ── Determine test set ────────────────────────────────────────────
let testSet = ProFormaTests.registry;

if (catArg) {
  testSet = testSet.filter(t => t.category.toLowerCase() === catArg.toLowerCase());
  if (!testSet.length) {
    console.error(`No tests found for category "${catArg}". Use --list to see categories.`);
    process.exit(1);
  }
}

if (filterArg) {
  const re = new RegExp(filterArg, 'i');
  testSet = testSet.filter(t => re.test(t.name) || re.test(t.category));
  if (!testSet.length) {
    console.error(`No tests match filter "${filterArg}".`);
    process.exit(1);
  }
}

// ── Runner ────────────────────────────────────────────────────────
async function main() {
  const startAll = performance.now();
  let passed = 0, failed = 0;
  const failures = [];

  // Header
  const scope = catArg   ? ` [category: ${catArg}]`
              : filterArg ? ` [filter: "${filterArg}"]`
              : '';
  console.log(`\n${c.bold}${c.white}NVCA Pro Forma Test Runner${c.reset}${c.gray}${scope}${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(56)}${c.reset}`);

  let currentCat = null;

  for (const t of testSet) {
    if (t.category !== currentCat) {
      currentCat = t.category;
      console.log(`\n  ${c.cyan}${c.bold}▸ ${currentCat}${c.reset}`);
    }

    const start  = performance.now();
    let status   = 'pass';
    let errMsg   = null;

    try {
      await t.fn();
    } catch (e) {
      status = 'fail';
      errMsg = e.message;
    }

    const dur = (performance.now() - start).toFixed(1);

    if (status === 'pass') {
      passed++;
      console.log(`    ${c.green}✓${c.reset} ${c.dim}${t.name}${c.reset} ${c.gray}(${dur}ms)${c.reset}`);
    } else {
      failed++;
      failures.push({ name: t.name, category: t.category, error: errMsg });
      console.log(`    ${c.red}✗${c.reset} ${c.bold}${t.name}${c.reset} ${c.gray}(${dur}ms)${c.reset}`);
      console.log(`      ${c.red}${errMsg}${c.reset}`);
    }
  }

  // Summary
  const elapsed = (performance.now() - startAll).toFixed(0);
  console.log(`\n${c.gray}${'─'.repeat(56)}${c.reset}`);

  if (failed === 0) {
    console.log(`${c.green}${c.bold}  ✓ All ${passed} tests passed${c.reset} ${c.gray}(${elapsed}ms)${c.reset}\n`);
  } else {
    console.log(`${c.red}${c.bold}  ✗ ${failed} failed${c.reset}  ${c.green}${passed} passed${c.reset}  ${c.gray}${elapsed}ms${c.reset}`);

    if (failures.length) {
      console.log(`\n${c.bold}Failed tests:${c.reset}`);
      failures.forEach((f, i) => {
        console.log(`  ${c.red}${i + 1}. [${f.category}] ${f.name}${c.reset}`);
        console.log(`     ${c.dim}${f.error}${c.reset}`);
      });
    }
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${c.red}Fatal runner error:${c.reset}`, err);
  process.exit(1);
});
