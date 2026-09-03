// Deterministic date/time grammar. This is Tier 1: it runs on text from the
// on-device OCR (or a paste) and needs no API key and no network.
//
// Design constraints taken directly from user research:
//   R1  Never emit a recurrence RULE. Emit what the document actually said, and
//       attach a *suggestion* the user must accept.
//   R3  Every item carries the raw span it came from and the bbox to crop.
//   R10 Capture the context fields (location, cost, owner), not just the date.
//   R11 Relative expressions ("Wk 7 (Fri)", "w/c 18 Nov") are RESOLVED when an
//       anchor is available and ASKED when it is not — never guessed.

import {
  MONTHS, DOW, iso, isValidYMD, inferYear, expandYear, normaliseTime,
  mondayOf, nextDow, addDays, today,
} from '../lib/dates.js';

const MONTH_RE = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
const DOW_RE = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun)';
const ORD = '(?:st|nd|rd|th)?';

const RANGE_JOINER = /^\s*(?:-|–|—|to|until|till|through|thru|and)\s*$/i;

const DEADLINE_MARKERS = /\b(deadline|due(?:\s+by)?|dueby|must\s+be\s+(?:paid|returned|submitted|received|completed)|return(?:ed)?\s+by|submit(?:ted)?\s+by|expir\w+|renew(?:al|ed)?\s+by|rsvp\s+by|closes?|closing|cut[\s-]?off|no\s+later\s+than|by\s+end\s+of|last\s+day|final\s+date|payment)\b/i;

const RECURRENCE_RE = /\b(every\s+other|every|each|weekly|fortnightly|bi[\s-]?weekly|monthly|daily|termly|annually|yearly)\b/i;

const LOCATION_RE = /\b(?:in|at)\s+((?:the\s+)?(?:room|hall|lecture theatre|theatre|building|centre|center|gate|hall|library|lab|gym|studio|suite|office|car park)\b[^.,;]{0,40}|[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,3}\s+(?:Room|Hall|Building|Centre|Center|Theatre|Library|Gate))/i;

const MONEY_RE = /(?:£|\$|€)\s?\d[\d,]*(?:\.\d{2})?/;

/** Escape helper for building the scanner. */
function rx(source, flags = 'gi') { return new RegExp(source, flags); }

// Ordered most-specific first; the scanner keeps the longest non-overlapping wins.
const DATE_PATTERNS = [
  {
    name: 'iso',
    re: rx(`\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`),
    build: (m) => ({ y: +m[1], mo: +m[2], d: +m[3], hasYear: true, specificity: 0.9 }),
  },
  {
    name: 'dmy',
    re: rx(`\\b(?:${DOW_RE}\\s*,?\\s+)?(\\d{1,2})(?!\\d)${ORD}\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:\\s*,?\\s+(\\d{4}|\\d{2})(?![\\d:]))?`),
    build: (m) => {
      const d = +m[1];
      const mo = MONTHS[m[2].toLowerCase().replace(/\./g, '')];
      const hasYear = !!m[3];
      const y = hasYear ? expandYear(m[3]) : null;
      return { y, mo, d, hasYear, specificity: 1.0 };
    },
  },
  {
    name: 'mdy',
    // (?!\\d) stops the day group eating the first digits of a bare year:
    // "December 2031" must NOT parse as "December 20".
    re: rx(`\\b(?:${DOW_RE}\\s*,?\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?!\\d)${ORD}(?:\\s*,?\\s+(\\d{4}|\\d{2})(?![\\d:]))?`),
    build: (m) => {
      const mo = MONTHS[m[1].toLowerCase().replace(/\./g, '')];
      const d = +m[2];
      const hasYear = !!m[3];
      const y = hasYear ? expandYear(m[3]) : null;
      return { y, mo, d, hasYear, specificity: 0.95 };
    },
  },
  {
    // UK convention: day first. 03/04/26 is 3 April.
    name: 'numeric',
    re: rx(`\\b(\\d{1,2})[\\/.](\\d{1,2})[\\/.](\\d{2,4})\\b`),
    build: (m) => {
      let d = +m[1], mo = +m[2];
      // If the first number cannot be a day-of-month, it must be US ordering.
      if (d > 12 && mo <= 12) { /* day-first confirmed */ }
      else if (mo > 12 && d <= 12) { [d, mo] = [mo, d]; }
      return { y: expandYear(m[3]), mo, d, hasYear: true, specificity: 0.65, ambiguousOrder: d <= 12 && mo <= 12 };
    },
  },
];

