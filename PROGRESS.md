# Where this got to

Written so an interrupted session — or you tomorrow — can pick it up cold.

## Status: v2 rebuilt and working end to end

`npm test` → **213 passing** (64 checker + 36 reader + 113 end-to-end). `npm start`, then capture.

## What v2 changed, and why

v1's weakness was never the plumbing — it was that a hand-rolled regex grammar
was the *primary* reader, and it failed **confidently**. v2 keeps everything that
worked and replaces the engine.

| | v1 | v2 |
|---|---|---|
| Reader | Apple Vision + regex grammar | Gemini **or** OpenAI, one structured call, same contract |
| Grammar | the extractor | demoted to **cross-checker** and offline fallback |
| Relative dates | not handled | resolved in one place, against the phone's clock, always explained |
| Uncertainty | a confidence number | named flags with one-tap alternatives |
| Bad dates | silently "rescued" | reported, never rounded |
| Times | floating, no zone | converted to a real instant in a named zone |
| Reach | LAN only, Mac awake, same wifi | tunnel-ready with a token, plus an iOS share-sheet entry point |
| Front end | desktop-shaped | phone-first, rebuilt |

## Done

- [x] `extract/contract.js` — one provider-neutral reading contract: the system
      prompt and the schema both readers are held to. Reports what is *printed*:
      the words, the weekday as written, whether a year appeared, whether am/pm
      was stated. Explicitly forbidden from doing date arithmetic.
- [x] `extract/gemini.js` and `extract/openai.js` — transport only, picked by
      `extract/reader.js` from whichever key is set (`KEVCAL_READER` to force).
      Gemini leads when both are present, because it returns bounding boxes.
      36 tests stub `fetch` and check the exact bytes each would send.
- [x] `extract/verify.js` — the checker. Every calculation and every flag.
- [x] Never guesses: impossible dates refused, missing years stated, relative
      wording anchored to the document's own date where there is one
- [x] The after-midnight rule: at 00:20 "tomorrow" is a blocking question with
      both days offered
- [x] Plausibility window: past and far-future dates flagged, never auto-shifted
- [x] Cross-examination: weekday-vs-date, quote re-parse, printed-year check —
      any disagreement blocks instead of being resolved
- [x] Two flag levels: **blocker** (cannot reach a calendar) vs **check** (goes
      through, but says so)
- [x] Editing an item retires exactly the flags that edit answers
- [x] `.ics` with real timezone conversion (the old floating-time bug is gone)
- [x] Phone-first front end rebuilt: tab bar + capture FAB, scanner animation
      with boxes landing on your photo, review with inline one-tap fixes,
      bottom-sheet editor with the source crop, dark mode, home-screen icons
- [x] `POST /api/quick` + Shortcuts recipe for share-sheet capture
- [x] `KEVCAL_TOKEN` lock so it can sit behind a tunnel
- [x] `KEVCAL_FAKE_READER` fixture harness — the whole pipeline is testable with
      no API key and no network
- [x] Repeated-title check: when a table's columns fail to line up, every row
      ends up labelled with the page header. No per-item rule can see that, so it
      is caught across the batch.

## Kept from v1, unchanged

Batch = undo + diff + bulk edit + share. Provenance on every item. Review
scaling with risk. Never inventing a recurrence. Re-import diffing with
hand-edits protected. Deadline ladders and the *sorted* state. Sharing in four
envelopes with revocation. The security hardening (cross-site checks, iCalendar
injection refusal, path traversal, bounded shifts).

## Bugs found and fixed while building this

- The item editor opened **behind** the review overlay (z-index 60 vs 70), so
  tapping any card during a review showed nothing at all.
- `mergeRangePairs` had been deleted by an interrupted edit in v1's working tree,
  leaving `build.js` throwing on every capture.
- `'\;'` in `ics.js` is just `';'` in JavaScript — the semicolon escape had been
  reintroduced during the rewrite. Fixed and covered.
- A quoted date range ("9–13 November") was flagged as a contradiction because
  the grammar only parses its second date. It now agrees with either end.
- Yearless dates flagged even when the letter dated itself; the document's own
  date now supplies the year silently.
- "3.30" was read as 03:30. Now read as the afternoon, said out loud, one tap to
  flip.

## What the real Caltech PDF says about the fallback

`samples/AcademicCalendar2026-27.pdf` is a genuine two-column academic calendar.
Through the **on-device fallback** it produces 73 items and gives 27 of them the
page header as their title, because the PDF's text layer puts the date column and
the description column in separate blocks and row-grouping cannot recover the
pairing. That is exactly the failure Gemini is there to fix — it sees the layout
rather than the text stream — and it is why the header now names the engine that
actually read each import. The repeated-title check means those 27 arrive flagged
rather than silently.

## Choosing between the two readers

`npm run ab -- <file>` runs one document through both and diffs the checked
results side by side, with each reader's verbatim quote shown wherever they
disagree. Written because the published benchmarks answer a different question
(object detection) than the one that decides this (reading a crumpled letter),
and that question can only be settled on real documents.

## Known rough edges

- The Gemini path has never been run against the live API — there is no key on
  this machine. Every rule is covered by fixtures, but the first real call may
  need the model name in `.env` adjusting; the code falls back down a chain.
- Screen-reader support is better than v1 but still thin.
- Rota grids remain out of scope.
- `?tab=` and `?b=` deep links exist; there is no full router.

## To pick this up again

```bash
cd ~/KevCal
cp .env.example .env     # paste a Gemini key in
npm run build:tools      # only if bin/ is missing
npm test
npm start
```

Read in this order: `README.md` (what and how), `BRIEF.md` (why),
`research/SYNTHESIS.md` (the rules), `DECISIONS.md`, then
`server/extract/verify.js` — which is where the whole design actually lives.
