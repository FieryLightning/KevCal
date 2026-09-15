// Orchestrator. Decides who reads the document, then hands everything to the
// checker before anyone downstream sees it.
//
// Order of preference:
//   1. Gemini reads the page, the on-device OCR runs alongside it purely to
//      supply pixel-accurate geometry for the "where did this come from" overlay.
//   2. If there is no key, or the call fails, the deterministic grammar reads it
//      instead. Degraded, but the app still works with the wifi off.
//
// Nothing here resolves a date. That is verify.js's job, and keeping it in one
// place is what makes the "never guess" promise checkable.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildItems, fingerprint } from './build.js';
import { readDocument, readerAvailable, readerName, readerModel } from './reader.js';
import { explainError } from './contract.js';
import { verifyItems } from './verify.js';
import { ROOT } from '../db.js';
import * as budget from '../lib/budget.js';
import { today, daysBetween, formatHuman, addDays } from '../lib/dates.js';

const OCR_BIN = path.join(ROOT, 'bin', 'kevcal-ocr');

export function ocrAvailable() { return fs.existsSync(OCR_BIN); }
export { readerAvailable, readerName, readerModel };

export function runOCR(filePath, { fast = false } = {}) {
  return new Promise((resolve) => {
    if (!ocrAvailable()) return resolve({ ok: false, pages: [], error: 'ocr_not_built' });
    const args = [filePath];
    if (fast) args.push('--fast');
    const proc = spawn(OCR_BIN, args);
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => resolve({ ok: false, pages: [], error: e.message }));
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); }
      catch { resolve({ ok: false, pages: [], error: err.slice(0, 300) || 'ocr_bad_output' }); }
    });
  });
}

/** Pasted text still needs line geometry so the review UI can highlight a line. */
export function linesFromText(text) {
  const raw = String(text || '').split(/\r?\n/);
  const kept = raw.map((t, i) => ({ t, i })).filter((r) => r.t.trim().length);
  const n = Math.max(kept.length, 1);
  return kept.map((r, idx) => ({
    text: r.t.trim(),
    confidence: 1,
    page: 1,
    bbox: [0.04, idx / n, 0.92, 1 / n],
  }));
}

/**
 * Risk decides the ceremony. One clear poster date earns the three-tap path;
 * anything the checker flagged gets the full review, and anything it blocked
 * cannot leave review at all.
 */
export function assessRisk(items) {
  if (!items.length) return 'low';
  if (items.some((i) => i.blocked)) return 'blocked';
  if (items.some((i) => i.needs_review) || items.length > 3) return 'high';
  if (Math.min(...items.map((i) => i.confidence ?? 0)) < 0.8) return 'high';
  return 'low';
}

/** Locate a verbatim quote among OCR lines, to borrow its exact geometry. */
function locateQuote(quote, lines) {
  if (!quote || !lines.length) return null;
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  if (!q) return null;
  let best = null, bestScore = 0;
  for (const line of lines) {
    const l = norm(line.text);
    if (!l) continue;
    let score;
    if (l === q) score = 1;
    else if (l.includes(q) || q.includes(l)) score = 0.85;
    else {
      const qt = new Set(q.split(' '));
      const lt = new Set(l.split(' '));
      let shared = 0;
      for (const t of qt) if (lt.has(t)) shared++;
      score = (2 * shared) / (qt.size + lt.size);
    }
    if (score > bestScore) { bestScore = score; best = line; }
  }
  return bestScore >= 0.5 ? best : null;
}

/**
 * Union of the OCR lines that make up a quote spanning more than one line, so a
 * table row highlights as a row rather than as its first word.
 */
function unionBox(quote, lines) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  if (q.length < 8) return null;
  const parts = lines.filter((l) => {
    const t = norm(l.text);
    return t.length > 2 && q.includes(t);
  });
  if (parts.length < 2) return null;
  const boxes = parts.map((p) => p.bbox).filter((b) => Array.isArray(b) && b.length === 4);
  if (boxes.length < 2) return null;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return { bbox: [x0, y0, x1 - x0, y1 - y0], page: parts[0].page ?? 1 };
}

