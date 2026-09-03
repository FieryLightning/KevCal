// Turns raw grammar hits into reviewable items: one place where confidence,
// provenance and the anchor calendar are applied.

import crypto from 'node:crypto';
import {
  findDates, findWeekRefs, findTimes, detectDeadline, detectRecurrence,
  extractContext, deriveTitle, looksLikeHeading,
} from './grammar.js';
import { addDays, mondayOf, nextDow, today, iso, isValidYMD, daysBetween } from '../lib/dates.js';
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

    /**
     * @param srcText  the span this item was derived from — a segment of the line
     *                 when one line carries several dates.
     * @param recSpan  the recurrence phrase to strip, when it falls in this segment.
     */
    const push = (partial, spans, extra = {}, srcText = text, recSpan = rec) => {
      const derived = deriveTitle(srcText, [...spans, recSpan].filter(Boolean));
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
        recurrence_suggestion: recSpan ? JSON.stringify(recSpan) : null,
        recurrence_accepted: 0,
        rrule: null,
        satisfied: 0,
        src_page: line.page ?? 1,
        src_bbox: line.bbox ? JSON.stringify(line.bbox) : null,
        src_raw: srcText.trim(),
        src_interpretation: null,
        src_line: lineNo,
        heading: heading || null,
        deadline_marker: dl.marker,
        _hasYear: extra.hasYear !== false,
        ...partial,
      };
      item.fingerprint = fingerprint(item);
      items.push(item);
      lastItemIdx = items.length - 1;
      lastLineBBox = line.bbox;
      return item;
    };

    if (dates.length) {
      // Several dates on one line. PDFs routinely deliver a whole paragraph as a
      // single string, so split the text around each date; otherwise every item
      // inherits the entire blob as its title. In these documents the label
      // always precedes its date ("INSET Day (school closed): Monday 31 August"),
      // so each segment runs from the end of the previous date to the end of this one.
      const entries = mergeRangePairs(text, dates);

      entries.forEach((e, i) => {
        const prev = entries[i - 1];
        const segStart = prev ? prev.index + prev.length : 0;
        const segEnd = entries[i + 1] ? e.index + e.length : text.length;
        const segText = text.slice(segStart, segEnd);

        const localSpans = e.parts.map((p) => ({ ...p, index: p.index - segStart }));
        let localTimes = times
          .filter((t) => t.index >= segStart && t.index < segEnd)
          .map((t) => ({ ...t, index: t.index - segStart }));
        if (!localTimes.length && entries.length === 1 && times[0]) localTimes = [times[0]];

        const localRec = rec && rec.index >= segStart && rec.index < segEnd
          ? { ...rec, index: rec.index - segStart }
          : null;

        const t = localTimes[0];
        const first = e.parts[0];
        const interp = e.endDate
          ? `${e.parts[0].raw} → ${e.parts[1].raw} (range)`
          : first.type === 'week-commencing'
            ? `${first.raw} → week beginning ${e.date}`
            : `${first.raw} → ${e.date}`;

        push({
          start_date: e.date,
          end_date: e.endDate ?? null,
          start_time: t?.start ?? null,
          end_time: t?.end ?? null,
          all_day: t ? 0 : 1,
          src_interpretation: interp + (t ? ` at ${t.raw}` : ''),
        }, [...localSpans, ...localTimes], {
          specificity: first.specificity, hasYear: first.hasYear,
          ambiguousOrder: first.ambiguousOrder,
          multipleUnjoined: entries.length > 1 && !e.endDate,
        }, segText, localRec);
      });
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

  resolveYearsFromContext(items);

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
  deduped.forEach((i) => { delete i._hasYear; });

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

/**
 * A date written without a year belongs to the document it sits in, not to
 * today's calendar. "RSVP by 10 October" on a poster for an event on 15 October
 * 2025 means 2025 — inferring 2026 from today's date puts the deadline five days
 * AFTER the thing it is a deadline for. So snap yearless dates to the nearest
 * date in the same document that stated its year outright.
 */
/**
 * Collapse "16 February 2026 to 20 February 2026" into one dated entry, even
 * when it sits among other dates on the same line.
 */
function mergeRangePairs(text, dates) {
  const entries = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const next = dates[i + 1];
    if (next && RANGE_BETWEEN.test(text.slice(d.index + d.length, next.index))) {
      // A range read backwards is a misread, not a fact. Order it.
      const [from, to] = d.date <= next.date ? [d.date, next.date] : [next.date, d.date];
      entries.push({
        date: from,
        endDate: to,
        index: d.index,
        length: (next.index + next.length) - d.index,
        parts: [d, next],
      });
      i++;
      continue;
    }
    entries.push({ date: d.date, endDate: null, index: d.index, length: d.length, parts: [d] });
  }
  return entries;
}

function resolveYearsFromContext(items) {
  const anchored = items.filter((i) => i._hasYear && i.start_date);
  if (!anchored.length) return;

  for (const item of items) {
    if (item._hasYear || !item.start_date) continue;

    // Nearest anchored item by position in the document.
    let nearest = null;
    let bestDistance = Infinity;
    for (const a of anchored) {
      const d = Math.abs((a.src_line ?? 0) - (item.src_line ?? 0));
      if (d < bestDistance) { bestDistance = d; nearest = a; }
    }
    if (!nearest || bestDistance > 12) continue;

    const [, month, day] = item.start_date.split('-').map(Number);
    const anchorYear = Number(nearest.start_date.slice(0, 4));
    let best = item.start_date;
    let bestGap = Infinity;
    for (const y of [anchorYear - 1, anchorYear, anchorYear + 1]) {
      if (!isValidYMD(y, month, day)) continue;
      const candidate = iso(y, month, day);
      const gap = Math.abs(daysBetween(nearest.start_date, candidate));
      if (gap < bestGap) { bestGap = gap; best = candidate; }
    }

    if (best !== item.start_date) {
      item.src_interpretation = `${item.src_interpretation || ''} — year taken as ${best.slice(0, 4)} from “${nearest.title}” elsewhere in the document`.trim();
      item.start_date = best;
      item.fingerprint = fingerprint(item);
    }
  }
}

export { REVIEW_THRESHOLD };
