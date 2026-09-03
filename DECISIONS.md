# Decisions made while you were asleep

You said: *"make choices for me, if needed. pick easy and safe options"* and
*"use agents for my role."* So these were decided by a product-owner proxy
briefed on your original message plus the four persona interviews.

**None of these are irreversible.** Each row says what it would cost to change.
Anything you disagree with, say so and I'll switch it.

| # | Decision | Why | Cost to change |
|---|---|---|---|
| D1 | **Local web app on your Mac, used from your phone over wifi** | Only option buildable in one night, and it inherits free on-device OCR. No App Store, no hosting, no account. | Medium. The server/UI split survives; a native shell or a hosted deploy is a port, not a rewrite. |
| D2 | **v1 is for you, in household/parent mode** | Serving four personas produces mush. Your own examples (school calendar, car reminder) are the spine. | Low. |
| D3 | **Review appears only when the machine is unsure** | Resolves the one real conflict in the research: the student quits if shown a queue, the professionals quit if not. Threshold: all-confident and ≤3 items → confirm card; otherwise review table. | Low — one function, `assessRisk()` in `server/extract/index.js`. |
| D4 | **KevCal owns its own store; calendars are a projection** | Batch undo, the amendment diff and "where did this come from" all need data a calendar cannot hold. | High. This is the architecture. |
| D5 | **No API key required; on-device OCR is the default** | Works on first run, costs nothing, and is the only version two personas' employers would permit. AI is an opt-in upgrade. | Low — already a toggle. |
| D6 | **Never create a recurring event automatically** | The single strongest finding in the research; all four said it unprompted. | Low to relax, but don't. |
| D7 | **Google Calendar via `.ics`, not OAuth** | "Add to Apple Calendar" hands the file to your Mac's calendar app, which is very likely already syncing to Google. OAuth needs a Cloud console project and can block on Google, so it stayed off the critical path. | Medium — additive. Say the word if you want real two-way sync. |
| D8 | **Sharing = text, image, `.ics`, feed** | Every persona rejected "send a link that adds events". The recipient installs nothing. | Low. |
| D9 | **Fun = speed, visible provenance, and safe reversal** | Boxes animate onto your source image, the count counts up, ⌘V imports a screenshot instantly, undo is always one tap. No streaks, XP, confetti or mascot. | Low. |
| D10 | **Rota grids and deadline chains deferred** | Both are large and both are a different product. `derived_from` column left in place for chains. | n/a |
| D11 | **Zero npm dependencies** | Nothing to install, nothing to audit, no supply chain. Uses `node:sqlite` and built-in `http`. | Low, but it's a nice property to keep. |
| D12 | **Kept the name KevCal** | Renaming later is free; spending decision budget on branding now is not. | Free. |

## The one thing worth your judgement tomorrow

**Will you actually reach for it at the moment the letter is in your hand?**

Everything above rests on D1, and D1 assumes a page served from your Mac is
available and fast enough to beat just typing the date in — or not bothering.
A wrong extraction engine is a swappable module. A wrong capture moment
invalidates the platform.

The hour-long test to settle it is at the end of `BRIEF.md`.

## Deliberate deviations from convention

- **Raw `fetch` instead of the official Anthropic SDK** in
  `server/extract/anthropic.js`. This is the one place I went against the usual
  guidance, to preserve the zero-dependency property (D11). The AI tier is
  optional and off by default. If you'd rather have the SDK, it's a small swap
  and `npm install @anthropic-ai/sdk`.
- **No git commits pushed anywhere.** The repo is local only.
