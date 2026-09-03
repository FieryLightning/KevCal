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
- [x] End-to-end test suite

## Not done (deliberate — see README "Not in this version")

- [ ] Rota-grid row anchoring + shift-code dictionary
- [ ] Deadline chains (`derived_from` column exists as the seam)
- [ ] Live Google/Outlook OAuth sync
- [ ] Service worker / offline queueing of photos taken away from the Mac
- [ ] Screen-reader labelling is thin

## Known rough edges

- Titles occasionally keep a stray word from a merged table row.
- The confirm-card fast path still shows the source image above it; for a
  one-date poster that is arguably one scroll too many.
- The subscribable share feed is created by the API but is not surfaced as a
  button in the share dialog yet.
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
