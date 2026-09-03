# Cross-persona synthesis — the rules that fall out of the research

Four personas (student, teacher, doctor, marketing manager) were interviewed
independently, with no shared context. Where four unrelated people converge
unprompted, that is a design constraint, not an opinion.

---

## The five things all four said independently

### 1. Wrong recurrence is worse than no recurrence
Every single persona raised this without being led, and three used almost the
same construction.

| Persona | Words |
|---|---|
| Maya | "A blank calendar is neutral. A lying calendar is actively poisonous." |
| Daniel | "Don't guess my timetable... do the one-off stuff." |
| Priya | "You'll put me in clinic during a night run and I'll stop trusting anything else you say." |
| Tom | "Wrong recurrence is worse than no recurrence, because it's silent." |

The failure is **silent**: a wrong one-off event is noticed once; a wrong rule
keeps generating wrongness forever, and it poisons trust in every *correct*
event alongside it.

> **RULE R1 — Never materialise a recurrence rule the user has not accepted.**
> Create the discrete instances actually seen in the document. Offer the detected
> pattern as a suggestion chip ("looks like every 2nd Thursday — extend?") that
> must be tapped. Working-day and skip-week logic, or no guess at all.

### 2. The date alone is not the deliverable — provenance is
Three of four independently designed the same UI: **source on the left,
extraction on the right.**

- Daniel: "show me the crop of the PDF each date came from side by side. Then I
  check seven, not forty."
- Priya: "source image on the left with my row highlighted and the column boundary
  drawn... show me the raw cell text next to your interpretation: `N -> Night 20:00-08:30`."
- Tom: "a link back to the source region so I can check the cell it came from
  without reopening the PDF."

If a user has to reopen the original document to trust the output, the tool saved
nothing. **The entire value proposition is destroyed by a missing crop.**

> **RULE R3 — Every extracted item stores its provenance:** source file, page,
> bounding box, the raw text span, and the interpretation applied to it. The
> review UI renders the crop next to the field. Non-negotiable.

### 3. Confidence must be exposed, and low confidence must block
Priya put it best and it generalises:

> "I'll tolerate 'I couldn't read 6 of these' far better than four silent errors."

An honest abstention is cheap. A confident error is catastrophic — and worse, it
is *invisible*, so the user discovers it by not turning up.

> **RULE R2 — Per-item confidence, and a hard gate.** Anything below threshold
> cannot be committed without an explicit human touch. Sort the review list
> worst-first, not document-order.

### 4. Amendments are the real job, not the initial import
Everyone imports once. Everyone then receives changes forever.

- Daniel: *"A tool that only does one-time imports gives me two parents' evenings
  and no idea which is live. That's worse than nothing."* — ~20 amendment emails/year
- Priya: *"v4, due to gaps in cover"* — wants **only the diff**, and her childcare
  annotations preserved
- Tom: *"When the live date moves, the whole chain moves with it. That's the actual job."*

A one-shot importer is a demo. A tool that reconciles v2 against v1 is a product.

> **RULE R6 — Re-import diffs against the existing batch.** Match, then report
> added / changed / removed / unchanged. Never wipe-and-recreate. Preserve
> user edits and annotations across a re-import.

### 5. Nothing writes to a calendar unreviewed... except when it must be instant
This is the one place the personas **conflict**, and it is the central design
tension of the product:

- **Maya** (phone, corridor, 11% battery): a review screen makes her quit. 3 taps.
- **Priya / Daniel / Tom** (25-40 dense rows, high cost of error): committing
  without review makes them quit. Tom: *"Staged draft, always."*

They are not actually disagreeing. They are describing **different risk levels**.
One poster with one unambiguous date is not the same act as a 40-row grid.

> **RULE R4 — Review effort scales with risk, not with dogma.**
> `risk = f(item count, min confidence, ambiguity, destination)`.
> Low risk -> a single confirm card, one tap, with undo.
> High risk -> the full review table, worst-first, commit blocked until touched.
> Writing to a *shared* destination is always high risk regardless of confidence.

---

## The unlock that makes correction/deletion/sharing tractable

Kevin asked for "correct, delete, and share a list to others **at one time
operation**". The personas independently demanded the same primitive:

- Maya: "one obvious button: **delete everything from this import**"
- Priya: diff **this version of the rota** against the last
- Tom: share **"Q4 Retail"** as a set, not 20 invites
- Daniel: **"IGNORE THE LAST ONE"** — he is manually versioning a shared set today

> **RULE R5 — The Batch is a first-class object, not an import log line.**
> Every capture creates a Batch. The Batch is simultaneously the unit of
> **undo**, **re-import/diff**, **bulk edit**, and **sharing**. One concept
> answers all four of Kevin's management requirements. This is the architectural
> keystone of the product.

---

## Deadlines are a different type from events

Priya's framing is the sharpest thing in the whole research:

> "A training expiry isn't an event, it's **a wall with a runway in front of it**."

An event has a *start time you attend*. A deadline has a *moment you must act
before*, and its useful lifetime is the runway, not the wall.

Requirements, from three personas:
- **Escalating lead-time ladder**, defaulted per category, set once (Priya:
  90/60/30/14/7/daily; Daniel: a week out, because a 15-min reminder is already
  too late; Maya: night before + morning of)
- **A `satisfied` state** that silences the nagging *without deleting the item*,
  so the wall still shows on the calendar
