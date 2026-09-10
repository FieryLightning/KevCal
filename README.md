# KevCal

**Point your phone at anything with a date on it, and get a calendar entry —
without it ever quietly inventing the date.**

School letters, timetables, posters, appointment cards, service reminders,
screenshots of emails. Photograph it, check what it found, add it.

---

## The one idea

The first version of KevCal read documents with a pile of hand-written date
patterns. It was fast and private and it was **confidently wrong** often enough
to be dangerous — at one point it read *"Contract ends December 2031"* and filed
it as **20 December 2025, at 94% confidence**, because the day pattern ate the
first two digits of the year.

A wrong date is worse than a missing one, because it is silent. So v2 splits the
job in two, and neither half is allowed to do the other's work:

| | |
|---|---|
| **The reader** (Gemini *or* OpenAI — your choice) | Looks at the page and reports *what is printed*: the words, the weekday as written, whether a year appeared at all, whether am/pm was stated. It is explicitly forbidden from doing calendar arithmetic — "tomorrow" comes back as the word "tomorrow", not as a date. |
| **The checker** (`server/extract/verify.js`) | Does every calculation, in one testable place. It re-reads the reader's own quoted text, compares the weekday against the date, checks the year is actually on the page, and sanity-checks how far away the date is. |

When those two disagree, KevCal does not pick a winner. It asks you.

### Which reader?

Both get the *same* instructions and return the *same* shape — `server/extract/contract.js`
is shared, and `verify.js` downstream cannot tell them apart. Swapping providers
changes accuracy and cost, never the safety rules. Set either key, or both plus
`KEVCAL_READER`.

| | Gemini | OpenAI |
|---|---|---|
| **Bounding boxes** | native — it boxes the phrase it read, so the highlight-on-your-photo works on its own | weaker; provenance falls back to matching the quote against the on-device OCR |
| **Schema enforcement** | asked for, mostly honoured | `strict: true` — the API validates the shape, so the answer *cannot* come back malformed |
| **PDFs** | native document input | native, pages read as images |
| **Default** | picked first when both keys are present | `KEVCAL_READER=openai` to force |

On a Mac with `npm run build:tools` done, geometry comes from the on-device OCR
anyway, so the box difference mostly disappears and the choice comes down to
price and which key you already have.

**Settle it on your own documents.** General benchmarks say nothing useful about
which model reads *your* folded, badly-lit school letter correctly. With both
keys set:

```bash
npm run ab -- samples/school-letter.png
npm run ab -- --text "Parents evening Thursday 12 March at 4.30"
npm run ab -- letter.jpg --now 2026-09-10T00:20   # also exercises the midnight rule
```

It runs the same page through both, puts each answer through the same checker,
and prints what they agreed on, where they disagree (with each one's verbatim
quote, so you can see *why*), and what only one of them found. Where they
disagree is where to look — that is the answer, and it costs one call each.

---

## What it will not do

- **It will not guess a date it cannot work out.** No date is better than a wrong
  one. It says what it could not resolve and gives you a box to type in.
- **It will not silently fix an impossible date.** "29 February 2027" comes back
  as *unreadable*, never rounded to a nearby real day.
- **It will not resolve "tomorrow" without saying what it counted from.** If the
  letter dates itself, it counts from the letter. If it doesn't, it counts from
  today *and tells you it did that.*
- **It will not ignore the clock.** Import at **00:20** and "tomorrow" becomes a
  question, because a letter written last night means the day that has, by the
  clock, already started. You get both days as buttons.
- **It will not assume a date is in the future.** Anything already past, or more
  than about 18 months out, is flagged — those are almost always misreads.
- **It will not invent a repeat.** "Every other Tuesday" is quoted back at you as
  a suggestion you tap, never a rule it writes. A repeat always needs an end.

Everything it *did* have to assume — a missing year, an unstated am/pm — is
stated in plain words on the card, with the other reading one tap away.

Two levels of flag:

- **Needs your answer** (red) — the app has no answer, or two sources disagree.
  It cannot reach your calendar until you resolve it.
- **Worth a check** (amber) — there was a defensible answer but a choice was
  made. It goes through, but it says so.

---

## Getting it running

### 1. What you need

