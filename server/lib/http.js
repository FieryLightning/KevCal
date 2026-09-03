// Tiny HTTP helpers. No framework: keeping KevCal dependency-free means
// `node server/index.js` works on a clean machine with no install step.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.ics': 'text/calendar; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(status, { 'content-length': payload.length, ...headers });
  res.end(payload);
}

export function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'content-type': MIME['.json'] });
}

export function notFound(res, what = 'not found') {
  json(res, 404, { error: what });
}

export function badRequest(res, why) {
  json(res, 400, { error: why });
}

/** A body that blew the size cap deserves 413, not a confusing 400. */
export function fromBodyError(res, e) {
  if (/too large/i.test(e.message)) {
    return json(res, 413, { error: 'that file is too big — 40 MB is the limit' });
  }
  return badRequest(res, e.message);
}

const MAX_BODY = 40 * 1024 * 1024; // generous: a multi-page PDF as base64

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('invalid JSON body'); }
}

export function serveFile(res, filePath, { download = null, cache = 'no-store' } = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return notFound(res, 'file not found'); }
  if (!stat.isFile()) return notFound(res, 'not a file');
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
  };
  if (download) headers['content-disposition'] = `attachment; filename="${download.replace(/"/g, '')}"`;
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

/** Guards against path traversal when serving from a directory. */
export function safeJoin(root, requested) {
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.sep + requested);
  // Compare against base + separator so a sibling directory named 'public-x'
  // cannot satisfy a plain startsWith check.
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export { MIME };
