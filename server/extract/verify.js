// The checker. Everything the reader was forbidden from working out is worked
// out here, in one testable place, with a flag attached whenever the answer
// required a choice.
//
// The rule the whole file exists to enforce: if there is more than one defensible
// reading, KevCal does not pick one quietly. It picks the most likely, says so in
// words, and offers the alternative as a button.
//
// Flag levels:
//   blocker — the app has no answer, or two sources actively disagree. Cannot be
//             added to a calendar until a human resolves it.
//   check   — the app has a defensible answer but had to choose. Shown in amber
//             with one-tap alternatives; can be added.

import {
  DOW, DOW_NAMES, iso, isValidYMD, addDays, dayOfWeek, daysBetween,
  formatHuman, formatTime, inferYear, toDate, fromDate,
} from '../lib/dates.js';
import { findDates } from './grammar.js';

/** Hours after midnight during which "tomorrow" is genuinely ambiguous. */
const SMALL_HOURS = 6;
/** A date this far ahead is more likely a misread than a real plan. */
const FAR_FUTURE_DAYS = 550;
/** Grace before "this is in the past" is worth raising. */
const PAST_GRACE_DAYS = 1;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

function flag(code, level, message, options = []) {
  return { code, level, message, options };
}

function validISO(v) {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return isValidYMD(y, m, d);
}

function normTime(v) {
  if (typeof v !== 'string' || !HHMM.test(v.trim())) return null;
  const [h, m] = v.trim().split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The next given weekday strictly after a date. */
function weekdayAfter(dateStr, targetDow) {
  const cur = dayOfWeek(dateStr);
  const delta = ((targetDow - cur + 7) % 7) || 7;
  return addDays(dateStr, delta);
}

/** The given weekday on or after a date. */
function weekdayOnOrAfter(dateStr, targetDow) {
  const cur = dayOfWeek(dateStr);
  return addDays(dateStr, (targetDow - cur + 7) % 7);
}

function endOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, last);
}

/** The nearest date to `dateStr` that falls on `targetDow`, within a week. */
function nearestWeekday(dateStr, targetDow) {
  const cur = dayOfWeek(dateStr);
  let delta = (targetDow - cur + 7) % 7;
  if (delta > 3) delta -= 7;
  return addDays(dateStr, delta);
}

function human(dateStr) {
  return formatHuman(dateStr, { withDow: true, withYear: false });
}

// ---------------------------------------------------------------- relative dates

/**
 * Resolve relative wording against an anchor day.
 *
 * The anchor is the day the DOCUMENT was written, not the day you photographed
 * it. A letter dated Monday saying "tomorrow" means Tuesday, however long it sat
 * in the bottom of a school bag — so a printed document date always wins over
 * the clock, and when there isn't one, the uncertainty is reported rather than
 * absorbed.
 */