const WC_RE = rx(`\\b(?:w\\/c|w\\.c\\.|week\\s+(?:commencing|beginning|of)|wb)\\s+`, 'gi');
const WEEKN_RE = rx(`\\b(?:wk|week)\\s*\\.?\\s*(\\d{1,2})\\b\\s*(?:\\(\\s*(${DOW_RE})\\s*\\)|\\s(${DOW_RE}))?`, 'gi');

/**
 * Find every date mention in a string, with character offsets so the raw span
 * can be stored and the title can be cleaned.
 */
export function findDates(text, { reference = today() } = {}) {
  const found = [];
  for (const pat of DATE_PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(text)) !== null) {
      if (m[0].trim() === '') { pat.re.lastIndex++; continue; }
      const parsed = pat.build(m);
      if (!parsed || !parsed.mo) continue;
      const y = parsed.y ?? inferYear(parsed.mo, parsed.d, reference);
      if (!isValidYMD(y, parsed.mo, parsed.d)) continue;
      found.push({
        type: 'absolute',
        date: iso(y, parsed.mo, parsed.d),
        index: m.index,
        length: m[0].length,
        raw: m[0].trim(),
        hasYear: parsed.hasYear,
        ambiguousOrder: !!parsed.ambiguousOrder,
        specificity: parsed.specificity,
        pattern: pat.name,
      });
    }
  }

  // "w/c 18 November" — the date that follows is a week-commencing marker.
  WC_RE.lastIndex = 0;
  let wm;
  while ((wm = WC_RE.exec(text)) !== null) {
    const after = wm.index + wm[0].length;
    const target = found.find((f) => f.index >= after && f.index <= after + 2);
    if (target) {
      target.type = 'week-commencing';
      target.index = wm.index;
      target.length = (after - wm.index) + target.length;
      target.raw = text.slice(wm.index, wm.index + target.length).trim();
      target.date = mondayOf(target.date);
      target.specificity = Math.min(target.specificity, 0.7);
    }
  }

  // Longest-wins de-overlap.
  found.sort((a, b) => (b.length - a.length) || (a.index - b.index));
  const kept = [];
  for (const f of found) {
    if (!kept.some((k) => f.index < k.index + k.length && k.index < f.index + f.length)) kept.push(f);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/** "Wk 7 (Fri)" style references, which need an anchor calendar to resolve. */
export function findWeekRefs(text) {
  WEEKN_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = WEEKN_RE.exec(text)) !== null) {
    const dowRaw = (m[2] || m[3] || '').toLowerCase();
    out.push({
      type: 'week-number',
      week: +m[1],
      dow: dowRaw ? DOW[dowRaw.replace(/day$/, '')] ?? DOW[dowRaw] ?? null : null,
      dowRaw,
      index: m.index,
      length: m[0].length,
      raw: m[0].trim(),
    });
  }
  return out;
}

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b|\b(\d{1,2}):(\d{2})\b/gi;

/** Times, and time ranges when two are joined by to/until/-. */
export function findTimes(text) {
  TIME_RE.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = TIME_RE.exec(text)) !== null) {
    let t;
    if (m[4] !== undefined) t = normaliseTime(m[4], m[5], null);
    else t = normaliseTime(m[1], m[2], m[3]);
    if (!t) continue;
    hits.push({ time: t, index: m.index, length: m[0].length, raw: m[0].trim(), hadMeridiem: !!m[3] });
  }

  const ranges = [];
  const used = new Set();
  for (let i = 0; i < hits.length - 1; i++) {
    const a = hits[i], b = hits[i + 1];
    const between = text.slice(a.index + a.length, b.index);
    if (RANGE_JOINER.test(between)) {
      // "4:30pm to 7:30pm" — a bare first time inherits the second's meridiem.
      let start = a.time;
      if (!a.hadMeridiem && b.hadMeridiem) {
        const bh = +b.time.slice(0, 2), ah = +a.time.slice(0, 2);
        if (bh >= 12 && ah < 12 && ah !== 12) start = normaliseTime(String(ah), a.time.slice(3), 'pm');
      }
      ranges.push({
        start, end: b.time, index: a.index,
        length: (b.index + b.length) - a.index,
        raw: text.slice(a.index, b.index + b.length).trim(),
      });
      used.add(i); used.add(i + 1);
    }
  }
  const singles = hits.filter((_, i) => !used.has(i))
    .map((h) => ({ start: h.time, end: null, index: h.index, length: h.length, raw: h.raw }));
  return [...ranges, ...singles].sort((a, b) => a.index - b.index);
}

export function detectDeadline(text, heading = '') {
  const m = text.match(DEADLINE_MARKERS) || heading.match(DEADLINE_MARKERS);
  return m ? { isDeadline: true, marker: m[0] } : { isDeadline: false, marker: null };
}

