// API handlers. The Batch is the organising idea: it is simultaneously the unit
// of undo, re-import/diff, bulk edit and sharing, which is what makes "correct,
// delete and share a list in one operation" a single concept instead of four.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { db, id, nowISO, log, getSetting, setSetting, ORIGINALS_DIR, DATA_DIR, DEFAULT_LEAD_DAYS } from './db.js';
import { extract, assessRisk, readerAvailable, readerName, readerModel } from './extract/index.js';
import { buildICS } from './lib/ics.js';
import { diffItems, describeDiff } from './lib/diff.js';
import { json, badRequest, notFound, readJSON, serveFile, fromBodyError } from './lib/http.js';
import { sniffType, sniffFile } from './lib/sniff.js';
import * as budget from './lib/budget.js';
import { priceList, PRICES_CHECKED } from './lib/pricing.js';
import { today, addDays, formatHuman, formatTime, daysBetween } from './lib/dates.js';

const ITEM_COLUMNS = [
  'kind', 'title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day',
  'location', 'owner', 'cost', 'notes', 'confidence', 'needs_review', 'reviewed',
  'status', 'satisfied', 'satisfied_at', 'lead_days', 'recurrence_suggestion',
  'recurrence_accepted', 'rrule', 'question', 'heading', 'src_page', 'src_bbox',
  'src_raw', 'src_interpretation', 'fingerprint', 'user_edited', 'derived_from',
  'flags', 'blocked', 'date_basis',
];

const EDITABLE = new Set([
  'kind', 'title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day',
  'location', 'owner', 'cost', 'notes', 'lead_days', 'satisfied',
]);