function resolveRelative(item, ctx) {
  const kind = item.relative_kind || 'other';
  const weekdayName = String(item.relative_weekday || '').toLowerCase();
  const dow = DOW[weekdayName];
  const n = Number.isInteger(item.relative_n) ? item.relative_n : null;
  const phrase = item.relative_phrase || kind;

  const anchor = ctx.documentDate || ctx.photoDate || ctx.now.date;
  const anchorSource = ctx.documentDate ? 'document' : (ctx.photoDate ? 'photo' : 'now');

  let date = null;
  let alternative = null;      // the other defensible reading, if there is one
  let altLabel = null;

  switch (kind) {
    case 'today':
      date = anchor;
      break;
    case 'tonight':
      date = anchor;
      break;
    case 'tomorrow':
      date = addDays(anchor, 1);
      break;
    case 'this_weekday':
      if (dow == null) break;
      date = weekdayOnOrAfter(anchor, dow);
      break;
    case 'next_weekday':
      if (dow == null) break;
      // "Next Friday" is ambiguous in ordinary English and always has been:
      // some people mean the coming one, some mean the one after. Offer both.
      date = weekdayAfter(anchor, dow);
      alternative = addDays(date, 7);
      altLabel = 'the week after';
      break;
    case 'in_n_days':
      if (n == null) break;
      date = addDays(anchor, n);
      break;
    case 'in_n_weeks':
      if (n == null) break;
      date = addDays(anchor, n * 7);
      break;
    case 'end_of_month':
      date = endOfMonth(anchor);
      break;
    default:
      break;
  }

  if (!date) {
    return {
      date: null,
      flags: [flag('relative_unresolved', 'blocker',
        item.unresolved
          ? String(item.unresolved)
          : `"${phrase}" — I can't work out which day this means. Pick a date.`)],
      note: null,
    };
  }

  const flags = [];
  const anchorPhrase = anchorSource === 'document'
    ? `the document's own date (${human(anchor)})`
    : anchorSource === 'photo'
      ? `the day you took the photo (${human(anchor)})`
      : `today (${human(anchor)})`;
  const note = `"${phrase}" counted from ${anchorPhrase} → ${formatHuman(date)}`;

  const options = [{ label: formatHuman(date, { withYear: false }), patch: { start_date: date } }];

  // 1. Nothing dated the document, so the anchor is a guess about when it was
  //    written. That guess is exactly the thing that goes wrong.
  if (anchorSource !== 'document') {
    const yesterdayReading = addDays(date, -1);
    if (ctx.now.hour < SMALL_HOURS && anchorSource === 'now') {
      // The small-hours trap the user asked for by name: at 00:20, a letter
      // written "yesterday evening" says tomorrow and means the day that has,
      // by the clock, already started.
      flags.push(flag('midnight_ambiguity', 'blocker',
        `It's ${formatTime(ctx.now.time)} — so "${phrase}" could mean either day. Which one?`,
        [
          { label: `${human(date)} (counting from today)`, patch: { start_date: date } },
          { label: `${human(yesterdayReading)} (if it was written last night)`, patch: { start_date: yesterdayReading } },
        ]));
    } else if (anchorSource === 'photo') {
      flags.push(flag('relative_photo_anchor', 'check',
        `"${phrase}" is counted from the day you took the photo, ${human(ctx.photoDate)}. Was the document written that day?`,
        [
          { label: `${human(date)} (from the photo's day)`, patch: { start_date: date } },
          { label: `${human(addDays(ctx.now.date, kind === 'tomorrow' ? 1 : 0))} (from today)`, patch: { start_date: addDays(ctx.now.date, kind === 'tomorrow' ? 1 : 0) } },
        ]));
    } else {
      flags.push(flag('relative_no_document_date', 'check',
        `"${phrase}" is counted from today, because the document doesn't say when it was written.`,
        options));
    }
  }

  // 2. Genuinely ambiguous English, regardless of anchor.
  if (alternative) {
    flags.push(flag('relative_ambiguous_phrase', 'blocker',
      `"${phrase}" could be either of these. Which did they mean?`,
      [
        { label: `${human(date)} (the coming one)`, patch: { start_date: date } },
        { label: `${human(alternative)} (${altLabel})`, patch: { start_date: alternative } },
      ]));
  }

  return { date, flags, note };
}

// ---------------------------------------------------------------- checks

/**
 * Cross-check the reader against the words it says it read. The reader is not
 * allowed to be the only witness to its own answer.
 */
