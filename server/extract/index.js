// Extraction orchestrator: chooses an engine, normalises the result, and scores
// the batch's risk so the UI knows whether to show a confirm card or a review table.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildItems, fingerprint } from './build.js';
import { extractWithAI, aiAvailable } from './anthropic.js';
import { ROOT } from '../db.js';
import { today } from '../lib/dates.js';

const OCR_BIN = path.join(ROOT, 'bin', 'kevcal-ocr');

export function ocrAvailable() { return fs.existsSync(OCR_BIN); }

export function runOCR(filePath, { fast = false } = {}) {
  return new Promise((resolve) => {
    if (!ocrAvailable()) {
      return resolve({ ok: false, pages: [], error: 'ocr_not_built' });
    }
    const args = [filePath];
    if (fast) args.push('--fast');
    const proc = spawn(OCR_BIN, args);
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => resolve({ ok: false, pages: [], error: e.message }));
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve(parsed);
      } catch {
        resolve({ ok: false, pages: [], error: err.slice(0, 300) || 'ocr_bad_output' });
      }
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
 * Risk decides the ceremony (R4). Low risk earns the three-tap path; anything
 * uncertain, bulky, or bound for a shared destination gets the review table.
 */
export function assessRisk(items, { destinationShared = false } = {}) {
  if (destinationShared) return 'high';
  if (!items.length) return 'low';
  const minConf = Math.min(...items.map((i) => i.confidence ?? 0));
  const anyReview = items.some((i) => i.needs_review);
  if (anyReview || items.length > 3 || minConf < 0.8) return 'high';
  return 'low';
}

/** Attach OCR geometry to an AI-produced item by locating its verbatim quote. */
function locateQuote(quote, lines) {
  if (!quote) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  let best = null, bestScore = 0;
  for (const line of lines) {
    const l = norm(line.text);
    if (!l) continue;
    let score = 0;
    if (l === q) score = 1;
    else if (l.includes(q) || q.includes(l)) score = 0.8;
    else {
      const qt = new Set(q.split(' '));
      const lt = new Set(l.split(' '));
      let shared = 0;
      for (const t of qt) if (lt.has(t)) shared++;
      score = (2 * shared) / (qt.size + lt.size);
    }
    if (score > bestScore) { bestScore = score; best = line; }
  }
  return bestScore >= 0.45 ? best : null;
}

function normaliseAIItems(aiItems, lines) {
  return aiItems.map((a) => {
    const line = locateQuote(a.source_text, lines);
    const item = {
      kind: a.kind === 'deadline' ? 'deadline' : 'event',
      title: (a.title || '(untitled)').trim(),
      start_date: a.start_date || null,
      start_time: a.start_time || null,
      end_date: a.end_date || null,
      end_time: a.end_time || null,
      all_day: a.start_time ? 0 : 1,
      location: a.location || null,
      owner: a.owner || null,
      cost: a.cost || null,
      notes: a.notes || null,
      confidence: typeof a.confidence === 'number' ? Math.max(0.05, Math.min(0.99, a.confidence)) : 0.6,
      recurrence_suggestion: a.repeats_hint
        ? JSON.stringify({ phrase: a.repeats_hint, accepted: false, freq: null, interval: null, byday: null })
        : null,
      recurrence_accepted: 0,
      rrule: null,
      satisfied: 0,
      question: a.unresolved || null,
      heading: null,
      src_page: line?.page ?? 1,
      src_bbox: line?.bbox ? JSON.stringify(line.bbox) : null,
      src_raw: a.source_text || null,
      src_interpretation: a.interpretation || null,
    };
    item.needs_review = (!item.start_date || item.confidence < 0.75 || a.unresolved) ? 1 : 0;
    item.fingerprint = fingerprint(item);
    return item;
  });
}

/**
 * @param {{kind:'image'|'pdf'|'text', filePath?, text?, filename?, anchor?, useAI?, reference?}} opts
 */
export async function extract(opts) {
  const reference = opts.reference || today();
  const wantAI = Boolean(opts.useAI) && aiAvailable();

  let lines = [];
  let page = { width: null, height: null };
  let engineParts = [];
  let ocrError = null;

  if (opts.kind === 'text') {
    lines = linesFromText(opts.text);
    engineParts.push('text');
  } else {
    const ocr = await runOCR(opts.filePath);
    if (ocr.ok) {
      lines = ocr.pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })));
      page = { width: ocr.pages[0]?.width ?? null, height: ocr.pages[0]?.height ?? null };
      // Report what actually read it: 'pdf-text' means the PDF's own text layer.
      engineParts.push(ocr.engine || 'vision');
    } else {
      ocrError = ocr.error || 'ocr_failed';
    }
  }

  let built = { items: [], anchor: null, questions: [], stats: {} };
  if (lines.length) {
    built = buildItems(lines, { reference, anchor: opts.anchor });
    engineParts.push('grammar');
  }

  let aiError = null;
  if (wantAI) {
    let base64 = null;
    if (opts.filePath) {
      try { base64 = fs.readFileSync(opts.filePath).toString('base64'); } catch { /* ignore */ }
    }
    const ai = await extractWithAI({
      base64,
      filename: opts.filename,
      isPdf: opts.kind === 'pdf',
      text: opts.kind === 'text' ? opts.text : null,
      reference,
    });
    if (ai.ok && ai.items.length) {
      built.items = normaliseAIItems(ai.items, lines);
      engineParts.push('ai');
    } else if (!ai.ok) {
      aiError = ai.error;
    }
  }

  const risk = assessRisk(built.items);
  return {
    lines,
    page,
    items: built.items,
    anchor: built.anchor,
    questions: built.questions,
    stats: built.stats,
    risk,
    engine: engineParts.join('+') || 'none',
    ocrError,
    aiError,
    aiAvailable: aiAvailable(),
  };
}