| | | |
|---|---|---|
| **Node 22.5+** | required | `node -v`. Nothing to `npm install` — KevCal has no dependencies. |
| **One reading key** | strongly recommended | Either [aistudio.google.com](https://aistudio.google.com) → **Get API key** (Gemini), or [platform.openai.com](https://platform.openai.com) (OpenAI). See the trade below. |
| **Xcode Command Line Tools** | recommended | `xcode-select --install`. Builds the on-device reader used for the cross-check and as the offline fallback. |
| **A tunnel** | only to leave your wifi | `brew install cloudflared`. See below. |

### 2. Set it up

```bash
cd ~/KevCal
cp .env.example .env      # paste in a Gemini key OR an OpenAI key
npm run build:tools       # once — compiles the on-device cross-checker
npm start
```

It prints the addresses to open, and states plainly which engine is reading your
documents and whether the door is locked.

### 3. Put it on your phone

Open the address it printed in Safari, tap **Share → Add to Home Screen**. It
runs full screen with its own icon.

### 4. Capture from the share sheet (the part that matters)

The reason v1 didn't get used wasn't the reading — it was that you had to
remember to open it. Build this once in **Shortcuts** and KevCal appears in the
iOS share sheet, so a photo goes from Photos or Mail straight into it:

1. Shortcuts → **+** → tap ⓘ → turn on **Show in Share Sheet**.
2. **Base64 Encode** ← Shortcut Input.
3. **Get contents of URL** → `https://your-address/api/quick`, POST, header
   `Content-Type: application/json`, body **JSON**:
   `data` = the Base64 result, `filename` = `photo.jpg`,
   `now` = Current Date formatted `yyyy-MM-dd'T'HH:mm`.
4. **Open URLs** ← the `url` value from the response. Name it *KevCal*.

The exact steps, with your own address filled in, are in **Settings**.

### 5. Leaving your own wifi

A laptop on your home network is only reachable at home. To reach it from the
school gate:

```bash
# in .env, first:  KEVCAL_TOKEN=$(openssl rand -base64 24)
cloudflared tunnel --url http://localhost:4321
```

**Set `KEVCAL_TOKEN` before you do this.** Without it, anyone who finds the URL
can read your imported letters. With it, every request needs the key, and the
link you saved to your home screen (`…/?k=…`) carries it for you. It is a bearer
token, not an account system — treat the link like a password.

---

## Where your things go

Everything lives in `./data` on your own machine: a SQLite file and the original
images. No account, no sign-in, nothing synced anywhere.

**The exception, stated plainly:** when a Gemini key is set, the page you import
is uploaded to Google to be read. That is the whole trade v2 makes — real
accuracy on real documents in exchange for the "nothing leaves this Mac" promise
v1 could make. The header says `read by Gemini` whenever that is true, and with
no key the app falls back to reading entirely on-device.

Deleting an import deletes its original image too.

---

## The rest of what it does

- **Every import is one batch** — which is also the unit of undo, of bulk edit,
  of sharing, and of reconciling a re-issued document. *Imports → Undo* takes the
  whole thing back out; *Restore* puts it back.
- **Provenance on everything.** Tap a date and you get the crop of the page it
  was read from, the exact quoted text, and how it was interpreted.
- **Re-import diffs, it doesn't duplicate.** The amended letter gives you
  *"1 changed, 1 added"* — and anything you edited by hand is never reverted.
- **Deadlines aren't events.** They get escalating reminders (30/14/7/2/0 days by
  default), a runway bar, and a *sorted* state that silences without deleting.
- **Sharing installs nothing.** Plain text, a `.ics` file, or a subscribable feed
  you can revoke.
- **Times carry a real timezone**, so a shared calendar doesn't shift hours for
  whoever opens it.

---

## Layout

```
server/
  index.js          HTTP, routing, the token lock
  api.js            batches, items, sharing, settings
  db.js             SQLite schema (node:sqlite, no native build)
  extract/
    gemini.js       the reader — reports what is printed, does no arithmetic
    verify.js       the checker — every calculation and every flag lives here
    index.js        orchestrator: reader + on-device cross-check, or fallback
    grammar.js      deterministic date parsing (fallback engine AND cross-check)
    build.js        grammar path: raw hits -> items      rows.js  table grouping
  lib/
    ics.js  dates.js  diff.js  http.js  env.js
public/             the whole front end — no build step, no framework
tools/              ocr.swift (on-device reader)   make-icon.mjs (app icons)
test/
  verify.test.js    the checking rules, unit tested
  run.js            end-to-end against a live server
```

## Testing

```bash
npm test
```

213 tests, no API key needed and no network calls: the reader is driven from a
recorded fixture (`KEVCAL_FAKE_READER`), so every flag has an end-to-end test
that costs nothing and never flakes.

---

## Not in this version

- **Rota grids.** Finding one person's row in a 30-person matrix of two-letter
  shift codes is a different problem, and doing it at 84% accuracy is worse than
  not doing it.
- **Live Google/Outlook sync.** `.ics` reaches all of them today with no OAuth.
- **Deadline chains** (a live date deriving prep deadlines backwards). The
  `derived_from` column exists so this is additive.
- **Anything multi-user.** One person's machine, one person's calendar.
