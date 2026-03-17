#!/usr/bin/env node
/**
 * NVCA Pro Forma — Database Manager
 *
 * Persists pro formas and term sheets to a JSON file (default: database.json).
 * Builds up a searchable record of deals over time without touching the browser UI.
 *
 * ── Commands ──────────────────────────────────────────────────────────────────
 *
 *   add-proforma   Build and store a pro forma from a deal definition file
 *   add-termsheet  Store a term sheet
 *   import         Bulk-load many deals and/or term sheets from one file
 *   list           List all records (filterable)
 *   show           Print one record's full data
 *   audit          Run conformance checks: every pro forma vs matching term sheet
 *   diff           Diff consecutive versions of a named deal
 *   export         Re-export the DB to a tidy JSON file
 *   delete         Remove a record by ID
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   node manage-db.js add-proforma  --file deal.json [--version v1] [--tags signed,final]
 *   node manage-db.js add-termsheet --file ts.json   [--version v1] [--tags loi]
 *   node manage-db.js import        --file bulk.json [--dry-run]
 *   node manage-db.js list          [--type proforma|termsheet] [--name "Acme A"] [--tags signed]
 *   node manage-db.js show          --id 3
 *   node manage-db.js audit         [--name "Acme A"]
 *   node manage-db.js diff          --name "Acme A"
 *   node manage-db.js export        [--out export.json]
 *   node manage-db.js delete        --id 3
 *
 *   Global options:
 *     --db <path>      Database file to use  (default: database.json)
 *     --no-color       Plain output (CI-friendly)
 *
 * ── Deal definition file (for add-proforma) ──────────────────────────────────
 *
 *   Same JSON shape used by assess.js / test-data.json, i.e.:
 *   {
 *     "name":         "Acme Inc — Series A",     // stored as the record name
 *     "version":      "company-draft",            // optional; overrides --version
 *     "date":         "2025-06-01",               // optional; defaults to today
 *     "source":       "company counsel",          // optional; free-text provenance
 *     "tags":         ["draft"],                  // optional
 *     "stakeholders": [...],
 *     "config":       { ... },
 *     "options":      { ... }                     // optional engine options
 *   }
 *
 * ── Bulk import file (for import) ────────────────────────────────────────────
 *
 *   A JSON object with two optional arrays:
 *   {
 *     "proformas": [
 *       {
 *         "name":         "Acme Inc — Series A",   // required
 *         "version":      "company-draft",          // optional, default "v1"
 *         "date":         "2025-06-01",             // optional
 *         "source":       "company counsel",        // optional
 *         "tags":         ["draft"],                // optional
 *         "stakeholders": [...],                    // required
 *         "config":       { ... },                  // required
 *         "options":      { ... }                   // optional
 *       },
 *       { ... }   // add as many deals as you like
 *     ],
 *     "termsheets": [
 *       {
 *         "name":               "Acme Inc — Series A",  // required — links to a pro forma
 *         "version":            "signed",
 *         "date":               "2025-05-15",
 *         "source":             "lead investor",
 *         "tags":               ["signed"],
 *         "preMoneyValuation":  12000000,
 *         "investmentAmount":   3000000,
 *         ...                                          // all normalizeTermSheet fields
 *       },
 *       { ... }
 *     ]
 *   }
 *
 *   You can include only "proformas", only "termsheets", or both.
 *   Use --dry-run to validate the file without writing to the database.
 *
 * ── Term sheet file (for add-termsheet) ──────────────────────────────────────
 *
 *   {
 *     "name":                   "Acme Inc — Series A",
 *     "version":                "signed",
 *     "date":                   "2025-05-15",
 *     "source":                 "lead investor",
 *     "tags":                   ["signed"],
 *     "dealName":               "Acme Inc — Series A",
 *     "roundName":              "Series A",
 *     "preMoneyValuation":      12000000,
 *     "investmentAmount":       3000000,
 *     "targetOptionPool":       0.15,
 *     "optionPoolMethod":       "pre-money",
 *     "liquidationMultiple":    1,
 *     "participating":          false,
 *     "antiDilution":           "broad-based weighted average",
 *     "investorOwnershipTarget": 0.20,
 *     "safeConversions": [
 *       { "name": "Angel SAFE", "valuationCap": 6000000, "discountRate": null }
 *     ],
 *     "noteConversions": [
 *       { "name": "Bridge Note", "interestRate": 0.06, "valuationCap": 7000000 }
 *     ]
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Node shim ────────────────────────────────────────────────────────────────
if (typeof globalThis.performance === 'undefined') {
  const { performance } = require('perf_hooks');
  globalThis.performance = performance;
}

// ── Load engines ─────────────────────────────────────────────────────────────
globalThis.ProFormaEngine    = require('./proforma-engine.js');
globalThis.ProFormaComparator = require('./proforma-comparator.js');
const E  = ProFormaEngine;
const C  = ProFormaComparator;

// ── Args ─────────────────────────────────────────────────────────────────────
const argv     = process.argv.slice(2);
const command  = argv[0];
const useColor = !argv.includes('--no-color') && !process.env.NO_COLOR && process.stdout.isTTY;
const dbFile   = argValue('--db') || 'database.json';

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
function hasFlag(flag) { return argv.includes(flag); }

// ── ANSI colours ─────────────────────────────────────────────────────────────
const col = useColor
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
      green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m',
      cyan:'\x1b[36m',  gray:'\x1b[90m', white:'\x1b[97m',
      magenta:'\x1b[35m' }
  : Object.fromEntries(
      ['reset','bold','dim','green','red','yellow','cyan','gray','white','magenta']
        .map(k => [k, ''])
    );

function c(color, text) { return col[color] + text + col.reset; }

// ── DB load / save ────────────────────────────────────────────────────────────
const dbPath = path.resolve(process.cwd(), dbFile);

function loadDB() {
  const db = C.createDatabase();
  if (fs.existsSync(dbPath)) {
    try {
      db.fromJSON(fs.readFileSync(dbPath, 'utf8'));
    } catch (err) {
      die(`Failed to load database ${dbFile}: ${err.message}`);
    }
  }
  return db;
}

function saveDB(db) {
  fs.writeFileSync(dbPath, db.toJSON(), 'utf8');
}

function die(msg) {
  console.error(c('red', `✗ ${msg}`));
  process.exit(1);
}

function readJSON(flag, label) {
  const filePath = argValue(flag);
  if (!filePath) die(`--file is required for ${label}.`);
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) die(`File not found: ${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    die(`Failed to parse ${filePath}: ${err.message}`);
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtDate(d) { return d || '—'; }
function fmtType(t) {
  return t === 'proforma'
    ? c('cyan',  'proforma ')
    : c('magenta', 'termsheet');
}
function fmtStatus(s) {
  if (s === 'ok')      return c('green',  '✓ ok');
  if (s === 'warning') return c('yellow', '⚠ warning');
  if (s === 'error')   return c('red',    '✗ error');
  return s;
}
function fmtConformance(c_) {
  if (!c_) return '—';
  const pass = c_.checks.filter(x => x.pass).length;
  const total = c_.checks.length;
  const ok = c_.conformant;
  const sym = ok ? c('green','✓') : c('red','✗');
  return `${sym} ${pass}/${total} checks`;
}

// ── Print a table row ─────────────────────────────────────────────────────────
function printRecordLine(r) {
  const tags = r.tags && r.tags.length ? c('gray', `[${r.tags.join(',')}]`) : '';
  console.log(
    `  ${c('gray', String(r.id).padStart(3, ' '))}  ` +
    `${fmtType(r.type)}  ` +
    `${c('white', r.name.padEnd(32, ' '))}  ` +
    `${c('yellow', (r.version || '').padEnd(20, ' '))}  ` +
    `${c('dim', fmtDate(r.date).padEnd(12, ' '))}  ` +
    `${tags}`
  );
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────

function cmdAddProforma() {
  const raw = readJSON('--file', 'add-proforma');

  if (!raw.name) die('Deal definition must include a "name" field.');
  if (!raw.stakeholders) die('Deal definition must include a "stakeholders" array.');
  if (!raw.config) die('Deal definition must include a "config" object.');

  const version = argValue('--version') || raw.version || 'v1';
  const tags    = (argValue('--tags') || (raw.tags || []).join(','))
                    .split(',').map(t => t.trim()).filter(Boolean);
  const meta    = { date: raw.date, source: raw.source, tags };

  let result, analysis;
  try {
    result   = E.buildProForma(raw.stakeholders, raw.config, raw.options || {});
    analysis = E.analyzeProForma(result, raw.stakeholders, raw.config);
  } catch (err) {
    die(`Engine error: ${err.message}`);
  }

  const db = loadDB();
  const record = db.add('proforma', raw.name, version, { ...result, analysis }, meta);
  saveDB(db);

  console.log(c('green', `\n✓ Pro forma stored`));
  console.log(`  ID      : ${c('bold', String(record.id))}`);
  console.log(`  Name    : ${record.name}`);
  console.log(`  Version : ${record.version}`);
  console.log(`  Status  : ${fmtStatus(analysis.summary.status)}`);
  console.log(`  PPS     : $${result.pps.toFixed(5)}`);
  console.log(`  Post $  : $${result.postMoneyValuation.toLocaleString()}`);
  console.log(`  Post FD : ${result.postFD.toLocaleString()} shares`);
  if (analysis.summary.issueCount)   console.log(`  ${c('red',    `Issues   : ${analysis.summary.issueCount}`)}`);
  if (analysis.summary.warningCount) console.log(`  ${c('yellow', `Warnings : ${analysis.summary.warningCount}`)}`);
  if (analysis.summary.noteCount)    console.log(`  ${c('dim',    `Notes    : ${analysis.summary.noteCount}`)}`);
  console.log(`  DB file : ${dbFile}  (${db.size} total records)\n`);
}

function cmdAddTermSheet() {
  const raw = readJSON('--file', 'add-termsheet');

  if (!raw.name) die('Term sheet must include a "name" field (used to link to a pro forma).');

  const version = argValue('--version') || raw.version || 'signed';
  const tags    = (argValue('--tags') || (raw.tags || []).join(','))
                    .split(',').map(t => t.trim()).filter(Boolean);
  const meta    = { date: raw.date, source: raw.source, tags };

  const normalized = C.normalizeTermSheet(raw);

  const db = loadDB();
  const record = db.add('termsheet', raw.name, version, normalized, meta);
  saveDB(db);

  console.log(c('green', `\n✓ Term sheet stored`));
  console.log(`  ID      : ${c('bold', String(record.id))}`);
  console.log(`  Name    : ${record.name}`);
  console.log(`  Version : ${record.version}`);
  console.log(`  Pre-$   : $${(raw.preMoneyValuation || 0).toLocaleString()}`);
  console.log(`  Invest  : $${(raw.investmentAmount  || 0).toLocaleString()}`);
  console.log(`  DB file : ${dbFile}  (${db.size} total records)\n`);
}

function cmdList() {
  const db     = loadDB();
  const filter = {};
  if (argValue('--type'))   filter.type   = argValue('--type');
  if (argValue('--name'))   filter.name   = argValue('--name');
  if (argValue('--source')) filter.source = argValue('--source');
  if (argValue('--tags'))   filter.tags   = argValue('--tags').split(',').map(t => t.trim());

  const records = db.list(Object.keys(filter).length ? filter : undefined);

  console.log(`\n${c('bold','NVCA Database')}  ${c('gray', `(${dbFile}  •  ${db.size} total records)`)}`);
  console.log(c('gray', '  ' + '─'.repeat(90)));
  console.log(
    c('gray',
      `  ${'ID'.padEnd(4)} ${'TYPE'.padEnd(11)} ${'NAME'.padEnd(33)} ${'VERSION'.padEnd(21)} ${'DATE'.padEnd(13)} TAGS`)
  );
  console.log(c('gray', '  ' + '─'.repeat(90)));

  if (records.length === 0) {
    console.log(`  ${c('yellow','(no records match)')}  — add some with add-proforma or add-termsheet\n`);
    return;
  }

  records.forEach(printRecordLine);
  console.log(c('gray', '  ' + '─'.repeat(90)));
  console.log(`  ${records.length} record(s) shown\n`);
}

function cmdShow() {
  const id = parseInt(argValue('--id'), 10);
  if (!id) die('--id <number> is required.');

  const db     = loadDB();
  const record = db.get(id);
  if (!record) die(`No record with ID ${id}.`);

  console.log(`\n${c('bold', `Record ${record.id} — ${record.name} (${record.version})`)}`);
  console.log(`  Type   : ${record.type}`);
  console.log(`  Date   : ${fmtDate(record.date)}`);
  console.log(`  Source : ${record.source}`);
  console.log(`  Tags   : ${(record.tags || []).join(', ') || '—'}`);
  console.log(`\n${c('gray','  Data:')}`);
  console.log(JSON.stringify(record.data, null, 2).replace(/^/gm, '  '));
  console.log('');
}

function cmdAudit() {
  const db = loadDB();

  let results = db.auditAll();
  const nameFilter = argValue('--name');
  if (nameFilter) results = results.filter(r => r.proFormaRecord.name === nameFilter);

  console.log(`\n${c('bold','Conformance Audit')}  ${c('gray', `(${results.length} comparison(s))`)}`);

  if (results.length === 0) {
    console.log(`  ${c('yellow','No matching pairs.')}  Add both a pro forma and a term sheet with the same name.\n`);
    return;
  }

  for (const { proFormaRecord: pf, termSheetRecord: ts, conformance: cf } of results) {
    const overallOk = cf.conformant;
    const sym = overallOk ? c('green','✓') : c('red','✗');
    console.log(`\n  ${sym} ${c('bold', pf.name)}`);
    console.log(`     Pro forma : v${pf.version}  (${fmtDate(pf.date)})`);
    console.log(`     Term sheet: v${ts.version}  (${fmtDate(ts.date)})`);
    console.log(c('gray', '     ' + '─'.repeat(70)));

    for (const ck of cf.checks) {
      const icon    = ck.pass ? c('green','✓') : (ck.severity === 'error' ? c('red','✗') : c('yellow','⚠'));
      const lbl     = ck.label.padEnd(28, ' ');
      const detail  = ck.pass
        ? c('dim', `${ck.expectedFmt}`)
        : c(ck.severity === 'error' ? 'red' : 'yellow',
            `expected ${ck.expectedFmt}  →  got ${ck.actualFmt}${ck.note ? '  (' + ck.note + ')' : ''}`);
      console.log(`     ${icon} ${lbl}  ${detail}`);
    }

    if (cf.missingInstruments && cf.missingInstruments.length) {
      console.log(`     ${c('red','✗')} Missing instruments: ${cf.missingInstruments.join(', ')}`);
    }
    if (cf.extraInstruments && cf.extraInstruments.length) {
      console.log(`     ${c('yellow','⚠')} Extra instruments: ${cf.extraInstruments.join(', ')}`);
    }
  }
  console.log('');
}

function cmdDiff() {
  const name = argValue('--name');
  if (!name) die('--name "Deal Name" is required.');

  const db       = loadDB();
  const diffs    = db.diffAll().filter(d => d.name === name);

  if (diffs.length === 0) {
    die(`No consecutive pro forma versions found for "${name}". Store at least two versions first.`);
  }

  console.log(`\n${c('bold', `Version Diffs — ${name}`)}\n`);

  for (const { from, to, diff: d } of diffs) {
    console.log(`  ${c('cyan', from)} → ${c('cyan', to)}`);
    console.log(c('gray', '  ' + '─'.repeat(64)));

    // Economics
    if (d.economics) {
      for (const [field, change] of Object.entries(d.economics)) {
        if (change.from === change.to) continue;
        const arrow = c('gray', '→');
        console.log(`  ${c('dim', field.padEnd(22))} ${change.fromFmt} ${arrow} ${c('bold', change.toFmt)}`);
      }
    }

    // Ownership changes
    if (d.ownership && d.ownership.length) {
      console.log(`\n  ${c('gray','Ownership changes:')}`);
      for (const o of d.ownership) {
        const pct  = (o.delta * 100).toFixed(2);
        const sign = o.delta >= 0 ? c('green', `+${pct}%`) : c('red', `${pct}%`);
        console.log(`    ${o.name.padEnd(28)} ${sign}`);
      }
    }

    // Issues
    if (d.issues) {
      if (d.issues.resolved && d.issues.resolved.length)
        console.log(`\n  ${c('green','Resolved:')} ${d.issues.resolved.map(i => i.code).join(', ')}`);
      if (d.issues.introduced && d.issues.introduced.length)
        console.log(`  ${c('red','Introduced:')} ${d.issues.introduced.map(i => i.code).join(', ')}`);
    }

    console.log('');
  }
}

function cmdImport() {
  const raw    = readJSON('--file', 'import');
  const dryRun = hasFlag('--dry-run');

  const proformas  = Array.isArray(raw.proformas)  ? raw.proformas  : [];
  const termsheets = Array.isArray(raw.termsheets) ? raw.termsheets : [];

  if (proformas.length === 0 && termsheets.length === 0) {
    die('Import file must have a "proformas" array, a "termsheets" array, or both.');
  }

  console.log(`\n${c('bold','Bulk Import')}${dryRun ? c('yellow','  [DRY RUN — not writing to DB]') : ''}`);
  console.log(`  File       : ${argValue('--file')}`);
  console.log(`  Pro formas : ${proformas.length}`);
  console.log(`  Term sheets: ${termsheets.length}`);
  console.log(c('gray', '  ' + '─'.repeat(64)));

  const db = dryRun ? C.createDatabase() : loadDB();
  let pfOk = 0, pfFail = 0, tsOk = 0, tsFail = 0;

  // ── Pro formas ──
  for (let i = 0; i < proformas.length; i++) {
    const deal = proformas[i];
    const label = deal.name || `proformas[${i}]`;

    if (!deal.name)         { console.log(`  ${c('red','✗')} ${label}: missing "name"`);         pfFail++; continue; }
    if (!deal.stakeholders) { console.log(`  ${c('red','✗')} ${label}: missing "stakeholders"`); pfFail++; continue; }
    if (!deal.config)       { console.log(`  ${c('red','✗')} ${label}: missing "config"`);       pfFail++; continue; }

    let result, analysis;
    try {
      result   = E.buildProForma(deal.stakeholders, deal.config, deal.options || {});
      analysis = E.analyzeProForma(result, deal.stakeholders, deal.config);
    } catch (err) {
      console.log(`  ${c('red','✗')} ${label}: engine error — ${err.message}`);
      pfFail++;
      continue;
    }

    const version = deal.version || 'v1';
    const tags    = Array.isArray(deal.tags) ? deal.tags : [];
    const meta    = { date: deal.date, source: deal.source, tags };

    if (!dryRun) db.add('proforma', deal.name, version, { ...result, analysis }, meta);

    const statusStr = fmtStatus(analysis.summary.status);
    const warn = analysis.summary.warningCount ? c('yellow', ` ⚠${analysis.summary.warningCount}`) : '';
    const err_ = analysis.summary.issueCount   ? c('red',    ` ✗${analysis.summary.issueCount}`)   : '';
    console.log(`  ${c('green','✓')} [proforma ] ${c('white', label.padEnd(36))} v${version.padEnd(16)} ${statusStr}${warn}${err_}`);
    pfOk++;
  }

  // ── Term sheets ──
  for (let i = 0; i < termsheets.length; i++) {
    const ts = termsheets[i];
    const label = ts.name || `termsheets[${i}]`;

    if (!ts.name) { console.log(`  ${c('red','✗')} ${label}: missing "name"`); tsFail++; continue; }

    let normalized;
    try {
      normalized = C.normalizeTermSheet(ts);
    } catch (err) {
      console.log(`  ${c('red','✗')} ${label}: normalization error — ${err.message}`);
      tsFail++;
      continue;
    }

    const version = ts.version || 'signed';
    const tags    = Array.isArray(ts.tags) ? ts.tags : [];
    const meta    = { date: ts.date, source: ts.source, tags };

    if (!dryRun) db.add('termsheet', ts.name, version, normalized, meta);

    const pre = ts.preMoneyValuation ? c('dim', `  pre-$${(ts.preMoneyValuation/1e6).toFixed(1)}M`) : '';
    console.log(`  ${c('green','✓')} [termsheet] ${c('white', label.padEnd(36))} v${version.padEnd(16)}${pre}`);
    tsOk++;
  }

  if (!dryRun) saveDB(db);

  console.log(c('gray', '  ' + '─'.repeat(64)));
  const totalOk   = pfOk + tsOk;
  const totalFail = pfFail + tsFail;
  if (totalFail === 0) {
    console.log(`  ${c('green', `✓ ${totalOk} record(s) imported successfully`)}  DB file: ${dbFile}  (${db.size} total)\n`);
  } else {
    console.log(`  ${c('green', `${totalOk} imported`)}  ${c('red', `${totalFail} failed`)}\n`);
    process.exit(1);
  }
}

function cmdExport() {
  const db      = loadDB();
  const outPath = path.resolve(process.cwd(), argValue('--out') || 'export.json');
  fs.writeFileSync(outPath, db.toJSON(), 'utf8');
  console.log(c('green', `\n✓ Exported ${db.size} records to ${outPath}\n`));
}

function cmdDelete() {
  const id = parseInt(argValue('--id'), 10);
  if (!id) die('--id <number> is required.');

  const db = loadDB();
  const record = db.get(id);
  if (!record) die(`No record with ID ${id}.`);

  // fromJSON/toJSON re-builds from scratch; filter out the record
  const parsed = JSON.parse(db.toJSON());
  parsed.records = parsed.records.filter(r => r.id !== id);
  const newDb = C.createDatabase();
  newDb.fromJSON(JSON.stringify(parsed));
  saveDB(newDb);

  console.log(c('green', `\n✓ Deleted record ${id}: "${record.name}" (${record.type})\n`));
}

function cmdHelp() {
  console.log(`
${c('bold','NVCA Database Manager')}

${c('cyan','add-proforma')}  --file deal.json       [--version v1] [--tags draft,final]
${c('cyan','add-termsheet')} --file termsheet.json  [--version signed] [--tags loi]
${c('cyan','import')}        --file bulk.json       [--dry-run]
${c('cyan','list')}                                 [--type proforma|termsheet] [--name "..."] [--tags ...]
${c('cyan','show')}          --id 3
${c('cyan','audit')}                                [--name "Deal Name"]
${c('cyan','diff')}          --name "Deal Name"
${c('cyan','export')}                               [--out export.json]
${c('cyan','delete')}        --id 3

Global options:
  --db <path>    Database file  (default: database.json)
  --no-color     Plain output

See the top of manage-db.js for full JSON schemas.
`);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
switch (command) {
  case 'add-proforma':  cmdAddProforma();  break;
  case 'add-termsheet': cmdAddTermSheet(); break;
  case 'import':        cmdImport();       break;
  case 'list':          cmdList();         break;
  case 'show':          cmdShow();         break;
  case 'audit':         cmdAudit();        break;
  case 'diff':          cmdDiff();         break;
  case 'export':        cmdExport();       break;
  case 'delete':        cmdDelete();       break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:       cmdHelp();         break;
  default:
    die(`Unknown command: "${command}". Run without arguments for help.`);
}
