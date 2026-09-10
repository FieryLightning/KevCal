// KevCal server.
//
// v1 bound to the LAN and assumed the Mac would be awake on the same wifi when
// the letter was in your hand. That assumption was the riskiest part of the
// whole design and it is the one that failed, so v2 is built to sit behind a
// tunnel and be reachable from anywhere — which means it now needs a lock on
// the door. Set KEVCAL_TOKEN and every request must carry it.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';

// Before anything reads process.env.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
loadEnv(path.join(REPO, '.env'));

const { ROOT, DATA_DIR, getSetting } = await import('./db.js');
const { json, notFound, serveFile, safeJoin, send } = await import('./lib/http.js');
const { ocrAvailable, readerAvailable, readerName, readerModel } = await import('./extract/index.js');
const api = await import('./api.js');

const PORT = Number(process.env.KEVCAL_PORT || process.env.PORT || 4321);
const HOST = process.env.KEVCAL_HOST || '0.0.0.0';
const TOKEN = process.env.KEVCAL_TOKEN || null;
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Route table: [method, pattern, handler]. `:param` captures a segment. */
const routes = [
  ['POST',   '/api/capture',                 (req, res) => api.captureHandler(req, res)],
  ['POST',   '/api/quick',                   (req, res) => api.quickCapture(req, res)],
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
    reader: readerAvailable() ? readerName() : (ocrAvailable() ? 'on-device' : 'text-only'),
    reader_available: readerAvailable(),
    reader_model: readerModel(),
    ocr: ocrAvailable(),
    locked: Boolean(TOKEN),
    data_dir: DATA_DIR,
  })],
];

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Two cheap checks close the cross-site hole without breaking the app's own
 * fetches: a mutating API call must declare application/json, and a present
 * Origin must match the host being addressed. Without this, any page in any
 * browser could delete your imports or publish a share link.
 */
function crossSiteRejected(req, res, pathname) {
  if (!MUTATING.has(req.method)) return false;
  if (!pathname.startsWith('/api/')) return false;

  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!originHost || originHost !== req.headers.host) {
      json(res, 403, { error: 'cross-site request refused' });
      return true;
    }
  }

  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if (hasBody) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      json(res, 415, { error: 'send this as application/json' });
      return true;
    }
  }
  return false;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Constant-time-ish compare so the token cannot be guessed a character at a time. */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const LOCK_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KevCal</title>
<style>
  body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;
       min-height:100vh;background:#12121a;color:#e9e9f0;text-align:center;padding:24px}
  .k{font-size:44px;margin-bottom:8px}
  p{opacity:.65;max-width:30ch}
</style>
<div><div class="k">🔒</div><h1>KevCal</h1>
<p>Add your key to the address to get in — the link on your phone's home screen already has it.</p></div>`;

/**
 * A bearer token in a cookie. Not an identity system and not pretending to be:
 * it is the difference between "anyone who finds the tunnel URL can read your
 * children's school letters" and "you need the link you saved".
 */
function unlocked(req, res, url) {
  if (!TOKEN) return true;
  const supplied = url.searchParams.get('k')
    || req.headers['x-kevcal-token']
    || cookies(req).kc_token;
  if (sameToken(supplied || '', TOKEN)) {
    if (url.searchParams.get('k')) {
      res.setHeader('set-cookie',
        `kc_token=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    }
    return true;
  }
  if (url.pathname.startsWith('/api/')) json(res, 401, { error: 'unauthorised' });
  else send(res, 401, LOCK_PAGE, { 'content-type': 'text/html; charset=utf-8' });
  return false;
}

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
    // Shared lists carry their own unguessable token and are deliberately public;
    // that is the entire point of sharing one.
    if (pathname.startsWith('/s/')) {
      const raw = pathname.slice(3);
      const isICS = raw.endsWith('.ics');
      return api.serveShare(req, res, isICS ? raw.slice(0, -4) : raw, isICS);
    }

    if (!unlocked(req, res, url)) return;
    if (crossSiteRejected(req, res, pathname)) return;

    const route = matchRoute(req.method, pathname);
    if (route) return await route.handler(req, res, route.params, url);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = safeJoin(PUBLIC_DIR, rel);
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return serveFile(res, file, { cache: 'no-cache' });
      }
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
  const suffix = TOKEN ? `/?k=${TOKEN}` : '';
  console.log('');
  console.log('  KevCal');
  console.log('  ──────');
  console.log(`  On this Mac    http://localhost:${PORT}${suffix}`);
  for (const addr of lanAddresses()) {
    console.log(`  On your phone  http://${addr}:${PORT}${suffix}   (same wifi)`);
  }
  console.log('');
  const READER_LABEL = { gemini: 'Google Gemini', openai: 'OpenAI' };
  const reading = !readerAvailable()
    ? 'NO API KEY — falling back to on-device reading. Put GEMINI_API_KEY or OPENAI_API_KEY in .env'
    : readerName() === 'fixture'
      ? 'a recorded fixture (test mode) — nothing is uploaded anywhere'
      : `${READER_LABEL[readerName()] || readerName()} (${readerModel() || '—'}) — pages are uploaded to read them`;
  console.log(`  Reading        ${reading}`);
  console.log(`  Cross-check    ${ocrAvailable() ? 'on-device OCR + date grammar' : 'date grammar only (run: npm run build:tools)'}`);
  console.log(`  Door           ${TOKEN ? 'locked — the link needs ?k=…' : 'OPEN — set KEVCAL_TOKEN before putting this on a tunnel'}`);
  console.log(`  Data           ${DATA_DIR}`);
  console.log('');
});