function checkAgainstQuote(item, date, ctx) {
  const quote = String(item.source_quote || '');
  if (!quote.trim() || !date) return [];
  const flags = [];

  // The weekday the document printed, versus the weekday the date actually is.
  const stated = String(item.weekday_stated || '').toLowerCase().replace(/[^a-z]/g, '');
  const statedDow = DOW[stated];
  if (statedDow != null) {
    const actual = dayOfWeek(date);
    if (actual !== statedDow) {
      const moved = nearestWeekday(date, statedDow);
      flags.push(flag('weekday_mismatch', 'blocker',
        `The document says ${DOW_NAMES[statedDow]}, but ${human(date)} is a ${DOW_NAMES[actual]}. One of them is wrong.`,
        [
          { label: `Use ${human(moved)} (the ${DOW_NAMES[statedDow]})`, patch: { start_date: moved } },
          { label: `Keep ${human(date)}`, patch: { start_date: date } },
        ]));
    }
  }

  // If the reader says a year was printed, that year has to be in the words it
  // says it read. "Contract ends December 2031" filed under 2025 fails here even
  // though the grammar cannot parse a bare month-and-year into a day at all —
  // which is exactly the hole the v1 disaster fell through.
  if (item.has_explicit_year === true) {
    const years = quote.match(/(?<![£$€\d.,])\b(?:19|20)\d{2}\b/g) || [];
    const mine = date.slice(0, 4);
    if (years.length && !years.includes(mine)) {
      const [, mo, d] = date.split('-').map(Number);
      const swapped = Number(years[0]);
      const options = [];
      if (isValidYMD(swapped, mo, d)) {
        options.push({ label: `Use ${formatHuman(iso(swapped, mo, d))}`, patch: { start_date: iso(swapped, mo, d) } });
      }
      options.push({ label: `Keep ${formatHuman(date)}`, patch: { start_date: date } });
      flags.push(flag('year_mismatch', 'blocker',
        `The text says ${years[0]}, but this is filed under ${mine}. One of us has misread it.`,
        options));
    }
  }

  // Re-read the quote with the deterministic grammar. This is the second half of
  // the same idea: the reader is never the only witness to its own answer.
  let reparsed = [];
  try { reparsed = findDates(quote, { reference: ctx.now.date }); } catch { reparsed = []; }
  const absolute = reparsed.filter((d) => d.type === 'absolute');
  if (absolute.length === 1) {
    const mine = absolute[0].date;
    // A range's quote names both ends, and the grammar frequently only parses
    // the second of them ("9-13 November"). Agreeing with either end is
    // agreement; only matching neither is a contradiction.
    const targets = [date, validISO(item.end_date) ? item.end_date : null].filter(Boolean);
    const sameMonthDay = targets.some((t) => t.slice(5) === mine.slice(5));
    const sameYear = targets.some((t) => t.slice(0, 4) === mine.slice(0, 4));
    if (!sameMonthDay) {
      flags.push(flag('quote_mismatch', 'blocker',
        `Reading "${absolute[0].raw}" myself I get ${human(mine)}, not ${human(date)}. Which is right?`,
        [
          { label: `${formatHuman(mine)} (from the text)`, patch: { start_date: mine } },
          { label: `${formatHuman(date)}`, patch: { start_date: date } },
        ]));
    } else if (!sameYear && absolute[0].hasYear) {
      flags.push(flag('year_mismatch', 'blocker',
        `The text prints ${absolute[0].raw}, which reads as ${mine.slice(0, 4)}, but this is filed under ${date.slice(0, 4)}.`,
        [
          { label: `Use ${formatHuman(mine)}`, patch: { start_date: mine } },
          { label: `Keep ${formatHuman(date)}`, patch: { start_date: date } },
        ]));
    }
  }

  return flags;
}

/**
 * Dates on documents are overwhelmingly soon and ahead. A date behind us, or
 * years out, is far more often a misreading than a real plan — so it is never
 * silently corrected and never silently accepted either.
 */
function checkPlausibility(date, ctx) {
  const flags = [];
  const delta = daysBetween(ctx.now.date, date);

  if (delta < -PAST_GRACE_DAYS) {
    const ago = Math.abs(delta);
    const [y, m, d] = date.split('-').map(Number);
    const nextYear = isValidYMD(y + 1, m, d) ? iso(y + 1, m, d) : null;
    const options = [{ label: `Keep ${formatHuman(date)}`, patch: { start_date: date } }];
    if (nextYear) options.unshift({ label: `Did you mean ${formatHuman(nextYear)}?`, patch: { start_date: nextYear } });
    flags.push(flag('in_the_past', 'check',
      ago > 400
        ? `That's ${Math.round(ago / 365 * 10) / 10} years ago. Worth a look.`
        : `That's ${ago} day${ago === 1 ? '' : 's'} ago — already gone.`,
      options));
  }

  if (delta > FAR_FUTURE_DAYS) {
    const years = Math.round(delta / 365 * 10) / 10;
    flags.push(flag('far_future', 'check',
      `That's ${years} years away. Documents rarely reach that far, so it's worth checking the year.`,
      [{ label: `Keep ${formatHuman(date)}`, patch: { start_date: date } }]));
  }

  return flags;
}

