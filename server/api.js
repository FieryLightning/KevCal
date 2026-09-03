// API handlers. The Batch is the organising idea: it is simultaneously the unit
// of undo, re-import/diff, bulk edit and sharing, which is what makes "correct,
// delete and share a list in one operation" a single concept instead of four.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { db, id, nowISO, log, getSetting, setSetting, ORIGINALS_DIR, DATA_DIR, DEFAULT_LEAD_DAYS } from './db.js';
import { extract, assessRisk } from './extract/index.js';
import { aiAvailable } from './extract/anthropic.js';
import { buildICS } from './lib/ics.js';
import { diffItems, describeDiff } from './lib/diff.js';
import { json, badRequest, notFound, readJSON, serveFile } from './lib/http.js';
import { today, addDays, formatHuman, formatTime, daysBetween } from './lib/dates.js';

const ITEM_COLUMNS = [
  'kind', 'title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day',
  'location', 'owner', 'cost', 'notes', 'confidence', 'needs_review', 'reviewed',
  'status', 'satisfied', 'satisfied_at', 'lead_days', 'recurrence_suggestion',
  'recurrence_accepted', 'rrule', 'question', 'heading', 'src_page', 'src_bbox',
  'src_raw', 'src_interpretation', 'fingerprint', 'user_edited', 'derived_from',
];

const EDITABLE = new Set([
  'kind', 'title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day',
  'location', 'owner', 'cost', 'notes', 'lead_days', 'satisfied',
]);

// Columns declared NOT NULL with a DEFAULT: passing an explicit NULL bypasses the
// default, so supply it here for fields the extractor legitimately leaves unset.
const COLUMN_DEFAULTS = {
  all_day: 1, confidence: 0.5, needs_review: 0, reviewed: 0, status: 'pending',
  satisfied: 0, recurrence_accepted: 0, user_edited: 0,
};

function insertItems(batchId, items) {
  const stmt = db.prepare(`
    INSERT INTO items (id, batch_id, ${ITEM_COLUMNS.join(', ')}, created_at, updated_at)
    VALUES (?, ?, ${ITEM_COLUMNS.map(() => '?').join(', ')}, ?, ?)
  `);
  const at = nowISO();
  const out = [];
  for (const it of items) {
    const itemId = id('i_');
    const values = ITEM_COLUMNS.map((c) => {
      let v = it[c];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (v === undefined || v === null) v = COLUMN_DEFAULTS[c] ?? null;
      return v;
    });
    stmt.run(itemId, batchId, ...values, at, at);
    out.push(itemId);
  }
  return out;
}

function getItems(batchId) {
  return db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY needs_review DESC, confidence ASC, start_date ASC').all(batchId);
}

function getBatch(batchId) {
  return db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
}

function leadDaysFor(item) {
  if (item.lead_days) {
    try { const v = JSON.parse(item.lead_days); if (Array.isArray(v)) return v; } catch { /* fall through */ }
  }
  const conf = getSetting('lead_days', { deadline: DEFAULT_LEAD_DAYS.deadline, event: DEFAULT_LEAD_DAYS.event });
  return item.kind === 'deadline' ? (conf.deadline ?? []) : (conf.event ?? []);
}

