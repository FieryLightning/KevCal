# Where this got to

Written so an interrupted session — or you tomorrow — can pick it up cold.

## Status: working end to end

`npm start`, then capture a document. 66/66 end-to-end tests pass (`npm test`).

## Done

- [x] Four persona interviews + synthesis into 12 design rules (`research/`)
- [x] On-device OCR with bounding boxes via Apple Vision (`tools/ocr.swift`)
- [x] Deterministic date/time/deadline/recurrence grammar
- [x] Table-row grouping (so a date keeps the title in the next column)
- [x] Relative dates: `w/c 18 Nov`, `Wk 7 (Fri)` resolved against a term anchor,
      including skipping non-teaching weeks; asked for when unresolvable
- [x] Confidence scoring, risk assessment, review gating
- [x] SQLite store with full provenance per item
- [x] Batch = undo + diff + bulk edit + share, all one concept
- [x] Re-import diffing, with hand-edited items protected from reversion
- [x] Deadlines: escalating ladders, runway bar, satisfied state
- [x] `.ics` export (RFC 5545 folding, alarms, exclusive all-day DTEND)
- [x] Share: text, image card, `.ics`, subscribable feed with revocation
- [x] Optional AI tier (off by default, no key needed)
- [x] Front end: capture / dates / imports / settings, light + dark
- [x] End-to-end test suite (82 tests)

## Not done (deliberate — see README "Not in this version")

- [ ] Rota-grid row anchoring + shift-code dictionary
- [ ] Deadline chains (`derived_from` column exists as the seam)
- [ ] Live Google/Outlook OAuth sync
- [ ] Service worker / offline queueing of photos taken away from the Mac
- [ ] Screen-reader labelling is thin

## Reviewed and hardened

Two agents attacked the build: an adversarial QA pass and a UX review against the
personas. Everything they found that mattered is fixed and covered by tests.

Worst bug found: **"Contract ends December 2031" invented 20 December 2025** at 94%
confidence — the day pattern was eating the first two digits of the year. It also
silently "rescued" impossible dates (29 February 2027 became 20 February 2026).
That is precisely the confident-error failure the whole design exists to prevent.

Also fixed: a huge date shift could write NaN dates that then broke every calendar
export; `apply-diff` accepted unreviewed items and could overwrite an unrelated
batch; deleting a re-imported batch destroyed its image then failed on a foreign
key; arbitrary iCalendar properties could be injected through a repeat rule; redo
resurrected items the user had deliberately rejected; `;` was never escaped in
.ics output (`'\\;'` is just `';'` in JavaScript); a share with no scope published
the entire calendar; and any web page could POST to the server and switch on AI
uploading. Contrast failures in dark mode (the primary button measured 2.38:1)
and the missing fast path are fixed too.

## Known rough edges

- Titles occasionally keep a stray word from a merged table row.
- Screen-reader support is improved but still thin: the review list rebuilds on
  every selection, which moves focus.
- Timed events are exported as floating time with no TZID, so a shared .ics
  shifts for a recipient in another timezone.
- Real-world school PDFs will be messier than the synthetic fixtures.

## To pick this up again

```bash
cd ~/KevCal
npm run build:tools   # only if bin/ is missing
npm test              # confirms nothing regressed
npm start
```

Read in this order: `BRIEF.md` (why), `research/SYNTHESIS.md` (the rules),
`DECISIONS.md` (what was chosen for you), then the code.