/** An end time that fell behind its start when the start moved to the afternoon. */
function shiftPM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (h >= 1 && h <= 11) return `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return hhmm;
}

function checkTime(item, date, flags) {
  const start = normTime(item.start_time);
  const end = normTime(item.end_time);
  if (!start) return { start: null, end: null };

  if (item.am_pm_stated === false) {
    const [h, m] = start.split(':').map(Number);
    if (h >= 1 && h <= 7) {
      // "3.30" on a letter is the afternoon essentially always: nothing on a
      // school newsletter or an appointment card happens at half past three in
      // the morning. Reading it as am is not neutral, it is just wrong more
      // often — so flip it, say plainly that it was flipped, and offer the undo.
      const pm = `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      flags.push(flag('am_pm_assumed', 'check',
        `The document doesn't say am or pm. At that hour it's almost always the afternoon, so I've read it as ${formatTime(pm)}.`,
        [
          { label: formatTime(pm), patch: { start_time: pm } },
          { label: `No, ${formatTime(start)}`, patch: { start_time: start } },
        ]));
      return { start: pm, end: end && end < pm ? shiftPM(end) : end };
    }
    if (h >= 8 && h <= 11) {
      const other = `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      flags.push(flag('am_pm_assumed', 'check',
        `The document doesn't say am or pm. I've read it as ${formatTime(start)}.`,
        [
          { label: formatTime(start), patch: { start_time: start } },
          { label: formatTime(other), patch: { start_time: other } },
        ]));
    } else if (h >= 13 && h <= 23) {
      const other = `${String(h - 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      flags.push(flag('am_pm_assumed', 'check',
        `The document doesn't say am or pm. I've read it as ${formatTime(start)}.`,
        [
          { label: formatTime(start), patch: { start_time: start } },
          { label: formatTime(other), patch: { start_time: other } },
        ]));
    }
  }

  if (start && end && date && end < start) {
    flags.push(flag('end_before_start', 'check',
      `It ends (${formatTime(end)}) before it starts (${formatTime(start)}). Probably runs past midnight, or one is misread.`));
  }

  return { start, end };
}

// ---------------------------------------------------------------- main

/**
 * @param {object[]} rawItems   items as the reader reported them
 * @param {{now:{date,time,hour}, tz?, documentDate?, documentSpan?, photoDate?}} ctx
 * @returns {object[]} items in KevCal's internal shape, each with `flags`
 */