function decorate(item) {
  const lead = leadDaysFor(item);
  const daysLeft = item.start_date ? daysBetween(today(), item.start_date) : null;
  let runway = null;
  if (item.kind === 'deadline' && daysLeft != null && lead.length) {
    const window = Math.max(...lead, 1);
    runway = Math.max(0, Math.min(1, 1 - (daysLeft / window)));
  }
  return {
    ...item,
    lead_days_resolved: lead,
    days_left: daysLeft,
    runway,
    human_date: item.start_date ? formatHuman(item.start_date) : null,
    human_time: item.start_time ? formatTime(item.start_time) + (item.end_time ? `–${formatTime(item.end_time)}` : '') : null,
    recurrence: item.recurrence_suggestion ? safeParse(item.recurrence_suggestion) : null,
    bbox: item.src_bbox ? safeParse(item.src_bbox) : null,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------------------------------------------------------------- capture

export async function captureHandler(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }

  const kind = body.kind === 'text' ? 'text' : (body.filename || '').toLowerCase().endsWith('.pdf') ? 'pdf' : 'image';
  const reference = body.reference || today();
  const useAI = body.useAI ?? getSetting('ai_enabled', false);

  let filePath = null;
  let storedName = null;
  if (kind !== 'text') {
    if (!body.data) return badRequest(res, 'no image data supplied');
    const b64 = String(body.data).replace(/^data:[^;]+;base64,/, '');
    const ext = kind === 'pdf' ? '.pdf' : path.extname(body.filename || '') || '.png';
    storedName = `${id('src_')}${ext}`;
    filePath = path.join(ORIGINALS_DIR, storedName);
    try { fs.writeFileSync(filePath, Buffer.from(b64, 'base64')); }
    catch (e) { return badRequest(res, `could not save image: ${e.message}`); }
  } else if (!String(body.text || '').trim()) {
    return badRequest(res, 'no text supplied');
  }

  const anchor = body.anchorId
    ? anchorRow(db.prepare('SELECT * FROM anchors WHERE id = ?').get(body.anchorId))
    : anchorRow(db.prepare('SELECT * FROM anchors WHERE is_default = 1').get());

  let result;
  try {
    result = await extract({ kind, filePath, text: body.text, filename: body.filename, anchor, useAI, reference });
  } catch (e) {
    return json(res, 500, { error: `extraction failed: ${e.message}` });
  }

  const batchId = id('b_');
  const title = body.title
    || (kind === 'text' ? firstWords(body.text) : body.filename || 'Capture')
    || 'Capture';

  db.prepare(`
    INSERT INTO batches (id, title, source_kind, source_name, source_path, source_text,
                         source_w, source_h, engine, status, risk, parent_id, anchor_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    batchId, title, kind, body.filename ?? null, storedName, kind === 'text' ? body.text : null,
    result.page.width, result.page.height, result.engine, 'draft', result.risk,
    body.parentBatchId ?? null, result.anchor ? JSON.stringify(result.anchor) : null, nowISO(),
  );

  insertItems(batchId, result.items);
  log('capture', { batch_id: batchId, detail: { engine: result.engine, found: result.items.length, risk: result.risk } });

  const items = getItems(batchId).map(decorate);

  // A re-import diffs against its parent instead of duplicating it.
  let diff = null;
  if (body.parentBatchId) {
    const parentItems = getItems(body.parentBatchId).filter((i) => i.status !== 'rejected');
    const d = diffItems(parentItems, items);
    diff = { ...d, description: describeDiff(d) };
  }

  json(res, 200, {
    batch: getBatch(batchId),
    items,
    risk: result.risk,
    engine: result.engine,
    stats: result.stats,
    questions: result.questions,
    anchor: result.anchor,
    ocrError: result.ocrError,
    aiError: result.aiError,
    aiAvailable: result.aiAvailable,
    diff,
  });
}

function firstWords(text, n = 6) {
  return String(text || '').trim().split(/\s+/).slice(0, n).join(' ').slice(0, 60);
}

function anchorRow(row) {
  if (!row) return null;
  return {
    week1Start: row.week1_start,
    skipWeeks: safeParse(row.skip_weeks) || [],
    holidays: safeParse(row.holidays) || [],
    source: 'saved',
  };
}

// ---------------------------------------------------------------- batches

export function listBatches(req, res) {
  const rows = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id) AS item_count,
      (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.status = 'accepted') AS accepted_count,
      (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.needs_review = 1 AND i.reviewed = 0) AS unreviewed_count
    FROM batches b ORDER BY b.created_at DESC LIMIT 200
  `).all();
  json(res, 200, { batches: rows });
}

export function getBatchHandler(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  json(res, 200, { batch, items: getItems(batchId).map(decorate) });
}

export async function commitBatch(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  let body = {};
  try { body = await readJSON(req); } catch { /* optional */ }

  const items = getItems(batchId);
  const chosen = Array.isArray(body.itemIds) && body.itemIds.length
    ? items.filter((i) => body.itemIds.includes(i.id))
    : items.filter((i) => i.status !== 'rejected');

  // A low-confidence item cannot be committed until a human has touched it.
  const blocked = chosen.filter((i) => i.needs_review && !i.reviewed && !body.force);
  if (blocked.length) {
    return json(res, 409, {
      error: 'needs_review',
      message: `${blocked.length} item${blocked.length === 1 ? '' : 's'} still need checking.`,
      blocked: blocked.map((b) => ({ id: b.id, title: b.title, question: b.question })),
    });
  }

  const at = nowISO();
  const stmt = db.prepare("UPDATE items SET status='accepted', updated_at=? WHERE id=?");
  for (const i of chosen) stmt.run(at, i.id);
  db.prepare("UPDATE batches SET status='committed', committed_at=? WHERE id=?").run(at, batchId);
  log('commit', { batch_id: batchId, detail: { count: chosen.length } });

  json(res, 200, { ok: true, committed: chosen.length, batch: getBatch(batchId) });
}

/** One button that takes back an entire import — the single most requested feature. */
export function undoBatch(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  const at = nowISO();
  const n = db.prepare("UPDATE items SET status='rejected', updated_at=? WHERE batch_id=?").run(at, batchId).changes;
  db.prepare("UPDATE batches SET status='undone', undone_at=? WHERE id=?").run(at, batchId);
  log('undo', { batch_id: batchId, detail: { count: n } });
  json(res, 200, { ok: true, removed: n });
}

export function redoBatch(req, res, batchId) {
  const at = nowISO();
  const n = db.prepare("UPDATE items SET status='accepted', updated_at=? WHERE batch_id=? AND status='rejected'").run(at, batchId).changes;
  db.prepare("UPDATE batches SET status='committed', undone_at=NULL WHERE id=?").run(batchId);
  log('redo', { batch_id: batchId, detail: { count: n } });
  json(res, 200, { ok: true, restored: n });
}

export function deleteBatch(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  if (batch.source_path) {
    // Deleting an import deletes its source image; the privacy promise depends on it.
    try { fs.unlinkSync(path.join(ORIGINALS_DIR, batch.source_path)); } catch { /* already gone */ }
  }
  db.prepare('DELETE FROM items WHERE batch_id = ?').run(batchId);
  db.prepare('DELETE FROM shares WHERE batch_id = ?').run(batchId);
  db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
  log('delete_batch', { batch_id: batchId });
  json(res, 200, { ok: true });
}

export async function applyDiff(req, res, batchId) {
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }
  const { accept = [] } = body;   // [{op:'change'|'add'|'remove', targetId?, newItemId?}]
  const at = nowISO();
  let changed = 0, added = 0, removed = 0;

  for (const a of accept) {
    if (a.op === 'change' && a.targetId && a.newItemId) {
      const src = db.prepare('SELECT * FROM items WHERE id = ?').get(a.newItemId);
      if (!src) continue;
      db.prepare(`UPDATE items SET title=?, start_date=?, start_time=?, end_date=?, end_time=?,
                  all_day=?, location=?, src_interpretation=?, updated_at=? WHERE id=?`)
        .run(src.title, src.start_date, src.start_time, src.end_date, src.end_time,
             src.all_day, src.location, src.src_interpretation, at, a.targetId);
      changed++;
    } else if (a.op === 'add' && a.newItemId) {
      db.prepare("UPDATE items SET status='accepted', updated_at=? WHERE id=?").run(at, a.newItemId);
      added++;
    } else if (a.op === 'remove' && a.targetId) {
      db.prepare("UPDATE items SET status='superseded', updated_at=? WHERE id=?").run(at, a.targetId);
      removed++;
    }
  }
  db.prepare("UPDATE batches SET status='committed', committed_at=? WHERE id=?").run(at, batchId);
  log('apply_diff', { batch_id: batchId, detail: { changed, added, removed } });
  json(res, 200, { ok: true, changed, added, removed });
}

