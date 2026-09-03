# KevCal

**Turns a photo, screenshot or PDF of anything with dates on it into calendar
entries — showing you where each one came from, and undoing the whole import
with one button.**

School letters, class timetables, posters, service reminders, emails. Point at
it, check what it found, add it.

---

## Run it

```bash
cd ~/KevCal
npm run build:tools     # once — compiles the on-device reader (needs Xcode CLT)
npm start
```

Then open **http://localhost:4321**, or the `http://192.168.x.x:4321` address it
prints, on your phone on the same wifi. Add it to your home screen and it behaves
like an app.

There is **no `npm install`** — KevCal has zero dependencies. Node 22.5+ (for
`node:sqlite`), macOS for the on-device reader.

```bash
npm test        # 66 end-to-end tests
npm run samples # regenerate the example documents in samples/
```

---

## Where your stuff goes

Everything lives in `./data` on your own machine: a SQLite file and the original
images. There is no account, no sign-in, and no server anywhere else.

**Nothing leaves your Mac.** Images are read on-device by macOS's Vision
framework. The app prints its outbound story on startup, and the header shows
`on-device` whenever that is true.

The one exception is opt-in and off by default: if you set `ANTHROPIC_API_KEY`
*and* switch on AI reading in Settings, the image you are importing is sent to
`api.anthropic.com` to be read. The header changes to `AI reading on` so you can
never be in that state without seeing it. Everything works without it.

Deleting an import deletes its original image too.

---

## How it reads a document

Three tiers, tried in order. You can stop at any of them.

| Tier | What it does | Needs |
|---|---|---|
| **Vision** | Apple's on-device OCR: text plus a bounding box for every line | macOS |
| **Grammar** | Deterministic date/time parsing — `Thursday 12 March`, `4:30pm to 7:30pm`, `w/c 18 Nov`, `Wk 7 (Fri)`, ranges, deadline wording | nothing |
| **AI** *(optional, off)* | Claude reads messy layouts, dense grids, bad handwriting | an API key |

It also groups table rows, so `Critical appraisal │ Wk 7 (Fri) │ 25%` stays one
thing instead of three.

---

## The rules it follows

These came out of four user interviews (`research/`), and they are the reason it
behaves the way it does.

**It will not invent a repeat.** All four people interviewed said, without being
asked, that a wrong recurring event is worse than none at all — because it is
silent, and it makes you distrust the entries that *are* right. So KevCal creates
only the dates the document actually shows, then offers *"these look like every
other Tuesday — collapse them?"* as something you tap. A repeat always needs an
end date; it will not extrapolate past the evidence.

**It shows you where every date came from.** Every entry keeps its source image,
the exact text it was read from, and how it was interpreted (`w/c 18 Nov → week
beginning Mon 17 Nov`). Tap a row and its box lights up on the original. If you
have to reopen the document to trust the output, the tool has saved you nothing.

**It asks instead of guessing.** "Homework club every Tuesday" with no start date
in the document becomes a question, not a guess. "Wk 7 (Fri)" resolves properly
if the document says when week 1 begins — or if you set a term in Settings —
and otherwise it asks.

**It only makes you review what it is unsure about.** A poster with one clear
date goes straight to a confirm card. Anything uncertain, or longer than a few
items, gets the review table with the doubtful rows first and the confident ones
folded away. Low-confidence entries cannot be added until you have touched them.

**Undo is one button, forever.** Every import is a batch. That single idea is
also how you bulk-edit, how you share, and how a re-issued document is
reconciled. *Imports → Undo* removes the whole thing, and *Restore* puts it back.

**A deadline is not an event.** It is a wall with a runway in front of it, so it
gets escalating reminders (30/14/7/2/0 days by default, editable) and a *Mark
sorted* state that silences it without deleting it. Those reminders are written
into the calendar entry itself, so they fire whether or not KevCal is running.

**Re-importing diffs; it does not duplicate.** Import the amended letter against
the original and you get *"1 changed, 1 added"* — not two parents' evenings.
Anything you edited by hand is protected and never silently reverted.

---

## Sharing

The person you send it to installs nothing and signs up for nothing. From any
import, *Share* gives you:

- **Plain text** — pasteable into WhatsApp, email or Slack. Often the only
  channel that is actually allowed.
- **An image card** — what people really forward in a group chat.
- **A `.ics` file** — lands in Apple Calendar, Outlook or Google.
- **A subscribable feed** — `/s/<token>.ics`, added once and updating in place.

---

## Layout

```
server/
  index.js          HTTP server and routes
  api.js            handlers — batches, items, sharing, settings
  db.js             SQLite schema (node:sqlite, no native build)
  extract/
    index.js        orchestrator + risk scoring
    grammar.js      the date/time/deadline/recurrence grammar
    build.js        raw hits -> reviewable items, confidence, provenance
    rows.js         table-row grouping
    anthropic.js    optional AI tier
  lib/
    dates.js  ics.js  diff.js  http.js
public/             the whole front end, no build step
tools/ocr.swift     on-device OCR (Apple Vision)
research/           the user interviews and the rules drawn from them
test/run.js         end-to-end tests
```

---

## Not in this version

- **Rota-style grids.** Finding *one person's row* in a dense 30-person matrix of
  two-letter shift codes is a genuinely different problem from reading a poster,
  and doing it at 84% accuracy is worse than not doing it.
- **Deadline chains** (a live date deriving prep deadlines backwards). The
  `derived_from` column exists so this is additive.
- **Live Google/Outlook sync.** `.ics` reaches all of them today without an OAuth
  review.
- **Anything multi-user.** One person's machine, one person's calendar.
