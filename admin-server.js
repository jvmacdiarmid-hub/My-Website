#!/usr/bin/env node
/**
 * admin-server.js — NVCA Pro Forma Admin Portal
 *
 * Local Express server that:
 *   1. Serves proforma-admin.html at http://localhost:3747
 *   2. Accepts upload of three files (term sheet, precedent Excel, builder Excel)
 *   3. Runs the semantic Excel comparison and returns a structured diff
 *   4. Generates code patches for proforma.html
 *   5. Applies high-confidence patches with an automatic backup
 *
 * Usage:
 *   node admin-server.js            # starts on port 3747
 *   node admin-server.js --port 4000
 */
'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const XLSX     = require('xlsx');

const { parseWorkbook, compareWorkbooks, generatePatches, applyPatches, parseTermSheet } =
  require('./proforma-excel-compare.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const PORT         = +(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || 3747);
const ROOT         = __dirname;
const UPLOADS_DIR  = path.join(ROOT, 'uploads');
const BUILDER_FILE = path.join(ROOT, 'proforma.html');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY SESSION STORE  (comparison results, keyed by UUID)
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();   // id → { termSheet, precWb, bldWb, diff, patches, createdAt }

// Expire sessions after 2 hours to keep memory clean
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, sess] of sessions) {
    if (sess.createdAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// MULTER — file upload storage
// ─────────────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max per file
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv|pdf|docx|doc|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error(`Unsupported file type: ${file.originalname}`), ok);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve static files from root (proforma.html, styles.css, etc.)
app.use(express.static(ROOT));

// ─── GET / ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'proforma-admin.html'));
});