/**
 * Recurrence is only ever a SUGGESTION (R1). We report what the wording implies
 * and let the review step decide; nothing here creates a rule.
 * Also returns index/length so the phrase can be stripped from the title.
 */
const RECURRENCE_PHRASE_RE = new RegExp(
  `\\b(?:(every\\s+other|every|each)\\s+(${DOW_RE})s?|(weekly|fortnightly|bi[\\s-]?weekly|monthly|daily|termly|annually|yearly))\\b`,
  'i',
);

export function detectRecurrence(text) {
  const m = text.match(RECURRENCE_PHRASE_RE);
  if (!m) return null;
  const phrase = m[0];
  const word = (m[1] || m[3] || '').toLowerCase();
  const dowRaw = (m[2] || '').toLowerCase();
  const dow = dowRaw ? (DOW[dowRaw.replace(/day$/, '')] ?? DOW[dowRaw] ?? null) : null;

  let freq = 'WEEKLY', interval = 1;
  if (/every\s+other|fortnightly|bi[\s-]?weekly/.test(word)) interval = 2;
  else if (/monthly|termly/.test(word)) freq = 'MONTHLY';
  else if (/daily/.test(word)) freq = 'DAILY';
  else if (/annually|yearly/.test(word)) freq = 'YEARLY';

  return {
    freq, interval,
    byday: dow != null ? ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][dow] : null,
    phrase,
    index: m.index,
    length: phrase.length,
    // Deliberately no UNTIL/COUNT: we never extrapolate past the evidence.
    accepted: false,
  };
}

export function extractContext(text) {
  const loc = text.match(LOCATION_RE);
  const money = text.match(MONEY_RE);
  return {
    location: loc ? loc[1].replace(/\s+/g, ' ').trim() : null,
    cost: money ? money[0].replace(/\s/g, '') : null,
  };
}

const FILLER_LEAD = /^(?:on|at|by|from|the|a|an|is|are|will\s+be|begins?|starts?|commences?|due|deadline|dates?|and|to|for|of|in)\b[\s:,-]*/i;
const FILLER_TRAIL = /[\s:,.;–—-]+$/;

const SENTINEL = '\uE000';

// Words that existed only to govern a span we removed ("from <time>", "on <date>").
const GOVERNING = new RegExp(
  String.raw`\b(?:from|between|starting|starts?|on|at|by|until|till|to|and|or|due|deadline|begins?|commences?|runs?|is|are|of|during|beginning)\s*[:,;-]?\s*` + SENTINEL,
  'gi',
);
const JOINED = new RegExp(
  SENTINEL + String.raw`\s*(?:to|until|till|and|through|-|–|—)\s*` + SENTINEL,
  'gi',
);
const DOUBLE = new RegExp(SENTINEL + String.raw`\s*` + SENTINEL, 'g');
const ALL_SENTINELS = new RegExp(SENTINEL, 'g');

/** Turn a source line into a usable title by removing the spans we consumed. */
export function deriveTitle(text, spans) {
  const ordered = [...spans].filter(Boolean).sort((a, b) => a.index - b.index);
  let out = '';
  let cursor = 0;
  for (const sp of ordered) {
    if (sp.index < cursor) continue;
    out += text.slice(cursor, sp.index) + SENTINEL;
    cursor = sp.index + sp.length;
  }
  out += text.slice(cursor);

  // Collapse the debris around removed spans until stable.
  let prev;
  do {
    prev = out;
    out = out.replace(JOINED, SENTINEL);
    out = out.replace(GOVERNING, SENTINEL);
    out = out.replace(DOUBLE, SENTINEL);
  } while (out !== prev);

  out = out.replace(ALL_SENTINELS, ' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
  out = out.replace(/^[\s:,;–—-]+/, '').replace(FILLER_TRAIL, '');
  do {
    prev = out;
    out = out.replace(FILLER_LEAD, '');
    out = out.replace(/\b(?:on|at|from|by|until|till|to|due|deadline|begins?|commences?|starts?|in|the|via|of|runs?)\s*$/i, '');
    out = out.replace(FILLER_TRAIL, '');
  } while (out !== prev && out.length);

  out = out.replace(/\s+\d{1,3}\s?%$/, '').trim();
  return out.replace(/\s{2,}/g, ' ').trim();
}

const SENTENCE_END = /[.!?]$/;

/** A short, undated, non-sentence line acts as a section heading for what follows. */
export function looksLikeHeading(line) {
  const t = line.text.trim();
  if (t.length === 0 || t.length > 44) return false;
  if (SENTENCE_END.test(t)) return false;
  if (findDates(t).length || findTimes(t).length) return false;
  const words = t.split(/\s+/).length;
  return words <= 6;
}
