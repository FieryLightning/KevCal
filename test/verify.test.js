// Unit tests for the checker.
//
// This is the file that matters most. Every rule in verify.js exists because a
// wrong date is worse than a missing one, and each test below is a specific way
// KevCal is allowed to be uncertain but not allowed to be confidently wrong.

import { verifyItems, yearFromSpan, boxToBBox } from '../server/extract/verify.js';

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name} ${detail}`); }
}

function group(name) { console.log(`\n${name}`); }

const clock = (date, time) => ({ date, time, hour: Number(time.slice(0, 2)) });
const AFTERNOON = clock('2026-09-10', '14:30');
const SMALL_HOURS = clock('2026-09-10', '00:20');

function read(overrides = {}) {
  return {
    title: 'Thing', kind: 'event', start_date: null,
    has_explicit_year: true, am_pm_stated: true, confidence: 0.9,
    source_quote: 'Thing', ...overrides,
  };
}
const run = (item, ctx = {}) => verifyItems([item], { now: AFTERNOON, ...ctx })[0];
const codes = (it) => (it.flags || []).map((f) => f.code);
const flagOf = (it, code) => (it.flags || []).find((f) => f.code === code);

// ─────────────────────────────────────────────── relative dates

group('relative dates are resolved here, never by the reader');

{
  const it = run(read({ relative_phrase: 'tomorrow', relative_kind: 'tomorrow', source_quote: 'the trip leaves tomorrow' }));
  check('"tomorrow" resolves to the next day', it.start_date === '2026-09-11', it.start_date);
  check('and says so in words', /tomorrow/.test(it.src_interpretation || ''), it.src_interpretation);
  check('and is flagged because nothing dated the document', codes(it).includes('relative_no_document_date'));
}

{
  // The reader disobeying its instructions must not be able to smuggle a date past us.
  const it = run(read({ relative_phrase: 'tomorrow', relative_kind: 'tomorrow', start_date: '2027-01-01' }));
  check('a date the reader invented for relative wording is discarded', it.start_date === '2026-09-11', it.start_date);
}

{
  const it = run(read({ relative_phrase: 'tomorrow', relative_kind: 'tomorrow' }),
                 { documentDate: '2026-09-01' });
  check('a letter that dates itself anchors to its own date', it.start_date === '2026-09-02', it.start_date);
  check('and is not flagged for the anchor', !codes(it).includes('relative_no_document_date'));
}

group('the after-midnight trap');

{
  const it = run(read({ relative_phrase: 'tomorrow', relative_kind: 'tomorrow' }), { now: SMALL_HOURS });
  const f = flagOf(it, 'midnight_ambiguity');
  check('at 00:20 "tomorrow" is a blocker, not a guess', f?.level === 'blocker', JSON.stringify(codes(it)));
  check('both readings are offered', f?.options?.length === 2);
  check('one option is the literal day', f?.options?.some((o) => o.patch.start_date === '2026-09-11'));
  check('the other is the day it means if written last night', f?.options?.some((o) => o.patch.start_date === '2026-09-10'));
  check('the item is blocked from the calendar', it.blocked === 1);
}

{
  const it = run(read({ relative_phrase: 'tomorrow', relative_kind: 'tomorrow' }),
                 { now: SMALL_HOURS, documentDate: '2026-09-09' });
  check('a printed document date beats the clock even at 00:20', it.start_date === '2026-09-10', it.start_date);
  check('and the midnight question does not arise', !codes(it).includes('midnight_ambiguity'));
}

{
  const it = run(read({ relative_phrase: 'tomorrow', relative_kind: 'tomorrow' }),
                 { photoDate: '2026-09-08' });
  check('a photo taken on another day anchors to that day', it.start_date === '2026-09-09', it.start_date);
  check('and offers today as the alternative', flagOf(it, 'relative_photo_anchor')?.options?.length === 2);
}

{
  const it = run(read({ relative_phrase: 'next Friday', relative_kind: 'next_weekday', relative_weekday: 'friday' }));
  const f = flagOf(it, 'relative_ambiguous_phrase');
  check('"next Friday" is treated as genuinely ambiguous English', f?.level === 'blocker');
  check('and offers both Fridays a week apart',
    f?.options?.[0]?.patch.start_date === '2026-09-11' && f?.options?.[1]?.patch.start_date === '2026-09-18',
    JSON.stringify(f?.options?.map((o) => o.patch.start_date)));
}

{
  const it = run(read({ relative_phrase: 'in 3 weeks', relative_kind: 'in_n_weeks', relative_n: 3 }));
  check('"in 3 weeks" counts forward correctly', it.start_date === '2026-10-01', it.start_date);
}

{
  const it = run(read({ relative_phrase: 'soon', relative_kind: 'other' }));
  check('unresolvable relative wording gets no date at all', it.start_date === null);
  check('and blocks', it.blocked === 1);
}

// ─────────────────────────────────────────────── disagreement

group('two sources that disagree are never silently reconciled');

{
  const it = run(read({ start_date: '2026-03-12', weekday_stated: 'Wednesday', source_quote: 'Wednesday 12 March 2026' }));
  const f = flagOf(it, 'weekday_mismatch');
  check('a printed weekday that does not match the date is a blocker', f?.level === 'blocker', JSON.stringify(codes(it)));
  check('and the nearest matching weekday is offered', f?.options?.[0]?.patch.start_date === '2026-03-11',
    JSON.stringify(f?.options?.map((o) => o.patch.start_date)));
}

{
  const it = run(read({ start_date: '2026-03-12', weekday_stated: 'Thursday', source_quote: 'Thursday 12 March 2026' }));
  check('a weekday that does match raises nothing', !codes(it).includes('weekday_mismatch'), JSON.stringify(codes(it)));
}

{
  // The v1 disaster: the day pattern ate the first two digits of the year.
  const it = run(read({ start_date: '2025-12-20', has_explicit_year: true, source_quote: 'Contract ends December 2031' }));
  check('re-reading the quote catches a fabricated day', codes(it).includes('quote_mismatch') || codes(it).includes('year_mismatch'),
    JSON.stringify(codes(it)));
  check('and it blocks rather than being filed at 94% confidence', it.blocked === 1);
}

{
  const it = run(read({ start_date: '2026-03-19', source_quote: 'Parents evening 12 March 2026' }));
  const f = flagOf(it, 'quote_mismatch');
  check('a date that is not in its own quote is a blocker', f?.level === 'blocker', JSON.stringify(codes(it)));
  check('and the text\'s own reading is offered first', f?.options?.[0]?.patch.start_date === '2026-03-12');
}

// ─────────────────────────────────────────────── impossible and implausible

group('impossible dates are reported, never rounded');

{
  const it = run(read({ start_date: '2027-02-29', source_quote: '29 February 2027' }));
  check('29 February in a non-leap year yields no date', it.start_date === null, String(it.start_date));
  check('it is a blocker', flagOf(it, 'impossible_date')?.level === 'blocker');
  check('and it is NOT quietly moved to a nearby real date', it.start_date !== '2027-02-20' && it.start_date !== '2027-02-28');
}

{
  const it = run(read({ start_date: 'next tuesday' }));
  check('junk in the date field is refused', it.start_date === null && it.blocked === 1);
}

group('dates are rarely in the past or far ahead');

{
  const it = run(read({ start_date: '2026-06-01', source_quote: 'Sports day 1 June 2026' }));
  const f = flagOf(it, 'in_the_past');
  check('a date already gone is flagged', f?.level === 'check', JSON.stringify(codes(it)));
  check('with the next year offered as the likely fix', f?.options?.[0]?.patch.start_date === '2027-06-01');
  check('but it does not block — old term dates are legitimate', it.blocked === 0);
}

{
  const it = run(read({ start_date: '2026-09-10' }));
  check('today itself is not "in the past"', !codes(it).includes('in_the_past'));
}

{
  const it = run(read({ start_date: '2031-12-01', source_quote: 'Contract ends December 2031' }));
  check('years out is flagged as worth checking', codes(it).includes('far_future'), JSON.stringify(codes(it)));
}

// ─────────────────────────────────────────────── assumptions stated out loud

group('every assumption is said out loud');

{
  const it = run(read({ start_date: '2026-11-05', has_explicit_year: false, source_quote: 'Bonfire night, 5 November' }));
  const f = flagOf(it, 'year_assumed');
  check('a year nobody printed is flagged', f?.level === 'check');
  check('with both plausible years offered', f?.options?.length === 2);
  check('and the date still resolves', it.start_date === '2026-11-05', it.start_date);
}

{
  const it = run(read({ start_date: '2027-01-14', has_explicit_year: false, source_quote: '14 January' }),
                 { documentSpan: '2026-2027' });
  check('a document that names its own span resolves the year without asking',
    it.start_date === '2027-01-14' && !codes(it).includes('year_assumed'),
    `${it.start_date} ${JSON.stringify(codes(it))}`);
}

{
  const it = run(read({ start_date: '2026-10-01', start_time: '03:30', am_pm_stated: false, source_quote: 'Meet at 3.30' }));
  const f = flagOf(it, 'am_pm_assumed');
  check('a time with no am/pm is flagged', f?.level === 'check', JSON.stringify(codes(it)));
  check('3.30 on a document is read as the afternoon', it.start_time === '15:30', it.start_time);
  check('and the morning reading is one tap away',
    f?.options?.map((o) => o.patch.start_time).join(',') === '15:30,03:30',
    JSON.stringify(f?.options?.map((o) => o.patch.start_time)));
}

{
  const it = run(read({ start_date: '2026-10-01', start_time: '09:00', am_pm_stated: false, source_quote: 'Assembly at 9' }));
  check('9 is left in the morning where it belongs', it.start_time === '09:00', it.start_time);
  check('but still says it assumed', codes(it).includes('am_pm_assumed'));
}

{
  const it = run(read({ start_date: '2026-10-01', start_time: '03:30', end_time: '05:00',
                        am_pm_stated: false, source_quote: '3.30 to 5' }));
  check('an end time moves with the start', it.end_time === '17:00', it.end_time);
}

{
  const it = run(read({ start_date: '2026-11-09', end_date: '2026-11-13', has_explicit_year: false,
                        source_quote: 'Book fair, 9-13 November' }),
                 { documentDate: '2026-09-07' });
  check('a range whose quote only parses its end is not a contradiction',
    !codes(it).includes('quote_mismatch'), JSON.stringify(codes(it)));
  check('and a letter that dates itself supplies the year without asking',
    it.start_date === '2026-11-09' && !codes(it).includes('year_assumed'),
    `${it.start_date} ${JSON.stringify(codes(it))}`);
}

{
  const it = run(read({ start_date: '2026-10-01', start_time: '16:30', am_pm_stated: true, source_quote: '4:30pm' }));
  check('a stated am/pm raises nothing', !codes(it).includes('am_pm_assumed'));
  check('and the item is all-day = false', it.all_day === 0);
}

{
  const it = run(read({ start_date: '2026-10-05', end_date: '2026-10-01', source_quote: '1-5 October 2026' }));
  check('an end before its start is refused', it.end_date === null && codes(it).includes('end_date_before_start'));
}

// ─────────────────────────────────────────────── the quiet case

group('a clean date stays quiet');

{
  const it = run(read({
    title: 'Parents evening', start_date: '2027-03-11', start_time: '16:30', end_time: '19:30',
    weekday_stated: 'Thursday', am_pm_stated: true, has_explicit_year: true, confidence: 0.95,
    source_quote: 'Parents evening — Thursday 11 March 2027, 4.30pm to 7.30pm',
  }));
  check('no flags at all', codes(it).length === 0, JSON.stringify(codes(it)));
  check('not blocked', it.blocked === 0);
  check('not sent to review', it.needs_review === 0);
  check('times survive', it.start_time === '16:30' && it.end_time === '19:30');
}

{
  const it = run(read({ start_date: '2026-10-01', confidence: 0.4, source_quote: 'smudged' }));
  check('low reader confidence alone still raises a check', codes(it).includes('low_confidence'));
}

{
  const it = run(read({ start_date: '2026-10-01', repeats_hint: 'every other Tuesday', source_quote: 'every other Tuesday' }));
  check('a repeat is only ever a suggestion', it.rrule === null && it.recurrence_accepted === 0);
  check('and the wording is kept verbatim', JSON.parse(it.recurrence_suggestion).phrase === 'every other Tuesday');
}

group('a document that names its own year span is the authority');
{
  // The exact failure from a real 2026-27 academic calendar: spring dates filed
  // a year early, so every one of them read as "already gone".
  const it = run(read({
    title: 'First due date for final examinations', start_date: '2026-03-15',
    has_explicit_year: true, source_quote: 'March 15',
  }), { documentSpan: '2026-27' });
  check('a spring date in a 2026-27 calendar is moved to 2027', it.start_date === '2027-03-15', it.start_date);
  check('and it is no longer in the past', !codes(it).includes('in_the_past'), JSON.stringify(codes(it)));
  check('the correction is stated, not silent', codes(it).includes('span_year'));
  check('with the reader\'s original one tap away',
    flagOf(it, 'span_year').options.length === 2);

  const autumn = run(read({ title: 'Term begins', start_date: '2026-09-28', has_explicit_year: true, source_quote: 'September 28' }),
    { documentSpan: '2026-27' });
  check('an autumn date in the same calendar is left alone',
    autumn.start_date === '2026-09-28' && !codes(autumn).includes('span_year'), autumn.start_date);

  const range = run(read({
    title: 'Spring break', start_date: '2026-03-15', end_date: '2026-03-19',
    has_explicit_year: true, source_quote: '15-19 March',
  }), { documentSpan: '2026-27' });
  check('a range travels with its start', range.start_date === '2027-03-15' && range.end_date === '2027-03-19',
    `${range.start_date} → ${range.end_date}`);

  const noSpan = run(read({ title: 'Something', start_date: '2026-03-15', has_explicit_year: true, source_quote: 'March 15' }));
  check('without a span nothing is moved', noSpan.start_date === '2026-03-15');
}

group('footnote marks are not titles');
{
  check('a leading asterisk is stripped',
    run(read({ title: '*First due date for final examinations', start_date: '2027-03-10', source_quote: 'x' })).title
      === 'First due date for final examinations');
  check('a title that is only a mark is not a title',
    run(read({ title: '*', start_date: '2027-03-15', source_quote: 'x' })).title === '(untitled)');
  check('a dagger goes too',
    run(read({ title: '† Reading day', start_date: '2027-04-30', source_quote: 'x' })).title === 'Reading day');
  check('an asterisk inside a title is left alone',
    run(read({ title: 'Grade 5*A results', start_date: '2027-04-30', source_quote: 'x' })).title === 'Grade 5*A results');
}

// ─────────────────────────────────────────────── plumbing

group('geometry and spans');

check('a Gemini box becomes a top-left fractional box',
  boxToBBox([100, 200, 300, 600]) === JSON.stringify([0.2, 0.1, 0.4, 0.2]), boxToBBox([100, 200, 300, 600]));
check('a malformed box is dropped rather than guessed', boxToBBox([1, 2]) === null && boxToBBox(null) === null);
check('an academic span puts autumn in the first year', yearFromSpan('2026-2027', 9) === 2026);
check('and spring in the second', yearFromSpan('2026-2027', 1) === 2027);
check('a two-digit second half expands', yearFromSpan('2026-27', 1) === 2027);
check('a single year is taken as-is', yearFromSpan('Calendar 2026', 3) === 2026);

// ─────────────────────────────────────────────── result

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