// ─── POST /api/upload ────────────────────────────────────────────────────────
// Accept up to 3 named files: termSheet, precedentExcel, builderExcel
app.post(
  '/api/upload',
  upload.fields([
    { name: 'termSheet',     maxCount: 1 },
    { name: 'precedentExcel', maxCount: 1 },
    { name: 'builderExcel',  maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const files = req.files || {};
      const id    = uuidv4();
      const sess  = { createdAt: Date.now(), files: {} };

      if (files.termSheet)      sess.files.termSheet      = files.termSheet[0];
      if (files.precedentExcel) sess.files.precedentExcel = files.precedentExcel[0];
      if (files.builderExcel)   sess.files.builderExcel   = files.builderExcel[0];

      sessions.set(id, sess);

      res.json({
        ok: true,
        sessionId: id,
        uploaded: Object.keys(sess.files),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ─── POST /api/compare ───────────────────────────────────────────────────────
// Run the comparison for a session. Both precedentExcel and builderExcel must
// have been uploaded first.
app.post('/api/compare', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    const sess = sessions.get(sessionId);
    if (!sess) return res.status(404).json({ ok: false, error: 'Session not found' });

    if (!sess.files.precedentExcel)
      return res.status(400).json({ ok: false, error: 'Precedent Excel not uploaded' });
    if (!sess.files.builderExcel)
      return res.status(400).json({ ok: false, error: 'Builder Excel not uploaded' });

    // ── Parse Excel files ──────────────────────────────────────────
    const precBuf = fs.readFileSync(sess.files.precedentExcel.path);
    const bldBuf  = fs.readFileSync(sess.files.builderExcel.path);

    const precWbRaw = XLSX.read(precBuf, { type: 'buffer', cellFormula: true, cellStyles: true });
    const bldWbRaw  = XLSX.read(bldBuf,  { type: 'buffer', cellFormula: true, cellStyles: true });

    const precParsed = parseWorkbook(precWbRaw, XLSX);
    const bldParsed  = parseWorkbook(bldWbRaw,  XLSX);

    // ── Parse term sheet (if uploaded) ────────────────────────────
    let termSheetData = null;
    if (sess.files.termSheet) {
      try {
        const tsBuf = fs.readFileSync(sess.files.termSheet.path);
        const tsExt = path.extname(sess.files.termSheet.originalname).toLowerCase();
        if (tsExt === '.xlsx' || tsExt === '.xls') {
          // Read as text: concatenate all cell values
          const tsWb = XLSX.read(tsBuf, { type: 'buffer' });
          const rows = XLSX.utils.sheet_to_json(tsWb.Sheets[tsWb.SheetNames[0]], { header: 1, defval: '' });
          const text = rows.map(r => r.join(' ')).join('\n');
          termSheetData = parseTermSheet(text);
        } else {
          // Treat as plain text (txt, docx converted to text, pdf text layer)
          termSheetData = parseTermSheet(tsBuf.toString('utf8', 0, Math.min(tsBuf.length, 500000)));
        }
      } catch (_) { /* term sheet parsing is best-effort */ }
    }

    // ── Run comparison ────────────────────────────────────────────
    const diff = compareWorkbooks(precParsed, bldParsed);

    // ── Generate patches ──────────────────────────────────────────
    const builderSrc = fs.existsSync(BUILDER_FILE)
      ? fs.readFileSync(BUILDER_FILE, 'utf8')
      : '';
    const patches = generatePatches(diff, builderSrc);

    // Store results
    sess.precParsed   = precParsed;
    sess.bldParsed    = bldParsed;
    sess.diff         = diff;
    sess.patches      = patches;
    sess.termSheetData = termSheetData;

    // ── Build summary stats ───────────────────────────────────────
    const conformanceScore = diff.summary.totalCells > 0
      ? Math.round((diff.summary.matching / diff.summary.totalCells) * 100)
      : 0;

    res.json({
      ok: true,
      sessionId,
      conformanceScore,
      summary: diff.summary,
      missingInBuilder: diff.missingInBuilder,
      extraInBuilder:   diff.extraInBuilder,
      sheetCount: {
        precedent: precParsed.sheetNames.length,
        builder:   bldParsed.sheetNames.length,
      },
      sheets: diff.sheetComparisons.map(sc => ({
        precedentName: sc.precedentName,
        builderName:   sc.builderName,
        nameMismatch:  sc.nameMismatch,
        missingRows:   sc.missingRows.length,
        extraRows:     sc.extraRows.length,
        cellDiffs:     sc.cellDiffs.length,
        styleDiffs:    sc.styleDiffs.length,
        totalCells:    sc.totalCells,
        matching:      sc.matching,
      })),
      patchCount: {
        total:        patches.length,
        searchReplace: patches.filter(p => p.type === 'search_replace').length,
        manual:        patches.filter(p => p.type === 'manual').length,
        high:          patches.filter(p => p.severity === 'high').length,
      },
      termSheetData,
    });
  } catch (err) {
    console.error('[compare]', err);
    res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
});

// ─── GET /api/diff/:sessionId ─────────────────────────────────────────────────
// Return the full diff detail for a session (can be large).
app.get('/api/diff/:sessionId', (req, res) => {
  const sess = sessions.get(req.params.sessionId);
  if (!sess || !sess.diff) return res.status(404).json({ ok: false, error: 'No diff for this session' });
  res.json({ ok: true, diff: sess.diff });
});

// ─── GET /api/patches/:sessionId ─────────────────────────────────────────────
// Return all patches for a session.
app.get('/api/patches/:sessionId', (req, res) => {
  const sess = sessions.get(req.params.sessionId);
  if (!sess || !sess.patches) return res.status(404).json({ ok: false, error: 'No patches for this session' });
  res.json({ ok: true, patches: sess.patches });
});

// ─── POST /api/patch/preview ─────────────────────────────────────────────────
// Preview what the builder source will look like after applying selected patches.
app.post('/api/patch/preview', (req, res) => {
  try {
    const { sessionId, patchIndices } = req.body;
    const sess = sessions.get(sessionId);
    if (!sess?.patches) return res.status(404).json({ ok: false, error: 'Session not found' });

    const src = fs.readFileSync(BUILDER_FILE, 'utf8');
    const selected = (patchIndices || []).map(i => sess.patches[i]).filter(Boolean);
    const { src: modified, applied, skipped } = applyPatches(src, selected);

    // Return only the diff lines to keep the response small
    const srcLines = src.split('\n');
    const modLines = modified.split('\n');
    const changedLines = [];
    for (let i = 0; i < Math.max(srcLines.length, modLines.length); i++) {
      if (srcLines[i] !== modLines[i]) {
        changedLines.push({ line: i + 1, before: srcLines[i], after: modLines[i] });
      }
    }

    res.json({ ok: true, changedLines, appliedCount: applied.length, skippedCount: skipped.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/patch/apply ───────────────────────────────────────────────────
// Apply selected patches to proforma.html (with automatic backup).
app.post('/api/patch/apply', (req, res) => {
  try {
    const { sessionId, patchIndices } = req.body;
    const sess = sessions.get(sessionId);
    if (!sess?.patches) return res.status(404).json({ ok: false, error: 'Session not found' });

    const src = fs.readFileSync(BUILDER_FILE, 'utf8');

    // ── Backup ──────────────────────────────────────────────────────
    const backupPath = BUILDER_FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(backupPath, src, 'utf8');

    // ── Apply ───────────────────────────────────────────────────────
    const selected = (patchIndices || []).map(i => sess.patches[i]).filter(Boolean);
    const { src: modified, applied, skipped } = applyPatches(src, selected);

    fs.writeFileSync(BUILDER_FILE, modified, 'utf8');

    res.json({
      ok: true,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      backupPath,
      applied: applied.map(p => p.description),
      skipped: skipped.map(s => ({ description: s.patch.description, reason: s.reason })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/backups ──────────────────────────────────────────────────────
// List available backups of proforma.html.
app.get('/api/backups', (_req, res) => {
  const files = fs.readdirSync(ROOT)
    .filter(f => f.startsWith('proforma.html.bak-'))
    .sort()
    .reverse()
    .map(f => ({ name: f, path: path.join(ROOT, f), size: fs.statSync(path.join(ROOT, f)).size }));
  res.json({ ok: true, backups: files });
});

// ─── POST /api/restore ────────────────────────────────────────────────────
// Restore proforma.html from a backup.
app.post('/api/restore', (req, res) => {
  try {
    const { backupName } = req.body;
    if (!backupName || !backupName.startsWith('proforma.html.bak-'))
      return res.status(400).json({ ok: false, error: 'Invalid backup name' });
    const backupPath = path.join(ROOT, backupName);
    if (!fs.existsSync(backupPath))
      return res.status(404).json({ ok: false, error: 'Backup not found' });
    fs.copyFileSync(backupPath, BUILDER_FILE);
    res.json({ ok: true, restoredFrom: backupName });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  NVCA Pro Forma Admin Portal`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  URL:  http://localhost:${PORT}`);
  console.log(`  Root: ${ROOT}`);
  console.log(`  Builder: ${BUILDER_FILE}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