/** Give each item the best geometry available: OCR first, the model's box second. */
function attachGeometry(items, lines) {
  if (!lines.length) return items;
  for (const item of items) {
    const merged = unionBox(item.src_raw, lines);
    if (merged) {
      item.src_bbox = JSON.stringify(merged.bbox);
      item.src_page = merged.page;
      continue;
    }
    const line = locateQuote(item.src_raw, lines);
    if (line?.bbox) {
      item.src_bbox = JSON.stringify(line.bbox);
      item.src_page = line.page ?? item.src_page ?? 1;
    }
  }
  return items;
}

/**
 * The grammar path produces items that are already resolved, so they get the
 * plausibility half of the checker rather than the whole of it.
 */
function annotateBuiltItems(items, ctx) {
  for (const item of items) {
    const flags = [];
    if (!item.start_date) {
      flags.push({
        code: 'no_date', level: 'blocker', options: [],
        message: item.question || 'I couldn\'t work out a date for this one. Add it, or drop it.',
      });
    } else {
      const delta = daysBetween(ctx.now.date, item.start_date);
      if (delta < -1) {
        flags.push({
          code: 'in_the_past', level: 'check', options: [],
          message: `That's ${Math.abs(delta)} day${Math.abs(delta) === 1 ? '' : 's'} ago — already gone.`,
        });
      } else if (delta > 550) {
        flags.push({
          code: 'far_future', level: 'check', options: [],
          message: `That's ${Math.round(delta / 365 * 10) / 10} years away — worth checking the year.`,
        });
      }
      if (item.question) {
        flags.push({ code: 'reader_unsure', level: 'check', message: item.question, options: [] });
      }
    }
    if ((item.confidence ?? 1) < 0.7 && !flags.length) {
      flags.push({
        code: 'low_confidence', level: 'check', options: [],
        message: 'The page was hard to read here — worth a glance before you keep it.',
      });
    }
    item.flags = flags;
    item.blocked = flags.some((f) => f.level === 'blocker') ? 1 : 0;
    item.needs_review = flags.length ? 1 : (item.needs_review ?? 0);
    item.date_basis = item.date_basis || 'grammar';
  }
  return items;
}

/**
 * A title repeated across a lot of dates almost always means the page was a
 * table and the columns did not line up — every row ends up labelled with the
 * page header instead of its own text. It is the single most common way a
 * document import turns into confident junk, and no per-item check can see it,
 * because each item on its own looks fine.
 */
function flagRepeatedTitles(items) {
  const counts = new Map();
  for (const i of items) {
    const key = String(i.title || '').trim().toLowerCase();
    if (!key || key === '(untitled)') continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const i of items) {
    const n = counts.get(String(i.title || '').trim().toLowerCase()) || 0;
    if (n < 4) continue;
    i.flags = [...(i.flags || []), {
      code: 'repeated_title',
      level: 'check',
      options: [],
      message: `${n} dates came out with this same title, which usually means the columns didn't line up. Worth a look before you keep them.`,
    }];
    i.needs_review = 1;
  }
  return items;
}

/**
 * Build the clock the checker reasons against. It has to be the PHONE's clock,
 * not the server's: "tomorrow" and the after-midnight ambiguity are both
 * questions about where the user is standing in the day.
 */