export function verifyItems(rawItems, ctx) {
  const out = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const flags = [];
    let date = null;
    let note = raw.interpretation || null;
    let basis = 'explicit';

    // 1. Relative wording is resolved here and only here. Whatever the reader
    //    put in start_date is discarded: it was told not to do this arithmetic,
    //    and trusting it when it does anyway is how you get a silent wrong day.
    if (raw.relative_phrase || raw.relative_kind) {
      const r = resolveRelative(raw, ctx);
      date = r.date;
      flags.push(...r.flags);
      if (r.note) note = r.note;
      basis = 'relative';
    } else if (raw.start_date == null) {
      basis = 'none';
    } else if (!validISO(raw.start_date)) {
      // An impossible date is reported as unreadable. It is NEVER rounded to a
      // nearby real one — that is how 29 February 2027 quietly became 20 February.
      flags.push(flag('impossible_date', 'blocker',
        `"${raw.start_date}" isn't a real date, so I haven't guessed at one. Pick the right day.`));
      basis = 'none';
    } else {
      date = raw.start_date;
    }

    // 2. A year nobody printed is an assumption, and it gets said out loud.
    if (date && raw.has_explicit_year === false) {
      const [, mo, d] = date.split('-').map(Number);
      const spanYear = yearFromSpan(ctx.documentSpan, mo);
      if (spanYear && isValidYMD(spanYear, mo, d)) {
        if (spanYear !== Number(date.slice(0, 4))) date = iso(spanYear, mo, d);
        note = note || `Year taken from the document's own "${ctx.documentSpan}"`;
      } else if (ctx.documentDate) {
        // Dates in a letter belong to the letter's own year, reading forwards
        // from the day it was written.
        const fromDoc = inferYear(mo, d, ctx.documentDate);
        if (isValidYMD(fromDoc, mo, d)) date = iso(fromDoc, mo, d);
        note = note || `Year taken from the document's own date, ${human(ctx.documentDate)}`;
      } else {
        const guessed = inferYear(mo, d, ctx.now.date);
        if (isValidYMD(guessed, mo, d)) date = iso(guessed, mo, d);
        const other = isValidYMD(guessed + 1, mo, d) ? iso(guessed + 1, mo, d) : null;
        const options = [{ label: String(guessed), patch: { start_date: date } }];
        if (other) options.push({ label: String(guessed + 1), patch: { start_date: other } });
        flags.push(flag('year_assumed', 'check',
          `No year printed next to this one, and nothing on the page dates itself — I've assumed ${guessed}.`,
          options));
      }
      basis = basis === 'explicit' ? 'year_assumed' : basis;
    }

    // 3. Everything that can disagree, made to disagree out loud.
    if (date) {
      flags.push(...checkAgainstQuote(raw, date, ctx));
      flags.push(...checkPlausibility(date, ctx));
    } else if (basis !== 'relative') {
      flags.push(flag('no_date', 'blocker',
        raw.unresolved || 'I couldn\'t find a date for this one. Add it, or drop it.'));
    }

    const { start, end } = checkTime(raw, date, flags);

    let endDate = validISO(raw.end_date) ? raw.end_date : null;
    if (endDate && date && endDate < date) {
      flags.push(flag('end_date_before_start', 'blocker',
        `The end (${human(endDate)}) is before the start (${human(date)}).`));
      endDate = null;
    }

    // 4. The reader's own doubts count as flags too — unless it has already been
    //    asked as the blocking question, in which case saying it twice is noise.
    const alreadyAsked = flags.some((f) => f.message === String(raw.unresolved));
    if (raw.unresolved && !alreadyAsked && !flags.some((f) => f.code === 'no_date')) {
      flags.push(flag('reader_unsure', 'check', String(raw.unresolved)));
    }
    const confidence = clamp01(raw.confidence, 0.6);
    if (confidence < 0.7 && !flags.length) {
      flags.push(flag('low_confidence', 'check',
        'The page was hard to read here — worth a glance before you keep it.'));
    }

    const hasBlocker = flags.some((f) => f.level === 'blocker');
    const title = cleanTitle(raw.title);

    out.push({
      kind: raw.kind === 'deadline' ? 'deadline' : 'event',
      title,
      start_date: date,
      start_time: start,
      end_date: endDate,
      end_time: end,
      all_day: start ? 0 : 1,
      location: str(raw.location),
      owner: str(raw.owner),
      cost: str(raw.cost),
      notes: str(raw.notes),
      confidence,
      needs_review: hasBlocker || flags.length ? 1 : 0,
      blocked: hasBlocker ? 1 : 0,
      question: flags.find((f) => f.level === 'blocker')?.message
             ?? flags.find((f) => f.level === 'check')?.message
             ?? null,
      flags,
      date_basis: basis,
      recurrence_suggestion: raw.repeats_hint
        ? JSON.stringify({ phrase: String(raw.repeats_hint), accepted: false, freq: null, interval: null, byday: null })
        : null,
      recurrence_accepted: 0,
      rrule: null,
      satisfied: 0,
      heading: null,
      src_page: Number.isInteger(raw.page) ? raw.page : 1,
      src_bbox: boxToBBox(raw.box_2d),
      src_raw: str(raw.source_quote),
      src_interpretation: note,
    });
  }

  return out;
}

/**
 * "Academic Calendar 2026-2027" tells you which half of the span a bare month
 * belongs to: the year rolls over at the month the span starts in.
 */
export function yearFromSpan(span, month) {
  if (!span) return null;
  const m = String(span).match(/(\d{4})\s*[-–—/]\s*(\d{2,4})/);
  if (!m) {
    const single = String(span).match(/\b(20\d{2})\b/);
    return single ? Number(single[1]) : null;
  }
  const first = Number(m[1]);
  const second = m[2].length === 4 ? Number(m[2]) : Number(String(first).slice(0, 2) + m[2]);
  if (second !== first + 1) return first;
  // Academic and financial years overwhelmingly start in the second half.
  return month >= 8 ? first : second;
}

/** Gemini boxes are [ymin, xmin, ymax, xmax] over 0-1000; KevCal uses [x, y, w, h] over 0-1. */
export function boxToBBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = box.map(Number);
  if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) return null;
  const x = Math.max(0, Math.min(1, xmin / 1000));
  const y = Math.max(0, Math.min(1, ymin / 1000));
  const w = Math.max(0, Math.min(1 - x, (xmax - xmin) / 1000));
  const h = Math.max(0, Math.min(1 - y, (ymax - ymin) / 1000));
  if (w <= 0 || h <= 0) return null;
  return JSON.stringify([x, y, w, h]);
}

function clamp01(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.05, Math.min(0.99, n));
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, 2000) : null;
}

function cleanTitle(v) {
  const s = str(v);
  if (!s) return '(untitled)';
  return s.replace(/\s+/g, ' ').slice(0, 200);
}

export { SMALL_HOURS, FAR_FUTURE_DAYS };