- **All-day / "by end of Friday" semantics**, not a 2pm point in time
- **Chains** (Tom): a live date derives prep deadlines backwards — **proposed,
  never auto-created** — and when the anchor moves, the chain moves

Maya's caveat keeps this honest: labels are decoration, behaviour is real. If
`deadline` only paints a chip a different colour, it is worthless. It must change
what the app *does*.

---

## Sharing: the recipient installs nothing. Ever.

Every persona rejected the obvious design (send a link that adds events):

| Persona | Rejection | What they would accept |
|---|---|---|
| Maya | "Nobody taps a link that says it's going to write to their calendar; that reads like giving someone your keys." | An **image** of the list, pasted into the group chat |
| Daniel | Not *allowed* to send parents a link from a personal tool — safeguarding | **Plain pasteable text**; `.ics` attachment for his Outlook department |
| Priya | Partner won't install an app | `.ics` that lands in **his** calendar |
| Tom | "Twenty individual invites is an act of violence" | A **subscribable feed** added once, updating in place; selective per recipient |

> **RULE R7 — Share is EXPORT, in four shapes, from one Batch:**
> **(a)** pasteable plain text, **(b)** a shareable image card, **(c)** an `.ics`
> file, **(d)** a subscribable feed URL that updates in place.
> Same content, four envelopes. Recipient installs nothing, signs up for nothing.

Tom adds the sting: *"calendar changes are invisible"* — a silently-updating feed
still needs an out-of-band notification when something moves.

---

## Adoption friction: what makes them quit before value

| Barrier | Who | Rule |
|---|---|---|
| Account before first value | Maya | **R8** — first successful capture requires zero signup |
| Mandatory Google account | Maya, Priya | Sync is opt-in, late, and per-user — never domain-wide (Tom: admin grant = "three-week conversation, probably no") |
| Google-only sync | Daniel (Outlook) | `.ics` is the universal escape hatch |
| "Allow all photos" | Maya | Camera-first; single-file picker; never library-wide |
| Can't install anything | Daniel (locked school laptop) | Must run in a browser |
| Cloud processing of third-party names | Priya (colleagues), Daniel (pupils) | **R9** — plain-English data statement; local-first storage; redaction |
| Per-seat pricing | Tom | The importer pays; receivers are free |
| Subscription at all | Maya | Free tier must be genuinely usable |

---

## The thing that is NOT the product

Tom, who is the most tool-fluent, delivered the strategic warning:

> "Gemini already half-does this in Gmail. That's my honest fear — you're a
> feature, and **your moat is the messy grid parsing plus the bulk correction UX,
> not the OCR**."

Reading a clean poster is a commodity and will be free in every OS within a year.
The defensible work is everything *after* extraction: the batch, the diff, the
review table, the undo, the four share envelopes, the deadline runway.

**Corollary:** do not spend the build on the model. Spend it on the ledger.

---

## Two products wearing one coat

Priya and Tom independently said the same structural thing:

- Priya: *"A poster is for me. The rota is for thirty people and I need one
  horizontal slice."* -> ship a general capture tool AND a rota importer separately
- Tom: *"A list is already a sequence of atomic facts; a grid is a coordinate
  system you have to decode, and half the semantics are in formatting."*

**Document mode** (poster, email, letter, syllabus) = find dates in prose.
**Grid mode** (rota, promo Gantt, timetable) = locate *my row* in an unlabelled
matrix, decode local shorthand via an editable dictionary, prove the row/column
mapping visually.

These need different prompts, different UIs and different trust ceremonies.
Grid mode is a v2 feature with a v1 seam left for it.

---

## Relative dates are a first-class parsing problem

- Maya: **"Wk 7 (Fri)"** — resolvable only against a term-week table on another page
- Daniel: **"w/c 18 Nov"** — a week-commencing, not a date
- Daniel: Week A / Week B, where an INSET Monday makes the following week still Week A
- Tom: **"first working Tuesday"** != first Tuesday; bank holidays break it

> **RULE R11 — An Anchor Calendar (term dates, week-1 start, holidays,
> working-day rules) is defined once and used to resolve relative expressions.**
> Unresolvable relative dates are surfaced as an explicit question, never guessed.

---

## Non-date fields are part of the payload

Tom: *"If your tool extracts a date and drops 'Deniz owns this, 1200x628, GBP 4k',
I've got a calendar full of dates I still have to go back to the PDF for."*

> **RULE R10 — Capture owner, location, channel, spec, cost and free-notes
> alongside the date.** A date without its context does not remove the return trip
> to the source document, which was the entire point.

---

## Summary: the twelve rules

| # | Rule |
|---|---|
| R1 | Never materialise an unaccepted recurrence rule; instances first, pattern as suggestion |
| R2 | Per-item confidence; low confidence hard-blocks commit; sort worst-first |
| R3 | Provenance on every item: source crop, bbox, raw span, interpretation |
| R4 | Review effort scales with risk; shared destinations are always high risk |
| R5 | The Batch is first-class: the unit of undo, diff, bulk edit and sharing |
| R6 | Re-import diffs, never wipes; user edits survive |
| R7 | Share = export in four envelopes; the recipient installs nothing |
| R8 | Zero signup before first value; sync opt-in, late, per-user |
| R9 | Local-first storage; honest plain-English data statement; redaction available |
| R10 | Extract the context fields, not just the date |
| R11 | Anchor Calendar resolves relative dates; unresolvable ones are asked, not guessed |
| R12 | Deadlines are a distinct type: runway, escalating ladder, satisfied state |
