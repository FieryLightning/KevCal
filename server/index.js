// KevCal server. Local-first by design: it binds to your machine, stores
// everything under ./data, and makes no outbound request unless you switch on
// the optional AI tier.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, DATA_DIR, getSetting } from './db.js';
import { json, notFound, badRequest, serveFile, safeJoin } from './lib/http.js';
import { ocrAvailable } from './extract/index.js';
import { aiAvailable } from './extract/anthropic.js';
import * as api from './api.js';

const PORT = Number(process.env.KEVCAL_PORT || process.env.PORT || 4321);
const HOST = process.env.KEVCAL_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Route table: [method, pattern, handler]. `:param` captures a segment. */
const routes = [
  ['POST',   '/api/capture',                 (req, res) => api.captureHandler(req, res)],
  ['GET',    '/api/batches',                 (req, res) => api.listBatches(req, res)],
  ['GET',    '/api/batches/:id',             (req, res, p) => api.getBatchHandler(req, res, p.id)],
  ['POST',   '/api/batches/:id/commit',      (req, res, p) => api.commitBatch(req, res, p.id)],
  ['POST',   '/api/batches/:id/undo',        (req, res, p) => api.undoBatch(req, res, p.id)],
  ['POST',   '/api/batches/:id/redo',        (req, res, p) => api.redoBatch(req, res, p.id)],
  ['POST',   '/api/batches/:id/apply-diff',  (req, res, p) => api.applyDiff(req, res, p.id)],
  ['DELETE', '/api/batches/:id',             (req, res, p) => api.deleteBatch(req, res, p.id)],
  ['GET',    '/api/source/:id',              (req, res, p) => api.sourceImage(req, res, p.id)],
  ['PATCH',  '/api/items/:id',               (req, res, p) => api.patchItem(req, res, p.id)],
  ['POST',   '/api/items/:id/recurrence',    (req, res, p) => api.acceptRecurrence(req, res, p.id)],
  ['POST',   '/api/items/bulk',              (req, res) => api.bulkItems(req, res)],
  ['GET',    '/api/agenda',                  (req, res, p, url) => api.agenda(req, res, url)],
  ['GET',    '/api/export.ics',              (req, res, p, url) => api.exportICS(req, res, url)],
  ['POST',   '/api/open-ics',                (req, res) => api.openInCalendar(req, res)],
  ['GET',    '/api/share/text',              (req, res, p, url) => api.shareTextHandler(req, res, url)],
  ['GET',    '/api/shares',                  (req, res) => api.listShares(req, res)],
  ['POST',   '/api/shares',                  (req, res) => api.createShare(req, res)],
  ['POST',   '/api/shares/:id/revoke',       (req, res, p) => api.revokeShare(req, res, p.id)],
  ['GET',    '/api/settings',                (req, res) => api.settingsHandler(req, res)],
  ['POST',   '/api/settings',                (req, res) => api.settingsHandler(req, res)],
  ['GET',    '/api/anchors',                 (req, res) => api.anchorsHandler(req, res)],
  ['POST',   '/api/anchors',                 (req, res) => api.anchorsHandler(req, res)],
  ['GET',    '/api/stats',                   (req, res) => api.stats(req, res)],
  ['GET',    '/api/health',                  (req, res) => json(res, 200, {
    ok: true,
    ocr: ocrAvailable(),
    ai_key_present: aiAvailable(),
    ai_enabled: getSetting('ai_enabled', false),
    data_dir: DATA_DIR,
  })],
];

function matchRoute(method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pParts = pattern.split('/');
    const uParts = pathname.split('/');
    if (pParts.length !== uParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = decodeURIComponent(uParts[i]);
      else if (pParts[i] !== uParts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // Shared lists: /s/<token> reads as JSON, /s/<token>.ics subscribes.
    if (pathname.startsWith('/s/')) {
      const raw = pathname.slice(3);
      const isICS = raw.endsWith('.ics');
      return api.serveShare(req, res, isICS ? raw.slice(0, -4) : raw, isICS);
    }

    const route = matchRoute(req.method, pathname);
    if (route) return await route.handler(req, res, route.params, url);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = safeJoin(PUBLIC_DIR, rel);
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return serveFile(res, file, { cache: 'no-cache' });
      }
      // Unknown GET falls through to the app shell so deep links work.
      const shell = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(shell)) return serveFile(res, shell, { cache: 'no-cache' });
    }

    notFound(res, `no route for ${req.method} ${pathname}`);
  } catch (e) {
    console.error('[kevcal] error:', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const ai = aiAvailable();
  console.log('');
  console.log('  KevCal');
  console.log('  ──────');
  console.log(`  On this Mac   http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  On your phone http://${addr}:${PORT}   (same wifi)`);
  }
  console.log('');
  console.log(`  Data          ${DATA_DIR}`);
  console.log(`  Reading       ${ocrAvailable() ? 'on-device (Apple Vision) + date grammar' : 'TEXT ONLY — run: npm run build:tools'}`);
  console.log(`  AI tier       ${ai ? (getSetting('ai_enabled', false) ? 'ON — images are sent to api.anthropic.com' : 'available but OFF') : 'no API key set (not needed)'}`);
  console.log(`  Outbound      ${ai && getSetting('ai_enabled', false) ? 'api.anthropic.com only, when you import' : 'nothing leaves this machine'}`);
  console.log('');
});