// ---------------------------------------------------------------- items

export async function patchItem(req, res, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return notFound(res, 'item not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(k === 'lead_days' && Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  if (!sets.length) return badRequest(res, 'no editable fields supplied');

  if ('satisfied' in body) {
    sets.push('satisfied_at = ?');
    vals.push(body.satisfied ? nowISO() : null);
  }
  // A human touched it, so it is no longer blocking the commit.
  sets.push('user_edited = 1', 'reviewed = 1', 'updated_at = ?');
  vals.push(nowISO(), itemId);

  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  log('edit_item', { item_id: itemId, batch_id: item.batch_id, detail: Object.keys(body).join(',') });
  json(res, 200, { ok: true, item: decorate(db.prepare('SELECT * FROM items WHERE id = ?').get(itemId)) });
}

export async function bulkItems(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return badRequest(res, 'no item ids supplied');
  const at = nowISO();
  const marks = ids.map(() => '?').join(',');
  let affected = 0;

  switch (body.op) {
    case 'accept':
      affected = db.prepare(`UPDATE items SET status='accepted', reviewed=1, updated_at=? WHERE id IN (${marks})`).run(at, ...ids).changes;
      break;
    case 'reject':
      affected = db.prepare(`UPDATE items SET status='rejected', reviewed=1, updated_at=? WHERE id IN (${marks})`).run(at, ...ids).changes;
      break;
    case 'review':
      affected = db.prepare(`UPDATE items SET reviewed=1, updated_at=? WHERE id IN (${marks})`).run(at, ...ids).changes;
      break;
    case 'satisfy':
      affected = db.prepare(`UPDATE items SET satisfied=1, satisfied_at=?, updated_at=? WHERE id IN (${marks})`).run(at, at, ...ids).changes;
      break;
    case 'unsatisfy':
      affected = db.prepare(`UPDATE items SET satisfied=0, satisfied_at=NULL, updated_at=? WHERE id IN (${marks})`).run(at, ...ids).changes;
      break;
    case 'set_kind': {
      const kind = body.kind === 'deadline' ? 'deadline' : 'event';
      affected = db.prepare(`UPDATE items SET kind=?, user_edited=1, updated_at=? WHERE id IN (${marks})`).run(kind, at, ...ids).changes;
      break;
    }
    case 'shift_days': {
      // "The whole thing moved by a week" — the most common real-world correction.
      const n = Number(body.days);
      if (!Number.isFinite(n) || n === 0) return badRequest(res, 'days must be a non-zero number');
      const rows = db.prepare(`SELECT id, start_date, end_date FROM items WHERE id IN (${marks})`).all(...ids);
      const upd = db.prepare('UPDATE items SET start_date=?, end_date=?, user_edited=1, reviewed=1, updated_at=? WHERE id=?');
      for (const r of rows) {
        upd.run(r.start_date ? addDays(r.start_date, n) : null,
                r.end_date ? addDays(r.end_date, n) : null, at, r.id);
        affected++;
      }
      break;
    }
    case 'set_lead': {
      const lead = Array.isArray(body.lead_days) ? JSON.stringify(body.lead_days) : null;
      affected = db.prepare(`UPDATE items SET lead_days=?, updated_at=? WHERE id IN (${marks})`).run(lead, at, ...ids).changes;
      break;
    }
    case 'delete':
      affected = db.prepare(`DELETE FROM items WHERE id IN (${marks})`).run(...ids).changes;
      break;
    default:
      return badRequest(res, `unknown bulk op: ${body.op}`);
  }

  log('bulk', { detail: { op: body.op, ids: ids.length, affected } });
  json(res, 200, { ok: true, affected });
}

/**
 * Accepting a recurrence suggestion is the ONLY way an RRULE is ever created.
 * Nothing in the extractor may write one.
 */
export async function acceptRecurrence(req, res, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return notFound(res, 'item not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }

  if (body.accept === false) {
    db.prepare('UPDATE items SET recurrence_accepted=0, rrule=NULL, reviewed=1, updated_at=? WHERE id=?').run(nowISO(), itemId);
    return json(res, 200, { ok: true, accepted: false });
  }

  const sug = safeParse(item.recurrence_suggestion) || {};
  const freq = body.freq || sug.freq || 'WEEKLY';
  const interval = Number(body.interval || sug.interval || 1);
  const until = body.until || null;
  const count = body.count ? Number(body.count) : null;
  if (!until && !count) {
    // Refusing an unbounded rule is deliberate: we never extrapolate past evidence.
    return badRequest(res, 'a repeat needs an end date or a number of occurrences');
  }
  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  const byday = body.byday || sug.byday;
  if (byday && freq === 'WEEKLY') parts.push(`BYDAY=${byday}`);
  if (until) parts.push(`UNTIL=${until.replace(/-/g, '')}T235959Z`);
  else if (count) parts.push(`COUNT=${count}`);

  db.prepare('UPDATE items SET recurrence_accepted=1, rrule=?, reviewed=1, user_edited=1, updated_at=? WHERE id=?')
    .run(parts.join(';'), nowISO(), itemId);
  log('accept_recurrence', { item_id: itemId, detail: parts.join(';') });
  json(res, 200, { ok: true, rrule: parts.join(';') });
}

// ---------------------------------------------------------------- agenda

export function agenda(req, res, url) {
  const from = url.searchParams.get('from') || addDays(today(), -30);
  const to = url.searchParams.get('to') || addDays(today(), 400);
  const includeUndone = url.searchParams.get('all') === '1';
  const statusClause = includeUndone ? '' : "AND i.status = 'accepted'";
  const rows = db.prepare(`
    SELECT i.*, b.title AS batch_title, b.source_path AS batch_source
    FROM items i JOIN batches b ON b.id = i.batch_id
    WHERE (i.start_date IS NULL OR (i.start_date >= ? AND i.start_date <= ?)) ${statusClause}
    ORDER BY (i.start_date IS NULL) ASC, i.start_date ASC, i.start_time ASC
  `).all(from, to);
  json(res, 200, { items: rows.map(decorate), from, to });
}

// ---------------------------------------------------------------- export & share

function itemsForExport({ batchId, itemIds }) {
  if (itemIds?.length) {
    const marks = itemIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM items WHERE id IN (${marks}) AND status != 'rejected' ORDER BY start_date`).all(...itemIds);
  }
  if (batchId) {
    return db.prepare("SELECT * FROM items WHERE batch_id = ? AND status = 'accepted' ORDER BY start_date").all(batchId);
  }
  return db.prepare("SELECT * FROM items WHERE status = 'accepted' ORDER BY start_date").all();
}

export function exportICS(req, res, url) {
  const batchId = url.searchParams.get('batch');
  const itemIds = (url.searchParams.get('items') || '').split(',').filter(Boolean);
  const items = itemsForExport({ batchId, itemIds }).filter((i) => i.start_date);
  const batch = batchId ? getBatch(batchId) : null;
  const name = batch ? `KevCal — ${batch.title}` : 'KevCal';
  const ics = buildICS(items, { calName: name, leadDaysFor });
  const filename = `${(batch?.title || 'kevcal').replace(/[^\w-]+/g, '-').slice(0, 40)}.ics`;
  res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  });
  res.end(ics);
}

/** Hands the .ics to the Mac's default calendar app — the fastest route to a real calendar. */
export async function openInCalendar(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }
  const items = itemsForExport({ batchId: body.batchId, itemIds: body.itemIds }).filter((i) => i.start_date);
  if (!items.length) return badRequest(res, 'nothing to add');
  const batch = body.batchId ? getBatch(body.batchId) : null;
  const ics = buildICS(items, { calName: `KevCal — ${batch?.title || 'items'}`, leadDaysFor });
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `kevcal-${Date.now()}.ics`);
  fs.writeFileSync(file, ics);
  if (process.platform !== 'darwin') {
    return json(res, 200, { ok: false, reason: 'not_macos', file });
  }
  spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  log('open_ics', { batch_id: body.batchId ?? null, detail: { count: items.length } });
  json(res, 200, { ok: true, count: items.length });
}

export function renderText(items, { title = 'Dates' } = {}) {
  const lines = [title, '─'.repeat(Math.min(title.length, 40)), ''];
  const sorted = [...items].filter((i) => i.start_date).sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (const i of sorted) {
    const when = formatHuman(i.start_date, { withDow: true });
    const time = i.start_time ? `, ${formatTime(i.start_time)}${i.end_time ? `–${formatTime(i.end_time)}` : ''}` : '';
    const range = i.end_date && i.end_date !== i.start_date ? ` to ${formatHuman(i.end_date, { withDow: true })}` : '';
    const tag = i.kind === 'deadline' ? 'DUE: ' : '';
    lines.push(`${tag}${i.title}`);
    lines.push(`  ${when}${range}${time}${i.location ? ` · ${i.location}` : ''}`);
    if (i.notes) lines.push(`  ${i.notes}`);
    lines.push('');
  }
  const undated = items.filter((i) => !i.start_date);
  if (undated.length) {
    lines.push('Not yet dated:');
    for (const i of undated) lines.push(`  ${i.title}`);
  }
  return lines.join('\n').trim() + '\n';
}

export async function createShare(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }
  const token = crypto.randomBytes(12).toString('base64url');
  const shareId = id('sh_');
  db.prepare('INSERT INTO shares (id, batch_id, token, label, item_ids, created_at) VALUES (?,?,?,?,?,?)')
    .run(shareId, body.batchId ?? null, token, body.label ?? null,
         Array.isArray(body.itemIds) && body.itemIds.length ? JSON.stringify(body.itemIds) : null, nowISO());
  log('share_create', { batch_id: body.batchId ?? null, detail: { token } });
  json(res, 200, { ok: true, id: shareId, token, path: `/s/${token}` });
}

function shareItems(share) {
  const ids = share.item_ids ? safeParse(share.item_ids) : null;
  return itemsForExport({ batchId: share.batch_id, itemIds: ids });
}

export function serveShare(req, res, token, wantsICS) {
  const share = db.prepare('SELECT * FROM shares WHERE token = ? AND revoked = 0').get(token);
  if (!share) return notFound(res, 'this shared list is not available');
  db.prepare('UPDATE shares SET fetch_count = fetch_count + 1, last_fetch = ? WHERE id = ?').run(nowISO(), share.id);
  const items = shareItems(share).filter((i) => i.start_date);
  const batch = share.batch_id ? getBatch(share.batch_id) : null;
  const label = share.label || batch?.title || 'Shared dates';

  if (wantsICS) {
    const ics = buildICS(items, { calName: label, leadDaysFor });
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(ics);
  }
  json(res, 200, { label, items: items.map(decorate), text: renderText(items, { title: label }) });
}

export function shareTextHandler(req, res, url) {
  const batchId = url.searchParams.get('batch');
  const itemIds = (url.searchParams.get('items') || '').split(',').filter(Boolean);
  const items = itemsForExport({ batchId, itemIds });
  const batch = batchId ? getBatch(batchId) : null;
  json(res, 200, { text: renderText(items, { title: batch?.title || 'Dates' }) });
}

export function listShares(req, res) {
  const rows = db.prepare('SELECT * FROM shares WHERE revoked = 0 ORDER BY created_at DESC').all();
  json(res, 200, { shares: rows });
}

export function revokeShare(req, res, shareId) {
  db.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').run(shareId);
  log('share_revoke', { detail: shareId });
  json(res, 200, { ok: true });
}

// ---------------------------------------------------------------- settings & anchors

export async function settingsHandler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      ai_enabled: getSetting('ai_enabled', false),
      ai_available: aiAvailable(),
      lead_days: getSetting('lead_days', { deadline: DEFAULT_LEAD_DAYS.deadline, event: DEFAULT_LEAD_DAYS.event }),
      ladders: DEFAULT_LEAD_DAYS.ladders,
      data_dir: DATA_DIR,
    });
  }
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }
  if ('ai_enabled' in body) setSetting('ai_enabled', Boolean(body.ai_enabled));
  if ('lead_days' in body) setSetting('lead_days', body.lead_days);
  json(res, 200, { ok: true });
}

export async function anchorsHandler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, { anchors: db.prepare('SELECT * FROM anchors ORDER BY created_at DESC').all() });
  }
  let body;
  try { body = await readJSON(req); } catch (e) { return badRequest(res, e.message); }
  if (!body.week1_start) return badRequest(res, 'week1_start is required');
  const anchorId = id('a_');
  if (body.is_default) db.prepare('UPDATE anchors SET is_default = 0').run();
  db.prepare('INSERT INTO anchors (id, name, week1_start, skip_weeks, holidays, is_default, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(anchorId, body.name || 'Term', body.week1_start,
         JSON.stringify(body.skip_weeks || []), JSON.stringify(body.holidays || []),
         body.is_default ? 1 : 0, nowISO());
  json(res, 200, { ok: true, id: anchorId });
}

export function sourceImage(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch?.source_path) return notFound(res, 'no source image');
  serveFile(res, path.join(ORIGINALS_DIR, batch.source_path), { cache: 'private, max-age=3600' });
}

export function stats(req, res) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM batches) AS batches,
      (SELECT COUNT(*) FROM items WHERE status='accepted') AS live_items,
      (SELECT COUNT(*) FROM items WHERE status='accepted' AND kind='deadline' AND satisfied=0) AS open_deadlines
  `).get();
  json(res, 200, { ...row, ai_available: aiAvailable() });
}
