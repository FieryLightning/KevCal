# Persona interview 04 — Tom, 29, marketing manager, DTC skincare brand (~60 people)

Context: Notion content calendar, a Google Calendar that is 80% meetings he didn't
book, Slack, and an Asana the team abandoned twice. Fluent in tools and therefore
cynical.

## 1. The incident
Tesco Q4 promo grid — PDF export of a Google Sheet, landscape, 14 columns, sent in
Slack. Their vitamin C serum had a 3-for-2 window starting 14 Oct. Tesco's asset
deadline for in-store POS + digital shelf was **22 working days before, not the 15
he had in his head** — stated in a **7pt footnote on page 3 of the same PDF**.
Found out 25 Sep they'd blown it by four days. No digital shelf takeover for the
first two weeks: **~GBP 18-22k in lost incremental**.

> "I'd already told the founder in a Monday meeting the takeover was locked.
> That's the bit that actually hurt."

## 2. The artifacts
- **Retailer promo grid:** horizontal Gantt. Time runs L-R in fortnights, SKUs down
  the side, **mechanic encoded in cell COLOUR**, deadline in a legend or footnote.
  > "A list is already a sequence of atomic facts; a grid is a coordinate system
  > you have to decode, and half the semantics are in formatting."
- **Agency media plan:** Excel, tabs per channel, weekly spend. **Flight dates are
  implicit — the flight is wherever the numbers stop being zero.**
- **Conference agenda:** JPEG screenshotted off the event site, two tracks side by side.

**Non-date fields he needs every time:** owner, channel, asset spec (1080x1350,
5MB max, bleed), budget line.
> "If your tool extracts a date and drops 'Deniz owns this, 1200x628, GBP 4k',
> I've got a calendar full of dates I still have to go back to the PDF for."

## 3. Recurrence
Real: Monday standup, monthly report first *working* Tuesday, QBR quarterly,
newsletter every second Thursday.
Where guessing hurts: a media plan with **four bursts on consecutive weeks is not
weekly-forever** — infer from 3 points and someone briefs creative for a phantom
week-five burst. Retail promo windows look periodic but skip Christmas and shift
around Easter. **"First working Tuesday" is not "first Tuesday."**
> "If you can't do working-day logic, don't guess recurrence at all. Wrong
> recurrence is worse than no recurrence, because it's silent."

## 4. Deadlines are CHAINS
Promo live 14 Oct -> retailer artwork due 22 working days prior -> creative review
3 days before that -> brief to agency 5 days before that. One live date generates
four dependent deadlines, each with a lead time that varies by retailer and channel.

> "Derived backwards? Yes — *proposed*, not created. Silently inventing tasks is
> overreach. And the killer feature nobody builds: **when the live date moves, the
> whole chain moves with it.** That's the actual job."

## 5. Sharing — the key case
Recipients: team of 5 (Google Calendar), media agency (Outlook, different org),
freelance designer (Gmail, cares about 3 dates of 30), retail account manager
(Tesco's system, will never accept anything from him).

> "Twenty individual invites to my team is an act of violence. I'd get Slack DMs
> within four minutes."

What works: **a subscribable shared calendar** — one "Q4 Retail" calendar added
once, owned and updated by him, in a distinct colour they can hide.
**Selective**: the designer wants her three deadlines, not the whole grid.
> "If sharing means 'everyone gets everything', it's useless."

When Tesco moves a window (every second cycle): must propagate to the subscribed
calendar **and fire an actual notification** — "calendar changes are invisible".
Plus something pasteable into an email for the other-org agency.

## 6. After the import (35 events, 8 wrong)
Needs a **review table before anything is created**: spreadsheet-shaped, editable
inline, confidence flag, **link back to the source region**, multi-select +
shift-click + bulk edit shared fields. Then "create 27".

> "Would I let it write straight to a shared team calendar? **No. Never.** Staged
> draft, always. One bad parse becomes five people's confusion and my credibility
> again."

## 7. Dealbreakers
- Ops lead controls OAuth approval, blocks unverified apps. **Domain-wide grant =
  three-week conversation, probably no. Per-user consent = fine.**
- Procurement: under ~GBP 500/yr expensed with no review; above = security
  questionnaire a two-person tool can't survive.
- **"You're a feature."** Gemini already half-does this in Gmail. Moat = messy grid
  parsing + bulk correction UX, **not the OCR**.
- **Per-seat pricing kills it** — only he imports; the other four only *receive*.
  Charge him, let them subscribe free.
- Team will roll their eyes; anything requiring them to log into a new thing is DOA.
  It survives only because they never have to see it.

## 8. Verdict
Would pay **GBP 15-20/mo for himself, on a card, no procurement**.
> "It's a single-operator utility that happens to have a team-facing *output* —
> and the second you sell it as a team tool you need SSO, admin consent, and a
> security review a tool this size can't survive."

Dies at: silent wrong recurrence, an import that dumps straight into the calendar,
or extraction that gets the date but drops the owner and the spec.
Lives at: stops hand-typing 30 dates off a Tesco grid; team subscribes to one
calendar that stays right when the retailer moves the window.
