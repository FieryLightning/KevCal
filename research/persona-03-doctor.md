# Persona interview 03 — Dr Priya Raman, 36, hospital registrar (internal medicine)

Context: life governed by a 6-week rota published as a badly-formatted PDF, always
late. Plus mandatory training expiries, appraisal portfolio, exam sittings,
conference abstracts, rostered teaching, childcare handover negotiated against
every rota change. Hospital IT locked down and ancient; personal phone is the only
device that works. **Most likely of the four to actually pay.**

## 1. The incident
ALS (advanced life support) expired 14 October. Reminder was a PDF attachment
inside a Trust email, opened on a mess desktop that takes 90s to load Outlook.
Read it, thought "book that", walked to a crash bleep, never booked it. On the
15th she carried the arrest bleep with a lapsed certificate. Governance discussion
in her appraisal portfolio; re-did the course on a Saturday she'd promised her
daughter.

> "That Saturday is the cost. Not the certificate."

## 2. The rota (THE HARD ARTIFACT)
Landscape A3 squashed onto A4. **42 date columns** across the top, day-month, no
year, and **the month changes halfway across with no visual break**. Names down
the left, surname-initial, 31 people. Her row is 14. Cells are 2-char codes:
`LD` `ND` `N` `OC` `ZD` `AL` `SD` `TW` and blanks that mean either "off" or "the
coordinator hasn't filled it in yet". `LD` = 08:00-20:30. `N` = 20:00-08:30.
**`ZD` is a made-up local code that no legend anywhere defines** — she learned it
by asking.

> "A poster is *for me*. The rota is for thirty people and I need one horizontal
> slice, and every cell is two characters with no self-describing content. If your
> OCR slips one row I get Fenton's nights. There's no semantic check possible."

Requirements this implies: **anchor on her name, prove you found the right row,
show which column is which date, and keep an editable shift-code dictionary.**

Amendments: constant ("v4, due to gaps in cover"). Wants **only the diff**:
"3 changed, 1 added, 1 removed". Do NOT wipe and re-import — she has annotated
entries with childcare notes.

## 3. Recurrence
Very little truly repeats. Clinic is "Tuesday PM" except when on nights, on leave,
on a zero day, or bank holiday. Teaching is first Wednesday unless exam week.

> "If you guess 'every Tuesday' you'll put me in clinic during a night run and
> I'll stop trusting anything else you say. Generate the instances you actually
> saw and offer the pattern as a suggestion I accept."

## 4. Deadlines — THE FEATURE SHE'D BUY ALONE
> "A training expiry isn't an event, it's a wall with a runway in front of it."

Concrete ladder she asked for:
- **ALS expiry:** 90 days out (courses book up), 60, 30, 14, 7, then daily for last 3.
- **Appraisal portfolio:** 8 weeks out (it's ~20 hours of evidence-gathering).
- **Conference abstract:** 3 weeks, 1 week, day before.

Also: a deadline needs a **`satisfied` state that shuts it up without deleting it**,
so the wall still shows. Default lead-time ladders **per category, set once**.

## 5. Sharing
- **Partner:** needs her nights and long days for nursery pickup. Must land in
  **his** calendar — `.ics` or a link, not an app he installs.
- **Registrar group:** occasional swaps. **Juniors:** teaching dates, fine.
- **Hard line:** would share *her* shifts only. Never a file with 30 colleagues'
  names and working patterns — "that's their personal data and I'm not the
  controller of it." Tool must **export only her row and ideally never retain the
  other 29**.

## 6. After the import (25 shifts, 4 wrong)
A wrong shift = she's asleep when she should be on a ward. **84% accuracy is
worthless** — she'd check all 25, and then she'd just type them.

What earns trust:
- Source image left, **her row highlighted and the column boundary drawn**
- Extracted rows right, per-cell confidence
- Anything uncertain **forced into a review queue before import**
- Show raw cell text beside the interpretation: `N -> Night 20:00-08:30`

> "I'll tolerate 'I couldn't read 6 of these' far better than four silent errors."

## 7. Dealbreakers
- No patient data on a rota, but colleagues' names = personal data. Cloud is
  survivable **only with a plain statement**: processed, not retained, not trained
  on, deleted in X hours, and where. **On-device would end the argument.**
- Hospital wifi unusable -> must work on 4G and offline.
- Mandatory Google account = no. Sync must be optional.
- Price: **GBP 6-8/mo personally; GBP 15 if it did deadline nagging + rota diffs**
  (would expense it).

## 8. Verdict
> "Ship two things: a general capture tool, and a rota importer with a code
> dictionary, row-anchoring, a mandatory review screen and versioned diffs.
> The deadline handling is the bit nobody does well and I'd buy on its own."
