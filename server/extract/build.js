// Turns raw grammar hits into reviewable items: one place where confidence,
// provenance and the anchor calendar are applied.

import crypto from 'node:crypto';
import {
  findDates, findWeekRefs, findTimes, detectDeadline, detectRecurrence,
  extractContext, deriveTitle, looksLikeHeading,
} from './grammar.js';
import { addDays, mondayOf, nextDow, today, iso, MONTHS, isValidYMD } from '../lib/dates.js';
import { groupRows } from './rows.js';

const RANGE_BETWEEN = /^\s*(?:-|–|—|to|until|till|through|thru)\s*$/i;

export function fingerprint(item) {
  const norm = (item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return crypto.createHash('sha1')
    .update(`${norm}|${item.start_date || ''}|${item.start_time || ''}|${item.kind}`)
    .digest('hex').slice(0, 16);
}

/**
 * Many documents declare their own week-1 anchor ("Week 1 commences Monday 22
 * September"). Finding it in the same document is what makes "Wk 7 (Fri)"
 * resolvable without asking the user anything.
 */
export function deriveAnchorFromDocument(lines, reference = today()) {
  let week1Start = null;
  const skipWeeks = [];
  for (const line of lines) {
    const t = line.text;
    if (!week1Start && /\b(?:week\s*1|wk\s*1|week\s+one)\b/i.test(t)
        && /\b(?:commenc|begin|start)/i.test(t)) {
      const d = findDates(t, { reference })[0];
      if (d) week1Start = mondayOf(d.date);
    }
    if (/\b(?:reading|consolidation|revision|no\s+teaching|enrichment)\s+week\b/i.test(t)) {
      const d = findDates(t, { reference })[0];
      if (d) skipWeeks.push(mondayOf(d.date));
    }
  }
  return week1Start ? { week1Start, skipWeeks, source: 'document' } : null;
}

/** Week N resolves by walking Mondays forward, skipping non-teaching weeks. */
export function resolveWeekRef(ref, anchor) {
  if (!anchor?.week1Start) return null;
  const skips = new Set(anchor.skipWeeks || []);
  let monday = anchor.week1Start;
  for (let week = 1; week < ref.week; week++) {
    monday = addDays(monday, 7);
    while (skips.has(monday)) monday = addDays(monday, 7);
  }
  const date = ref.dow != null ? nextDow(monday, ref.dow) : monday;
  return { date, explanation: `Week ${ref.week}${ref.dowRaw ? ` (${ref.dowRaw})` : ''} → ${date}, counting from week 1 on ${anchor.week1Start}${skips.size ? `, skipping ${skips.size} non-teaching week(s)` : ''}` };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function scoreConfidence(f) {
  let c = f.ocr ?? 0.9;
  c *= 0.62 + 0.38 * (f.specificity ?? 0.8);
  if (f.hasYear === false) c -= 0.04;
  if (f.ambiguousOrder) c -= 0.16;
  if (!f.title || f.title.length < 4) c -= 0.32;
  if (f.title && f.title.length > 90) c -= 0.06;
  if (f.multipleUnjoined) c -= 0.14;
  if (f.fromHeadingTitle) c -= 0.08;
  if (f.unresolvedRelative) c = Math.min(c, 0.34);
  if (f.needsStartDate) c = Math.min(c, 0.30);
  return clamp(Number(c.toFixed(3)), 0.05, 0.99);
}

const REVIEW_THRESHOLD = 0.75;

/**
 * @param lines  [{ text, confidence, bbox:[x,y,w,h], page }]
 * @param opts   { anchor, reference, defaultTz }
 */
export function buildItems(rawLines, opts = {}) {
  const lines = opts.groupRows === false ? rawLines : groupRows(rawLines);
  const reference = opts.reference || today();
  const docAnchor = deriveAnchorFromDocument(lines, reference);
  const anchor = opts.anchor?.week1Start ? opts.anchor : docAnchor;

  const items = [];
  const unresolvedQuestions = [];
  let heading = '';
  let lastItemIdx = -1;
  let prevPlainText = null;
  let lastLineBBox = null;

  lines.forEach((line, lineNo) => {
    const text = (line.text || '').trim();
    if (!text) return;

    const dates = findDates(text, { reference });
    const times = findTimes(text);
    const weekRefs = findWeekRefs(text);
    const rec = detectRecurrence(text);

    if (!dates.length && !weekRefs.length && looksLikeHeading(line)) {
      heading = text;
      lastItemIdx = -1;
      return;
    }

    // A week-1 declaration defines the anchor; it is not itself a commitment.
    if (anchor?.source === 'document'
        && /\b(?:week\s*1|wk\s*1|week\s+one)\b/i.test(text)
        && /\b(?:commenc|begin|start)/i.test(text)) { prevPlainText = text; return; }

    const ctx = extractContext(text);
    const dl = detectDeadline(text, heading);

    const push = (partial, spans, extra = {}) => {
      const derived = deriveTitle(text, [...spans, rec].filter(Boolean));
      // Fall back through: the line itself, its section heading, then the line
      // above it (posters and tables put the name on a separate line).
      const title = derived || heading || prevPlainText || '(untitled)';
      const usedHeading = !derived;
      const conf = scoreConfidence({
        ocr: line.confidence, title,
        fromHeadingTitle: usedHeading,
        ...extra,
      });
      const item = {
        kind: dl.isDeadline ? 'deadline' : 'event',
        title,
        start_date: null, start_time: null, end_date: null, end_time: null,
        all_day: 1,
        location: ctx.location, cost: ctx.cost, owner: null, notes: null,
        confidence: conf,
        needs_review: conf < REVIEW_THRESHOLD || !!extra.unresolvedRelative || !!extra.needsStartDate ? 1 : 0,
        recurrence_suggestion: rec ? JSON.stringify(rec) : null,
        recurrence_accepted: 0,
        rrule: null,
        satisfied: 0,
        src_page: line.page ?? 1,
        src_bbox: line.bbox ? JSON.stringify(line.bbox) : null,
        src_raw: text,
        src_interpretation: null,
        src_line: lineNo,
        heading: heading || null,
        deadline_marker: dl.marker,
        ...partial,
      };
      item.fingerprint = fingerprint(item);
      items.push(item);
      lastItemIdx = items.length - 1;
      lastLineBBox = line.bbox;
      return item;
    };

    if (dates.length) {
      // A range on one line: "Monday 16 February to Friday 20 February".
      const joinedRange = dates.length === 2
        && RANGE_BETWEEN.test(text.slice(dates[0].index + dates[0].length, dates[1].index));

      if (joinedRange) {
        const t = times[0];
        push({
          start_date: dates[0].date, end_date: dates[1].date,
          start_time: t?.start ?? null, end_time: t?.end ?? null,
          all_day: t ? 0 : 1,
          src_interpretation: `${dates[0].raw} → ${dates[1].raw} (range)`,
        }, [...dates, ...times], {
          specificity: Math.min(dates[0].specificity, dates[1].specificity),
          hasYear: dates[0].hasYear, ambiguousOrder: dates[0].ambiguousOrder,
        });
      } else {
        dates.forEach((d, i) => {
          const t = times[i] || (dates.length === 1 ? times[0] : null);
          const interp = d.type === 'week-commencing'
            ? `${d.raw} → week beginning ${d.date}`
            : `${d.raw} → ${d.date}`;
          push({
            start_date: d.date,
            end_date: null,
            start_time: t?.start ?? null,
            end_time: t?.end ?? null,
            all_day: t ? 0 : 1,
            src_interpretation: interp + (t ? ` at ${t.raw}` : ''),
          }, [d, ...(t ? [t] : [])], {
            specificity: d.specificity, hasYear: d.hasYear,
            ambiguousOrder: d.ambiguousOrder,
            multipleUnjoined: dates.length > 1,
          });
        });
      }
      return;
    }

    if (weekRefs.length) {
      weekRefs.forEach((w) => {
        const resolved = resolveWeekRef(w, anchor);
        const t = times[0];
        const item = push({
          start_date: resolved?.date ?? null,
          start_time: t?.start ?? null,
          end_time: t?.end ?? null,
          all_day: t ? 0 : 1,
          src_interpretation: resolved
            ? resolved.explanation
            : `${w.raw} → needs a "week 1 starts" date before it can be resolved`,
        }, [w, ...times], {
          specificity: 0.8,
          unresolvedRelative: !resolved,
        });
        if (!resolved) {
          item.question = 'When does week 1 start? Set a term anchor and this resolves automatically.';
          unresolvedQuestions.push({ type: 'anchor', item: item.title, raw: w.raw });
        }
      });
      return;
    }

    // A recurring thing with no date at all ("every Tuesday 3:15pm"). We refuse
    // to invent a start date; we ask for one.
    if (rec && (times.length || /\bclub|class|lesson|session|meeting|practice|training\b/i.test(text))) {
      const t = times[0];
      const item = push({
        start_date: null,
        start_time: t?.start ?? null,
        end_time: t?.end ?? null,
        all_day: t ? 0 : 1,
        src_interpretation: `"${rec.phrase}" → repeats, but the document gives no start date`,
      }, [...times], { specificity: 0.7, needsStartDate: true });
      item.question = 'This repeats but has no start date in the document. When does it begin?';
      unresolvedQuestions.push({ type: 'start-date', item: item.title, raw: rec.phrase });
      return;
    }

    // A line that is only a time, just under a dated line, belongs to it.
    // Posters do this constantly: the date on one line, "6:30pm - 8:00pm" below.
    if (times.length && lastItemIdx >= 0) {
      const prev = items[lastItemIdx];
      const nearby = lineNo - (prev.src_line ?? -99) <= 2;
      if (nearby && !prev.start_time) {
        prev.start_time = times[0].start;
        prev.end_time = times[0].end;
        prev.all_day = 0;
        prev.fingerprint = fingerprint(prev);
        lastLineBBox = line.bbox;
        return;
      }
    }

    // Otherwise: possible continuation of the previous item (indented detail).
    if (lastItemIdx >= 0 && lastLineBBox && line.bbox) {
      const indented = line.bbox[0] > lastLineBBox[0] + 0.005;
      const adjacent = Math.abs(line.bbox[1] - lastLineBBox[1]) < 0.06;
      if (indented && adjacent && text.length < 160) {
        const prev = items[lastItemIdx];
        prev.notes = prev.notes ? `${prev.notes} ${text}` : text;
        if (!prev.location && ctx.location) prev.location = ctx.location;
        if (!prev.cost && ctx.cost) prev.cost = ctx.cost;
        if (times.length && !prev.start_time) {
          prev.start_time = times[0].start;
          prev.end_time = times[0].end;
          prev.all_day = 0;
        }
        prev.fingerprint = fingerprint(prev);
        lastLineBBox = line.bbox;
      }
    }
    if (!dates.length && !weekRefs.length && text.length > 3 && text.length < 90) prevPlainText = text;
  });

  // Same title + same date twice in one document is a duplicate, not two events.
  const seen = new Map();
  const deduped = [];
  for (const it of items) {
    const key = it.fingerprint;
    if (seen.has(key)) {
      const keep = seen.get(key);
      if ((it.confidence ?? 0) > (keep.confidence ?? 0)) {
        deduped[deduped.indexOf(keep)] = it;
        seen.set(key, it);
      }
      continue;
    }
    seen.set(key, it);
    deduped.push(it);
  }

  return {
    items: deduped,
    anchor,
    questions: unresolvedQuestions,
    stats: {
      lines: lines.length,
      found: deduped.length,
      needsReview: deduped.filter((i) => i.needs_review).length,
      deadlines: deduped.filter((i) => i.kind === 'deadline').length,
      withRecurrenceHint: deduped.filter((i) => i.recurrence_suggestion).length,
    },
  };
}

export { REVIEW_THRESHOLD };