export function clockFrom({ now, tz } = {}) {
  const raw = typeof now === 'string' ? now.trim() : '';
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (m) {
    return { date: m[1], time: m[2] || '12:00', hour: m[2] ? Number(m[2].slice(0, 2)) : 12, tz: tz || null };
  }
  const d = new Date();
  return {
    date: today(),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    hour: d.getHours(),
    tz: tz || Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}

/**
 * @param {{kind:'image'|'pdf'|'text', filePath?, text?, filename?, anchor?, now?, tz?, takenAt?}} opts
 */
export async function extract(opts) {
  const now = clockFrom(opts);
  const reference = now.date;
  const engineParts = [];
  let ocrError = null;
  let readerError = null;

  // Read the page and OCR it at the same time; the OCR is cheap, local, and only
  // ever used for geometry and as the safety net.
  const ocrPromise = (opts.kind !== 'text' && opts.filePath && ocrAvailable())
    ? runOCR(opts.filePath)
    : Promise.resolve(null);

  let base64 = null;
  if (opts.filePath) {
    try { base64 = fs.readFileSync(opts.filePath).toString('base64'); } catch { /* handled below */ }
  }

  // Priced before the call, not after: refusing once the money is spent is not
  // a cap. Over budget, KevCal reads on-device instead of failing outright.
  const money = budget.status(readerModel());
  const useReader = readerAvailable() && !money.paused
    && (opts.kind === 'text' ? Boolean(opts.text) : Boolean(base64));
  const readerPromise = useReader
    ? readDocument({ base64, filename: opts.filename, isPdf: opts.kind === 'pdf', text: opts.kind === 'text' ? opts.text : null })
    : Promise.resolve(null);

  const [ocr, ai] = await Promise.all([ocrPromise, readerPromise]);

  let lines = [];
  let page = { width: null, height: null };
  if (opts.kind === 'text') {
    lines = linesFromText(opts.text);
  } else if (ocr?.ok) {
    lines = ocr.pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })));
    page = { width: ocr.pages[0]?.width ?? null, height: ocr.pages[0]?.height ?? null };
  } else if (ocr) {
    ocrError = ocr.error || 'ocr_failed';
  }

  let items = [];
  let doc = {};
  let questions = [];
  let stats = {};
  let anchorUsed = null;

  if (ai?.ok) {
    budget.record({ reader: readerName(), model: ai.model, usage: ai.usage });
    doc = ai.doc || {};
    const ctx = {
      now,
      tz: opts.tz || now.tz,
      documentDate: /^\d{4}-\d{2}-\d{2}$/.test(doc.document_date || '') ? doc.document_date : null,
      documentSpan: doc.document_span || null,
      photoDate: /^\d{4}-\d{2}-\d{2}$/.test(opts.takenAt || '') ? opts.takenAt : null,
    };
    items = verifyItems(ai.items || [], ctx);
    attachGeometry(items, lines);
    engineParts.push(ai.model || readerName());
    if (lines.length) engineParts.push(ocr?.engine || 'vision');
    engineParts.push('checked');
  } else {
    if (money.paused && readerAvailable()) readerError = budget.pausedMessage(money);
    else if (ai && !ai.ok) {
      readerError = explainError(ai.error, ai.detail)
        || (ai.detail ? `${ai.error}: ${ai.detail}` : ai.error);
    }
    if (lines.length) {
      const built = buildItems(lines, { reference, anchor: opts.anchor });
      items = annotateBuiltItems(built.items, { now });
      questions = built.questions || [];
      stats = built.stats || {};
      anchorUsed = built.anchor || null;
      engineParts.push(ocr?.engine || (opts.kind === 'text' ? 'text' : 'vision'), 'grammar');
    } else if (opts.kind !== 'text') {
      engineParts.push('none');
      // No reader and no on-device OCR means nothing read the page at all. Say
      // so, rather than reporting an empty document as if it had no dates on it.
      if (!readerError) {
        readerError = ocrAvailable()
          ? 'nothing could be read from that image'
          : 'no reader is configured and this machine has no on-device reader, so nothing could read the page';
      }
    }
  }

  flagRepeatedTitles(items);
  for (const item of items) item.fingerprint = fingerprint(item);

  return {
    lines,
    page,
    items,
    doc,
    anchor: anchorUsed,
    questions,
    stats,
    risk: assessRisk(items),
    engine: engineParts.join('+') || 'none',
    now,
    ocrError,
    readerError,
    readerAvailable: readerAvailable(),
    usedReader: Boolean(ai?.ok),
    budget: budget.status(),
  };
}

export { formatHuman, addDays };
