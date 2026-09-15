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

## Read this before using a free-tier Gemini key

Google's API terms draw a hard line between the free and paid tiers, and it is
about your data, not your money:

> **Unpaid Services:** "Google uses the content you submit to the Services and any
> generated responses to provide, improve, and develop Google products" — and
> "human reviewers may read, annotate, and process your API input and output".
> The terms then say plainly: *"Do not submit sensitive, confidential, or personal
> information to the Unpaid Services."*
>
> **Paid Services:** "Google doesn't use your prompts … or responses to improve our
> products."

What KevCal sends is photographs of school letters. Those name your children,
their school, their class and teacher, and often an address or a payment amount.
That is exactly the personal information Google's own terms tell you not to send
to the free tier.

**Three ways to be on the right side of that:**

| | |
|---|---|
| **Attach a Cloud Billing account to Google AI Studio** | Flips you to the paid terms, so nothing you send trains anything. Set a spend limit at the same time. |
| **Use OpenAI instead** (`OPENAI_API_KEY`) | "data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in)". Abuse logs are kept 30 days. |
| **Use no key at all** | The on-device reader never leaves the Mac. Worse on real documents — see PROGRESS.md — but nothing is uploaded. |

The free tier is fine for trying KevCal on a poster or a made-up letter. It is
the wrong place for your kids' post.

## Your API key

It lives in `.env`, which is git-ignored and never leaves this machine. It is
read into one outbound request header and nothing else: it is not logged, not
returned by any endpoint, and not inside the directory the web server can serve.
Provider error messages are redacted before they are displayed, because some of
them quote your key back at you.

Two things worth doing anyway, because a leaked key is a billing problem rather
than a privacy one:

- `chmod 600 .env` so other accounts on this Mac cannot read it.
- Set a **spend limit** in the provider's console. That is the real backstop —
  it caps the damage if a key ever escapes, and neither provider sets one for you.

Rotate the key if you ever paste a terminal transcript somewhere public.

## Keeping the bill at zero-ish

A Cloud Billing **budget** does not cap anything. Google's own caution:

> "Setting an *alerts-only* budget *doesn't* automatically cap Google Cloud or
> Google Maps Platform usage or spending."

That is the trap. Three things that do work, weakest to strongest:

**1. A real spend cap at Google.** AI Studio → **Spend** → *Monthly spend cap* →
Edit spend cap. This one does block calls. It is not exact — Google says you are
"subject to overages for around a 10 minute latency period" while billing data
catches up — but at one call per document that window is worth pennies.

**2. A hard quota, which rejects rather than warns.** Cloud console →
**IAM & Admin → Quotas & System Limits** → filter for the Generative Language
API → tick a quota → **Edit** → enter a *lower* number. Decreases are
self-service and need no approval: *"To restrict usage of a particular resource,
create a quota override by changing the quota value to a value less than the
default quota value."* Exceeding it returns `429 RESOURCE_EXHAUSTED` — a hard
stop with no billing lag. Setting requests-per-day to something like 50 caps
the worst case regardless of what any spend figure says.

**3. KevCal's own cap**, which has no lag at all:

```
KEVCAL_MONTHLY_BUDGET=5
```

It prices every call from a static table of both providers' published rates —
never fetched at runtime, because a spend guard that depends on the network
fails open the day the network hiccups — and refuses the *next* call before
making it, since stopping after the money is gone is not a cap. Over budget it
falls back to reading on-device, so importing still works. Settings shows the
month to date and the full price table; every screen carries a one-line total.

Its limit: it only sees what KevCal spends. If the key leaks, only (1) and (2)
protect you. Use all three.

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

## Trying it locally

Four ways, in order of what they cost you.

**Nothing at all — the whole app, clickable.**

```bash
npm run demo        # then open http://127.0.0.1:4322
```

Reading is served from a recorded answer instead of a model, so no key is used
and nothing is uploaded. It seeds three imports and leaves one in review, with
one date that needs an answer and one worth a check — so every state is there
to poke at: the flags, the editor, the provenance overlay, sharing, undo. It
writes to a throwaway directory, so your real imports are untouched, and the
dates are relative to today so it never goes stale.

**Nothing — the rules themselves.**

```bash
npm test            # 270 tests, no key, no network
npm run doctor      # is this machine set up safely?
```

**About a penny — one real page, read for real.**

```bash
npm start           # then open the address it prints
```

Import `samples/school-letter.png`, or photograph something on your desk. This
is the only way to find out whether the reader is any good on your documents.
The running-cost line at the bottom of every screen tells you what it spent.

**About two pence — both readers on the same page.**

```bash
npm run ab -- samples/school-letter.png
```

Needs both keys. Prints what they agreed on and, where they differ, each one's
verbatim quote beside its answer — which usually makes it obvious which
misread the page.

### Testing the awkward cases

The after-midnight rule is hard to try on purpose, because the app uses your
phone's real clock. To exercise it without staying up:

```bash
npm run ab -- letter.jpg --now 2026-09-10T00:20
```

Or drive the API directly, which is how the tests do it:

```bash
curl -s localhost:4321/api/capture -H 'content-type: application/json' \
  -d '{"kind":"text","text":"The trip leaves tomorrow at 8am","now":"2026-09-10T00:20"}'
```

## Running it somewhere always on

KevCal *is* the machine it runs on — your phone only loads a page the server is
serving, so if the host sleeps, KevCal is gone until it wakes. Same wifi is the
extra constraint on top of that, and campus networks usually stop devices
reaching each other anyway.

**[DEPLOY.md](DEPLOY.md)** covers moving it to an always-on host: what you give
up by leaving macOS (the on-device cross-check and the offline fallback — the
grammar cross-check survives intact), a small VPS start to finish, the systemd
unit and Caddyfile in `deploy/`, backups, and a checklist before you trust it
with real post.

Before starting it anywhere, run:

```bash
npm run doctor
```

It checks the things that actually go wrong — a missing token on a public bind,
a server left on UTC, a key with no ceiling, a world-readable `.env` — and exits
non-zero on anything dangerous, so it can gate a deploy. The systemd unit runs
it before every start.

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
