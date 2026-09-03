# KevCal

**One line:** KevCal turns a photo, screenshot or PDF of anything with dates on it
into calendar entries — showing you where each one came from, and undoing the
whole import with one button.

---

## Problem

> Dates arrive as pictures of documents, not as calendar invitations — and
> retyping them is the step that gets skipped, so the date is missed.

The concrete situation: a school letter, a class timetable, a poster on a wall, a
service reminder under a wiper blade, a screenshot of an email. Every one of them
contains commitments. None of them can be tapped. The gap between *seeing* the
date and *having* the date is about eight taps of manual entry, and that gap is
where things get lost.

Four user interviews (student, teacher, hospital registrar, marketing manager —
in `research/`) all produced the same shape of story: a real cost, caused not by
forgetting but by never having captured it in the first place.

- The student missed a 25% assessment because the handbook said "Wk 7 (Fri)" and
  she screenshotted it "for later".
- The teacher had two pupils miss a trip because a payment deadline moved in a
  one-line email under a paragraph about the photocopier.
- The registrar carried the arrest bleep with a lapsed ALS certificate.
- The marketing manager lost ~£20k to a 7pt footnote deadline in a promo grid.

## Approach

**A local-first web app on the Mac, opened from the phone over wifi, reading
documents entirely on-device.**

Why this beat the alternatives:

- macOS ships the Vision framework, so **OCR is free, offline, instant, and
  private** — and it returns bounding boxes, which turn out to be the whole trust
  mechanism (see R3 below). This one fact decided the platform.
- No account, no cloud, no API key, no `npm install`. First value is immediate,
  and there is no signup wall — the single most cited reason the personas
  abandoned previous tools.
- Zero dependencies means nothing to audit and nothing to break.

The design is governed by twelve rules derived from the research
(`research/SYNTHESIS.md`). The five that shaped the architecture:

| Rule | Why it exists |
|---|---|
| **R1 — never invent a recurrence** | All four personas said, unprompted, that a wrong repeat is worse than no repeat, because it is *silent* and it poisons trust in the correct entries too. KevCal creates only the instances the document evidences and offers the pattern as a suggestion you tap. |
| **R3 — provenance on every item** | Three personas independently designed the same UI: source on the left, extraction on the right. If you have to reopen the original to trust the output, the tool saved you nothing. |
| **R4 — review scales with risk** | The personas *appear* to conflict: the student quits if shown a review queue; the professionals quit if not. They are describing different risk levels. One clear poster date takes the three-tap path; a 40-row grid gets the full table. |
| **R5 — the Batch is a first-class object** | This is the keystone. One concept — the import — is simultaneously the unit of undo, of re-import diffing, of bulk edit, and of sharing. It answers all four of "correct, delete and share in one operation" at once. |
| **R12 — a deadline is not an event** | "A training expiry isn't an event, it's a wall with a runway in front of it." Deadlines get an escalating lead-time ladder and a *satisfied* state that silences them without deleting them. |

## Considered and rejected

| Option | Why not |
|---|---|
| **Native iOS app** | The right long-term answer for capture-at-the-moment, but not buildable in one night and not installable without an Apple developer account. |
| **Hosted SaaS** | Requires accounts, OAuth review, a security questionnaire, and a privacy story that two personas' employers would veto outright. It also puts a signup wall in front of first value. |
| **Write straight into Google Calendar, hold no state** | Impossible: batch undo needs import provenance, the amendment diff needs the previous version, and "show me where this came from" needs the source crop. Google Calendar can hold none of it. |
| **Require an Anthropic API key for OCR** | Would have made the app useless for its most privacy-constrained users and unusable on first run. On-device Vision is better, free, and faster; AI is now a strictly optional upgrade for messy layouts. |
| **A "share this list" link recipients tap** | Rejected by every persona. Nobody taps a link that writes to their calendar; the teacher is not legally permitted to send one to parents at all. Sharing is therefore export in four envelopes — text, image, `.ics`, subscribable feed — and the recipient installs nothing. |
| **Auto-deriving prep deadlines backwards from a live date** | Genuinely wanted by the marketing persona, but "proposed, never created". Deferred: the `derived_from` column exists so it is additive later. |

## Open questions

1. **Will the capture moment actually happen?** The riskiest assumption in the
   whole project. A laptop-hosted page on a phone only works if the Mac is awake
   and on the same wifi. If it isn't reached in the corridor, the platform is
   wrong. See "First step".
2. **Does the on-device tier hold up on real documents?** It is excellent on the
   synthetic fixtures and on clean letters. Real school PDFs are messier.
3. **Rota-style grids are not solved.** Locating *one person's row* in a dense
   unlabelled matrix is a different problem from reading a poster, and the
   research says so explicitly. Deliberately out of scope for v1.
4. **Reminders live in the calendar, not in KevCal.** KevCal cannot fire a
   notification when the Mac is asleep, so every reminder is written into the
   `.ics` as a real alarm. That is correct, but it means changing a lead time
   after export requires re-exporting.
5. **Google Calendar is reached via `.ics`, not OAuth.** "Add to Apple Calendar"
   hands the file to the Mac's calendar app, which for most people is already
   syncing to Google. Live OAuth sync was deliberately kept off the critical path.

## First step

**Test the assumption before building anything else on it.** Put the LAN URL on
the iPhone home screen and, for one hour of ordinary life, open it every time
anything dated crosses your path — a letter, a poster, a screenshot — and just
take the photo.

Two numbers matter: how often the capture screen appeared in under 5 seconds, and
how often you reached for it unprompted. **If fewer than 3 in 5 loads are under
5 seconds, the platform decision is wrong** and v1 should move to an always-on
host before another feature is added. If you never reached for it at all, the
problem is not the platform — it is that capture has to start from the iOS share
sheet, not from an app you have to remember.