// Columns declared NOT NULL with a DEFAULT: passing an explicit NULL bypasses the
// default, so supply it here for fields the extractor legitimately leaves unset.
const COLUMN_DEFAULTS = {
  all_day: 1, confidence: 0.5, needs_review: 0, reviewed: 0, status: 'pending',
  satisfied: 0, recurrence_accepted: 0, user_edited: 0, blocked: 0,
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
      if (c === 'flags' && Array.isArray(v)) v = JSON.stringify(v);
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
  return db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY blocked DESC, needs_review DESC, confidence ASC, start_date ASC').all(batchId);
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
    flags: item.flags ? (safeParse(item.flags) || []) : [],
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------------------------------------------------------------- capture

export async function captureHandler(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const out = await captureCore(body);
  return json(res, out.status, out.payload);
}

/**
 * The iOS share-sheet entry point. A Shortcut posts the picture here straight
 * from Photos or Mail and gets back one URL to open — which is the difference
 * between capturing the letter in your hand and meaning to do it later.
 */
export async function quickCapture(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const out = await captureCore(body);
  if (out.status !== 200) return json(res, out.status, out.payload);
  const items = out.payload.items || [];
  return json(res, 200, {
    ok: true,
    batch: out.payload.batch.id,
    found: items.length,
    needs_check: items.filter((i) => i.needs_review).length,
    url: `/?b=${out.payload.batch.id}`,
  });
}

async function captureCore(body) {
  const fail = (status, error) => ({ status, payload: { error } });

  const kind = body.kind === 'text' ? 'text' : (body.filename || '').toLowerCase().endsWith('.pdf') ? 'pdf' : 'image';

  let filePath = null;
  let storedName = null;
  if (kind !== 'text') {
    if (!body.data) return fail(400, 'no image data supplied');
    const b64 = String(body.data).replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(b64, 'base64');
    // The client's filename is not evidence of anything. Identify the file by
    // its leading bytes, and let those bytes choose the name it is stored under.
    const sniffed = sniffType(bytes);
    if (!sniffed) return fail(400, 'that does not look like a photo or a PDF');
    storedName = `${id('src_')}${sniffed.ext}`;
    filePath = path.join(ORIGINALS_DIR, storedName);
    try { fs.writeFileSync(filePath, bytes, { mode: 0o600 }); }
    catch (e) { return fail(400, `could not save image: ${e.message}`); }
  } else if (!String(body.text || '').trim()) {
    return fail(400, 'no text supplied');
  }

  const anchor = body.anchorId
    ? anchorRow(db.prepare('SELECT * FROM anchors WHERE id = ?').get(body.anchorId))
    : anchorRow(db.prepare('SELECT * FROM anchors WHERE is_default = 1').get());

  let result;
  try {
    // The clock comes from the phone, not the server. "Tomorrow" and the
    // after-midnight ambiguity are both questions about where the person
    // holding the document is standing in their own day.
    result = await extract({
      kind, filePath, text: body.text, filename: body.filename, anchor,
      now: body.now || body.reference, tz: body.tz || timezone(), takenAt: body.takenAt,
    });
  } catch (e) {
    return fail(500, `extraction failed: ${e.message}`);
  }

  const batchId = id('b_');
  const title = body.title || result.doc?.document_title || documentTitle(result, kind, body) || 'Capture';

  db.prepare(`
    INSERT INTO batches (id, title, source_kind, source_name, source_path, source_text,
                         source_w, source_h, engine, status, risk, parent_id, anchor_json, created_at,
                         doc_date, tz, captured_at_local)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    batchId, title, kind, body.filename ?? null, storedName, kind === 'text' ? body.text : null,
    result.page.width, result.page.height, result.engine, 'draft', result.risk,
    body.parentBatchId ?? null, result.anchor ? JSON.stringify(result.anchor) : null, nowISO(),
    result.doc?.document_date ?? null, result.now?.tz ?? null, `${result.now.date} ${result.now.time}`,
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

  return {
    status: 200,
    payload: {
      batch: getBatch(batchId),
      items,
      risk: result.risk,
      engine: result.engine,
      doc: result.doc,
      stats: result.stats,
      questions: result.questions,
      anchor: result.anchor,
      now: result.now,
      ocrError: result.ocrError,
      readerError: result.readerError,
      readerAvailable: result.readerAvailable,
      usedReader: result.usedReader,
      budget: result.budget,
      // Only when the user did not already say which import this updates.
      suggestedParent: body.parentBatchId ? null : suggestParent(batchId, items),
      diff,
    },
  };
}

/**
 * Has this document been read here before?
 *
 * Re-reading a term calendar should update the one you have, not add a second
 * copy of the same term. Asking the user to remember to press "Update" first
 * means that on the day they forget, they get duplicates — so KevCal looks for
 * itself, by comparing the new dates against what is already here.
 *
 * It only ever offers. Silently merging two documents that happened to share
 * dates would be far worse than an extra import.
 */
function suggestParent(newBatchId, items) {
  const dated = items.filter((i) => i.start_date);
  if (dated.length < 2) return null;

  const candidates = db.prepare(`
    SELECT id, title, created_at FROM batches
    WHERE id != ? AND status = 'committed' ORDER BY created_at DESC LIMIT 20
  `).all(newBatchId);

  let best = null;
  for (const c of candidates) {
    const theirs = getItems(c.id).filter((i) => i.status === 'accepted' && i.start_date);
    if (theirs.length < 2) continue;
    const d = diffItems(theirs, dated);
    const shared = d.summary.unchanged + d.summary.changed;
    const overlap = shared / Math.max(theirs.length, dated.length);
    // Two in five dates in common is far past coincidence for dated documents.
    if (overlap >= 0.4 && (!best || overlap > best.overlap)) {
      best = { id: c.id, title: c.title, read_at: c.created_at, overlap, shared, description: describeDiff(d) };
    }
  }
  return best;
}

/**
 * Adopt an existing import as this one's parent, turning a fresh capture into a
 * revision of it. Done here rather than by capturing again, because reading the
 * page a second time would cost another call for an answer we already have.
 */
export async function linkParent(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const parent = body?.parentId ? getBatch(body.parentId) : null;
  if (!parent) return notFound(res, 'that import no longer exists');
  if (parent.id === batchId) return badRequest(res, 'an import cannot be a version of itself');
  if (lineageIds(batchId).includes(parent.id)) {
    return badRequest(res, 'that would make a loop of versions');
  }
  db.prepare('UPDATE batches SET parent_id = ? WHERE id = ?').run(parent.id, batchId);
  log('link_parent', { batch_id: batchId, detail: parent.id });

  const items = getItems(batchId).map(decorate);
  const parentItems = getItems(parent.id).filter((i) => i.status !== 'rejected');
  const d = diffItems(parentItems, items);
  json(res, 200, { ok: true, batch: getBatch(batchId), items, diff: { ...d, description: describeDiff(d) } });
}

/** Rename an import, so "which school" is answerable months later. */
export async function renameBatch(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const title = String(body?.title ?? '').trim();
  if (!title || title.length > 200) return badRequest(res, 'give it a name, up to 200 characters');
  db.prepare('UPDATE batches SET title = ? WHERE id = ?').run(title, batchId);
  log('rename_batch', { batch_id: batchId, detail: title });
  json(res, 200, { ok: true, batch: getBatch(batchId) });
}

/**
 * A batch title is how you recognise an import weeks later, so prefer the
 * document's own headline over the camera's filename.
 */
function documentTitle(result, kind, body) {
  if (kind === 'text') return firstWords(body.text);
  const first = (result.lines || [])
    .map((l) => (l.text || '').trim())
    .find((t) => t.length >= 4 && t.length <= 60);
  if (first) return first;
  return body.filename || null;
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

/**
 * An import and every later version of it. A school calendar re-issued twice is
 * one thing in a person's head, so undo, delete and "open" have to treat it as
 * one thing too — otherwise the group quietly scatters across rows, and dates
 * added by a revision survive deleting what you think is the whole calendar.
 */
export function lineageIds(rootId) {
  const out = [rootId];
  const children = db.prepare('SELECT id FROM batches WHERE parent_id = ?');
  for (let i = 0; i < out.length && out.length < 500; i++) {
    for (const row of children.all(out[i])) if (!out.includes(row.id)) out.push(row.id);
  }
  return out;
}

export function getBatchHandler(req, res, batchId, url) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  if (url?.searchParams.get('lineage') !== '1') {
    const items = getItems(batchId).map(decorate);
    // An un-applied revision recomputes its comparison on demand, so closing the
    // screen does not strand it: the diff used to exist only in the reply to the
    // capture that made it, and was gone the moment you navigated away.
    let diff = null;
    if (batch.parent_id && batch.status === 'draft') {
      const parentItems = getItems(batch.parent_id).filter((i) => i.status !== 'rejected');
      const d = diffItems(parentItems, items);
      diff = { ...d, description: describeDiff(d) };
    }
    return json(res, 200, { batch, items, diff });
  }
  const ids = lineageIds(batchId);
  const marks = ids.map(() => '?').join(',');
  const items = db.prepare(
    `SELECT * FROM items WHERE batch_id IN (${marks})
     ORDER BY blocked DESC, needs_review DESC, start_date ASC`,
  ).all(...ids).map(decorate);
  json(res, 200, { batch, items, lineage: ids, revisions: ids.length - 1 });
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
  const blocked = chosen.filter((i) => i.blocked && !i.reviewed && !body.force);
  if (blocked.length) {
    return json(res, 409, {
      error: 'needs_review',
      message: blocked.length === 1
        ? 'One date needs an answer first — open it to fix or accept it.'
        : `${blocked.length} dates need an answer first — open them to fix or accept.`,
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
export function undoBatch(req, res, batchId, url) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  // Undoing "the school calendar" has to take back the revisions too.
  if (url?.searchParams.get('lineage') === '1') {
    const ids = lineageIds(batchId);
    const at2 = nowISO();
    const marks = ids.map(() => '?').join(',');
    const removed = db.prepare(
      `UPDATE items SET status='rejected', undo_marked=1, updated_at=?
       WHERE batch_id IN (${marks}) AND status != 'rejected'`,
    ).run(at2, ...ids).changes;
    db.prepare(`UPDATE batches SET status='undone', undone_at=? WHERE id IN (${marks})`).run(at2, ...ids);
    log('undo', { batch_id: batchId, detail: { count: removed, lineage: ids.length } });
    return json(res, 200, { ok: true, removed });
  }
  const at = nowISO();
  // Mark only what this undo actually took away, so redo cannot resurrect
  // something the user had deliberately rejected.
  const n = db.prepare(
    "UPDATE items SET status='rejected', undo_marked=1, updated_at=? WHERE batch_id=? AND status != 'rejected'",
  ).run(at, batchId).changes;
  db.prepare("UPDATE batches SET status='undone', undone_at=? WHERE id=?").run(at, batchId);
  log('undo', { batch_id: batchId, detail: { count: n } });
  json(res, 200, { ok: true, removed: n });
}

export function redoBatch(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  const at = nowISO();
  const n = db.prepare(
    "UPDATE items SET status='accepted', undo_marked=0, updated_at=? WHERE batch_id=? AND undo_marked=1",
  ).run(at, batchId).changes;
  db.prepare("UPDATE batches SET status='committed', undone_at=NULL WHERE id=?").run(batchId);
  log('redo', { batch_id: batchId, detail: { count: n } });
  json(res, 200, { ok: true, restored: n });
}

export function deleteBatch(req, res, batchId, url) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  // Deleting the calendar means the whole lineage, newest revisions first, so a
  // foreign key never points at something already gone.
  if (url?.searchParams.get('lineage') === '1') {
    const ids = lineageIds(batchId).reverse();
    for (const one of ids) {
      const row = getBatch(one);
      if (!row) continue;
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE batches SET parent_id = NULL WHERE parent_id = ?').run(one);
        db.prepare('DELETE FROM items WHERE batch_id = ?').run(one);
        db.prepare('DELETE FROM shares WHERE batch_id = ?').run(one);
        db.prepare('DELETE FROM batches WHERE id = ?').run(one);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: `could not delete: ${e.message}` }); }
      if (row.source_path) {
        try { fs.unlinkSync(path.join(ORIGINALS_DIR, row.source_path)); } catch { /* already gone */ }
      }
    }
    log('delete_batch', { batch_id: batchId, detail: { lineage: ids.length } });
    return json(res, 200, { ok: true, deleted: ids.length });
  }

  // All-or-nothing, and the image goes only after the rows are safely gone —
  // otherwise a failed delete leaves a batch listed with its source destroyed.
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE batches SET parent_id = NULL WHERE parent_id = ?').run(batchId);
    db.prepare('DELETE FROM items WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM shares WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return json(res, 500, { error: `could not delete: ${e.message}` });
  }

  if (batch.source_path) {
    // Deleting an import deletes its source image; the privacy promise depends on it.
    try { fs.unlinkSync(path.join(ORIGINALS_DIR, batch.source_path)); } catch { /* already gone */ }
  }
  log('delete_batch', { batch_id: batchId });
  json(res, 200, { ok: true });
}

export async function applyDiff(req, res, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return notFound(res, 'batch not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const accept = Array.isArray(body?.accept) ? body.accept : [];
  const at = nowISO();
  let changed = 0, added = 0, removed = 0, skipped = 0, blocked = 0;

  const get = (id) => (typeof id === 'string' ? db.prepare('SELECT * FROM items WHERE id = ?').get(id) : null);
  // The donor must be the freshly captured version; the target must be what it supersedes.
  const isDonor = (row) => row && row.batch_id === batchId;
  const isTarget = (row) => row && (!batch.parent_id || row.batch_id === batch.parent_id);

  for (const a of accept) {
    if (a?.op === 'change') {
      const src = get(a.newItemId);
      const target = get(a.targetId);
      if (!isDonor(src) || !isTarget(target)) { skipped++; continue; }
      // Never silently revert a hand correction.
      if (target.user_edited && !a.force) { skipped++; continue; }
      db.prepare(`UPDATE items SET title=?, start_date=?, start_time=?, end_date=?, end_time=?,
                  all_day=?, location=?, src_interpretation=?, updated_at=? WHERE id=?`)
        .run(src.title, src.start_date, src.start_time, src.end_date, src.end_time,
             src.all_day, src.location, src.src_interpretation, at, target.id);
      changed++;
    } else if (a?.op === 'add') {
      const src = get(a.newItemId);
      if (!isDonor(src)) { skipped++; continue; }
      // Same gate as a plain commit: uncertainty cannot slip in through the diff.
      if (src.blocked && !src.reviewed) { blocked++; continue; }
      db.prepare("UPDATE items SET status='accepted', updated_at=? WHERE id=?").run(at, src.id);
      added++;
    } else if (a?.op === 'remove') {
      const target = get(a.targetId);
      if (!isTarget(target)) { skipped++; continue; }
      db.prepare("UPDATE items SET status='superseded', updated_at=? WHERE id=?").run(at, target.id);
      removed++;
    } else {
      skipped++;
    }
  }
  db.prepare("UPDATE batches SET status='committed', committed_at=? WHERE id=?").run(at, batchId);
  log('apply_diff', { batch_id: batchId, detail: { changed, added, removed, skipped, blocked } });
  json(res, 200, { ok: true, changed, added, removed, skipped, blocked });
}

// ---------------------------------------------------------------- items

// ---------------------------------------------------------------- validation

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(v) {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Field-level validation. `EDITABLE` gates which fields may be written; this
 * gates what may be written into them. Without it a single bad value poisons
 * every calendar export.
 */
const VALIDATORS = {
  title: (v) => (typeof v === 'string' && v.trim().length && v.length <= 500 ? v.trim() : undefined),
  kind: (v) => (v === 'event' || v === 'deadline' ? v : undefined),
  start_date: (v) => (v === null || validDate(v) ? v : undefined),
  end_date: (v) => (v === null || validDate(v) ? v : undefined),
  start_time: (v) => (v === null || HHMM.test(v) ? v : undefined),
  end_time: (v) => (v === null || HHMM.test(v) ? v : undefined),
  all_day: (v) => (v === null ? 1 : (v ? 1 : 0)),
  satisfied: (v) => (v ? 1 : 0),
  location: (v) => (v === null || typeof v === 'string' ? (v ?? null) : undefined),
  owner: (v) => (v === null || typeof v === 'string' ? (v ?? null) : undefined),
  cost: (v) => (v === null || typeof v === 'string' ? (v ?? null) : undefined),
  notes: (v) => (v === null || typeof v === 'string' ? (v ?? null) : undefined),
  lead_days: (v) => (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 3650)
    ? JSON.stringify(v) : undefined),
};

/** Which flags an edit to a given field actually answers. */
const FLAGS_ANSWERED_BY = {
  start_date: ['no_date', 'impossible_date', 'year_assumed', 'weekday_mismatch', 'quote_mismatch',
               'year_mismatch', 'in_the_past', 'far_future', 'midnight_ambiguity',
               'relative_unresolved', 'relative_no_document_date', 'relative_photo_anchor',
               'relative_ambiguous_phrase', 'low_confidence', 'reader_unsure'],
  end_date: ['end_date_before_start'],
  start_time: ['am_pm_assumed', 'end_before_start'],
  end_time: ['am_pm_assumed', 'end_before_start'],
  all_day: ['am_pm_assumed', 'end_before_start'],
  title: ['low_confidence'],
};

export function pruneFlags(flags, editedFields) {
  const answered = new Set();
  for (const f of editedFields) for (const code of (FLAGS_ANSWERED_BY[f] || [])) answered.add(code);
  return (Array.isArray(flags) ? flags : []).filter((f) => !answered.has(f?.code));
}

export async function patchItem(req, res, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return notFound(res, 'item not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'body must be an object');

  const sets = [];
  const vals = [];
  for (const [k, raw] of Object.entries(body)) {
    if (!EDITABLE.has(k)) continue;
    const clean = VALIDATORS[k] ? VALIDATORS[k](raw) : undefined;
    if (clean === undefined) return badRequest(res, `invalid value for ${k}`);
    sets.push(`${k} = ?`);
    vals.push(clean);
  }
  if (!sets.length) return badRequest(res, 'no editable fields supplied');

  // Guard the pair, not just each field: an end before a start is not a range.
  const nextStart = 'start_date' in body ? VALIDATORS.start_date(body.start_date) : item.start_date;
  const nextEnd = 'end_date' in body ? VALIDATORS.end_date(body.end_date) : item.end_date;
  if (nextStart && nextEnd && nextEnd < nextStart) return badRequest(res, 'the end date is before the start date');

  if ('satisfied' in body) {
    sets.push('satisfied_at = ?');
    vals.push(body.satisfied ? nowISO() : null);
  }
  // A human touched it, so it is no longer blocking the commit. The flags that
  // prompted the edit are retired; any still true are kept, because clearing a
  // warning the user did not actually address would be a quiet lie.
  const remaining = pruneFlags(safeParse(item.flags) || [], Object.keys(body));
  sets.push('user_edited = 1', 'reviewed = 1', 'flags = ?', 'blocked = ?', 'needs_review = ?', 'updated_at = ?');
  vals.push(JSON.stringify(remaining),
            remaining.some((f) => f.level === 'blocker') ? 1 : 0,
            remaining.length ? 1 : 0,
            nowISO(), itemId);

  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  log('edit_item', { item_id: itemId, batch_id: item.batch_id, detail: Object.keys(body).join(',') });
  json(res, 200, { ok: true, item: decorate(db.prepare('SELECT * FROM items WHERE id = ?').get(itemId)) });
}

export async function bulkItems(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const ids = (Array.isArray(body?.ids) ? body.ids : []).filter((v) => typeof v === 'string');
  if (!ids.length) return badRequest(res, 'no item ids supplied');
  if (ids.length > 2000) return badRequest(res, 'too many items in one operation');
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
      affected = db.prepare(`UPDATE items SET reviewed=1, blocked=0, updated_at=? WHERE id IN (${marks})`).run(at, ...ids).changes;
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
      // Unbounded shifts produced NaN dates that then broke every calendar export.
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 3650) {
        return badRequest(res, 'shift must be a whole number of days, up to 3650');
      }
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

const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const BYDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/**
 * Accepting a recurrence suggestion is the ONLY way an RRULE is ever created.
 * Nothing in the extractor may write one. Every component is whitelisted: the
 * rule is written verbatim into exported calendar files, so unvalidated input
 * here would let arbitrary iCalendar properties be injected.
 */
export async function acceptRecurrence(req, res, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return notFound(res, 'item not found');
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }

  if (body?.accept === false) {
    db.prepare('UPDATE items SET recurrence_accepted=0, rrule=NULL, reviewed=1, updated_at=? WHERE id=?').run(nowISO(), itemId);
    return json(res, 200, { ok: true, accepted: false });
  }

  const sug = safeParse(item.recurrence_suggestion) || {};
  const freq = String(body?.freq || sug.freq || 'WEEKLY').toUpperCase();
  if (!FREQS.has(freq)) return badRequest(res, 'unsupported repeat frequency');

  const interval = Number(body?.interval ?? sug.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    return badRequest(res, 'repeat interval must be a whole number between 1 and 52');
  }

  const until = body?.until ?? null;
  const count = body?.count != null ? Number(body.count) : null;
  if (!until && !count) {
    // Refusing an unbounded rule is deliberate: we never extrapolate past evidence.
    return badRequest(res, 'a repeat needs an end date or a number of occurrences');
  }
  if (until && !(typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until)
                 && !Number.isNaN(new Date(`${until}T00:00:00Z`).getTime()))) {
    return badRequest(res, 'the repeat end date must be a real date (YYYY-MM-DD)');
  }
  if (count != null && (!Number.isInteger(count) || count < 1 || count > 500)) {
    return badRequest(res, 'the number of repeats must be between 1 and 500');
  }

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  const byday = body?.byday ?? sug.byday;
  if (byday && freq === 'WEEKLY') {
    const day = String(byday).toUpperCase();
    if (!BYDAYS.has(day)) return badRequest(res, 'unrecognised day for a weekly repeat');
    parts.push(`BYDAY=${day}`);
  }
  if (until) parts.push(`UNTIL=${until.replace(/-/g, '')}T235959Z`);
  else parts.push(`COUNT=${count}`);

  const rrule = parts.join(';');
  db.prepare('UPDATE items SET recurrence_accepted=1, rrule=?, reviewed=1, user_edited=1, updated_at=? WHERE id=?')
    .run(rrule, nowISO(), itemId);
  log('accept_recurrence', { item_id: itemId, detail: rrule });
  json(res, 200, { ok: true, rrule });
}

// ---------------------------------------------------------------- agenda

export function agenda(req, res, url) {
  const from = url.searchParams.get('from') || addDays(today(), -30);
  const to = url.searchParams.get('to') || addDays(today(), 400);
  const includeUndone = url.searchParams.get('all') === '1';
  // 'kept' is everything you decided to keep, whether or not you put it on the
  // calendar: nothing captured is ever thrown away just because you skipped it.
  const include = url.searchParams.get('include');
  const statusClause = includeUndone ? ''
    : include === 'kept' ? "AND i.status IN ('accepted', 'pending')"
    : "AND i.status = 'accepted'";
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
  const ics = buildICS(items, { calName: name, leadDaysFor, tz: timezone() });
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
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const items = itemsForExport({ batchId: body.batchId, itemIds: body.itemIds }).filter((i) => i.start_date);
  if (!items.length) return badRequest(res, 'nothing to add');
  const batch = body.batchId ? getBatch(body.batchId) : null;
  const ics = buildICS(items, { calName: `KevCal — ${batch?.title || 'items'}`, leadDaysFor, tz: timezone() });
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
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  const itemIds = Array.isArray(body?.itemIds) ? body.itemIds.filter((v) => typeof v === 'string') : [];
  if (!body?.batchId && !itemIds.length) {
    return badRequest(res, 'choose an import or some dates to share');
  }
  if (body.batchId && !getBatch(body.batchId)) return notFound(res, 'batch not found');
  const token = crypto.randomBytes(12).toString('base64url');
  const shareId = id('sh_');
  db.prepare('INSERT INTO shares (id, batch_id, token, label, item_ids, created_at) VALUES (?,?,?,?,?,?)')
    .run(shareId, body.batchId ?? null, token, body.label ?? null,
         itemIds.length ? JSON.stringify(itemIds) : null, nowISO());
  log('share_create', { batch_id: body.batchId ?? null, detail: { token } });
  json(res, 200, { ok: true, id: shareId, token, path: `/s/${token}` });
}

/**
 * Your own calendar, as a subscription rather than a file.
 *
 * Exporting a .ics copies dates INTO Apple Calendar and the copy is then on its
 * own: undo an import afterwards and the events stay there forever, which makes
 * "undo is one button" quietly untrue the moment it matters. A subscribed feed
 * is read live on every fetch, so KevCal stays the source of truth — correct a
 * date and it moves, undo an import and the dates leave, delete one and it goes.
 *
 * The token is the credential: a calendar app cannot present a header, so the
 * URL has to carry it. That is why /s/ deliberately sits outside the lock.
 */
function personalShare() {
  return db.prepare('SELECT * FROM shares WHERE is_personal = 1 AND revoked = 0').get();
}

function feedPayload(share) {
  const live = itemsForExport({}).filter((i) => i.start_date);
  return {
    token: share.token,
    path: `/s/${share.token}.ics`,
    dates: live.length,
    fetch_count: share.fetch_count,
    last_fetch: share.last_fetch,
    created_at: share.created_at,
  };
}

export function personalFeed(req, res) {
  let share = personalShare();
  if (!share) {
    const shareId = id('sh_');
    // Longer than a shared list's token: this one names everything you own.
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare(`INSERT INTO shares (id, batch_id, token, label, item_ids, created_at, is_personal)
                VALUES (?,?,?,?,?,?,1)`)
      .run(shareId, null, token, 'Your calendar', null, nowISO());
    log('feed_create', { detail: shareId });
    share = db.prepare('SELECT * FROM shares WHERE id = ?').get(shareId);
  }
  json(res, 200, feedPayload(share));
}

/** Kills the old address and issues a new one, for when a link has got out. */
export function rotateFeed(req, res) {
  const before = personalShare();
  if (before) {
    db.prepare('UPDATE shares SET revoked = 1 WHERE is_personal = 1').run();
    log('feed_rotate', { detail: before.id });
  }
  return personalFeed(req, res);
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
    const ics = buildICS(items, { calName: label, leadDaysFor, tz: timezone() });
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
  const rows = db.prepare('SELECT * FROM shares WHERE revoked = 0 AND is_personal = 0 ORDER BY created_at DESC').all();
  json(res, 200, { shares: rows });
}

export function revokeShare(req, res, shareId) {
  const row = db.prepare('SELECT is_personal FROM shares WHERE id = ?').get(shareId);
  if (row?.is_personal) {
    return badRequest(res, 'that is your own calendar feed — rotate it from Settings instead');
  }
  const n = db.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').run(shareId).changes;
  if (!n) return notFound(res, 'share not found');
  log('share_revoke', { detail: shareId });
  json(res, 200, { ok: true });
}

// ---------------------------------------------------------------- settings & anchors

export async function settingsHandler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      reader: readerAvailable() ? readerName() : 'on-device',
      reader_available: readerAvailable(),
      reader_model: readerModel(),
      timezone: timezone(),
      lead_days: getSetting('lead_days', { deadline: DEFAULT_LEAD_DAYS.deadline, event: DEFAULT_LEAD_DAYS.event }),
      ladders: DEFAULT_LEAD_DAYS.ladders,
      data_dir: DATA_DIR,
      keep_originals: getSetting('keep_originals', true),
      budget: budget.status(),
      budget_history: budget.history(),
      prices: priceList(),
      prices_checked: PRICES_CHECKED,
      // Set in .env it cannot be raised from the browser, which is the point.
      budget_locked: !!process.env.KEVCAL_MONTHLY_BUDGET,
    });
  }
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
  if ('lead_days' in body) setSetting('lead_days', body.lead_days);
  if ('timezone' in body) setSetting('timezone', String(body.timezone || '').slice(0, 64));
  if ('keep_originals' in body) setSetting('keep_originals', Boolean(body.keep_originals));
  if ('monthly_budget' in body) {
    if (process.env.KEVCAL_MONTHLY_BUDGET) {
      return badRequest(res, 'the budget is set in .env and cannot be changed from here');
    }
    const n = Number(body.monthly_budget);
    if (body.monthly_budget === null || body.monthly_budget === '') setSetting('monthly_budget', null);
    else if (Number.isFinite(n) && n >= 0 && n <= 10000) setSetting('monthly_budget', n);
    else return badRequest(res, 'the budget must be a number of dollars, up to 10000');
  }
  json(res, 200, { ok: true });
}

/** The zone every exported time is anchored to. */
export function timezone() {
  const saved = getSetting('timezone', null);
  if (saved) return saved;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export async function anchorsHandler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, { anchors: db.prepare('SELECT * FROM anchors ORDER BY created_at DESC').all() });
  }
  let body;
  try { body = await readJSON(req); } catch (e) { return fromBodyError(res, e); }
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
  const file = path.join(ORIGINALS_DIR, batch.source_path);
  // Sniffed again on the way out, so even a file that predates the check above
  // cannot be served as anything executable.
  const sniffed = sniffFile(fs, file);
  if (!sniffed) return notFound(res, 'no source image');
  serveFile(res, file, { cache: 'private, max-age=3600', contentType: sniffed.mime });
}

export function stats(req, res) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM batches) AS batches,
      (SELECT COUNT(*) FROM items WHERE status='accepted') AS live_items,
      (SELECT COUNT(*) FROM items WHERE status='accepted' AND kind='deadline' AND satisfied=0) AS open_deadlines
  `).get();
  json(res, 200, { ...row, reader_available: readerAvailable() });
}
