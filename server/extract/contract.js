// What KevCal asks a reader for, and the exact terms it asks on.
//
// This file is deliberately provider-neutral. Gemini and OpenAI get the *same*
// instructions and the *same* shape of answer, so swapping one for the other
// changes who reads the page and nothing else — verify.js downstream cannot tell
// them apart, and neither can the tests.
//
// The one rule the whole contract turns on: the reader reports what is PRINTED.
// It does not work out what that means in today's terms. All arithmetic happens
// later, in one place, where it can be tested and where a disagreement can be
// surfaced instead of silently resolved.

export const ITEM_PROPERTIES = {
  title: { type: 'string', description: 'Short human title for the calendar entry. No dates inside it.' },
  kind: { type: 'string', enum: ['event', 'deadline'], description: 'deadline = a moment to act BEFORE (due, closes, expires, return by, payment cut-off). Otherwise event.' },

  start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, ONLY when the document prints an actual calendar date. null for anything relative or unstated.' },
  end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD for the last day of a multi-day range, else null.' },
  has_explicit_year: { type: 'boolean', description: 'true only if a year is printed next to this date. If you had to assume the year, this is false.' },
  weekday_stated: { type: ['string', 'null'], description: 'The weekday word printed alongside the date, verbatim ("Thursday", "Fri"). null if none was printed. Do not work it out yourself.' },

  relative_phrase: { type: ['string', 'null'], description: 'Verbatim relative wording used instead of a date ("tomorrow", "next Friday", "in 3 weeks"). null if the document printed a real date.' },
  relative_kind: { type: ['string', 'null'], enum: ['today', 'tomorrow', 'tonight', 'this_weekday', 'next_weekday', 'in_n_days', 'in_n_weeks', 'end_of_month', 'other', null], description: 'Machine-readable form of relative_phrase.' },
  relative_weekday: { type: ['string', 'null'], enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', null] },
  relative_n: { type: ['integer', 'null'], description: 'The number in "in 3 days" / "in 2 weeks".' },

  start_time: { type: ['string', 'null'], description: 'HH:MM 24-hour. null for an all-day item.' },
  end_time: { type: ['string', 'null'], description: 'HH:MM 24-hour, else null.' },
  am_pm_stated: { type: 'boolean', description: 'true if the document printed am/pm, or used a 24-hour clock, or said morning/evening. false if you had to assume which half of the day it meant.' },

  location: { type: ['string', 'null'] },
  owner: { type: ['string', 'null'], description: 'Whose commitment this is, if the document names a person, class, year group or team.' },
  cost: { type: ['string', 'null'], description: 'Any amount of money attached, with its symbol.' },
  notes: { type: ['string', 'null'], description: 'Anything that would otherwise force the user back to the document: what to bring, who to contact, conditions in fine print.' },

  confidence: { type: 'number', description: '0 to 1. Be honest. Low confidence sends this to a human, which is the correct outcome for anything doubtful.' },
  source_quote: { type: 'string', description: 'The exact text from the document this came from, copied character for character. Never paraphrase; this is shown to the user as proof and is re-parsed by a checking program.' },
  box_2d: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Bounding box of source_quote as [ymin, xmin, ymax, xmax] normalised to 0-1000. null if you cannot place it.' },
  page: { type: ['integer', 'null'], description: '1-based page number for a multi-page document.' },
  interpretation: { type: ['string', 'null'], description: 'How a shorthand was read, e.g. "w/c 18 Nov -> week beginning Monday 17 Nov".' },
  repeats_hint: { type: ['string', 'null'], description: 'Verbatim wording suggesting repetition. NEVER build a repeat rule; just quote the words.' },
  unresolved: { type: ['string', 'null'], description: 'If something could not be pinned down, the question you would ask the user, in plain words.' },
};

/** The fields a reader must always supply. The rest may be null. */
const ITEM_REQUIRED = ['title', 'kind', 'start_date', 'has_explicit_year', 'am_pm_stated', 'confidence', 'source_quote'];

export const DOC_PROPERTIES = {
  document_date: { type: ['string', 'null'], description: 'YYYY-MM-DD printed ON the document as its own date (letter date, email "Sent:", newsletter masthead). null if the document does not date itself. This is how relative wording gets anchored, so look for it carefully.' },
  document_span: { type: ['string', 'null'], description: 'A year span the document names for itself, e.g. "2026-2027" from "Academic Calendar 2026-2027". null if absent.' },
  document_title: { type: ['string', 'null'], description: 'The headline of the document, for naming this import.' },
  document_kind: { type: ['string', 'null'], description: 'What sort of document this is, in two or three words ("school letter", "appointment card", "poster").' },
};

export const SCHEMA = {
  type: 'object',
  properties: {
    ...DOC_PROPERTIES,
    items: {
      type: 'array',
      items: { type: 'object', properties: ITEM_PROPERTIES, required: ITEM_REQUIRED },
    },
  },
  required: ['items'],
};

/**
 * OpenAI's strict mode is stricter than Gemini's: every object must forbid extra
 * properties and must list EVERY property as required, with optionality
 * expressed as a union with null. That is a real advantage — the API validates
 * the shape rather than trusting the model — so rather than keep two schemas in
 * step by hand, the one above is transformed into it.
 */
export function toStrict(node) {
  if (Array.isArray(node)) return node.map(toStrict);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = toStrict(v);
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

export const SYSTEM = `You read documents and report the dated commitments printed on them, so they can become calendar entries.

You are the READER. A separate program does the calendar arithmetic. Your job is to report faithfully what the page says, not to work out what it means in today's terms.

HARD RULES

1. NEVER calculate a date. If the document says "tomorrow", "next Friday", "this Thursday", "in three weeks" or "week 7", set start_date to null, and instead fill relative_phrase / relative_kind / relative_weekday / relative_n. You do not know today's date, and guessing is the single worst thing you can do here.

2. NEVER invent a year. Set has_explicit_year to false whenever the year is not printed beside that date, and put your best reading in start_date anyway using the document's own context if it has one. If you genuinely cannot tell, leave start_date null and write the question in "unresolved".

3. NEVER build a recurrence rule. If the page implies repetition, quote the wording in repeats_hint and emit only the specific occurrences the document actually lists.

4. source_quote must be copied verbatim from the page, including its odd spacing or line breaks. It is displayed to the user as evidence and it is re-parsed by a checking program. A paraphrase breaks both.

5. weekday_stated is only for a weekday the document PRINTED. Never derive it. This is deliberately redundant: the checking program compares it against the date to catch misreadings.

6. am_pm_stated is false whenever you had to decide which half of the day "3.30" meant. That is not a failure; it routes the item to a human, which is correct.

7. Be honest in confidence. A confident wrong date is far worse than an uncertain right one. Anything smudged, handwritten, cropped, or ambiguous belongs below 0.7.

8. Report only real commitments. Skip page numbers, phone numbers, prices, reference codes, addresses and years mentioned in passing. If a number is not something a person needs to turn up for or act before, it is not an item.

9. Read the whole page including footnotes and fine print. The dates that get missed in real life are the small ones under the main text.

10. Titles are short, specific, and contain no dates. "Parents' evening", not "Parents' evening on 12 March".

BOXES

box_2d locates source_quote on the page as [ymin, xmin, ymax, xmax], each normalised to 0-1000. Tight to the text. If you cannot place it, use null rather than a guess.

TABLES AND GRIDS

Read a row as one thing. A date in one column and its title in another belong to the same item. If a table has a header row naming what each column means, use it. Never label every row with the page heading — if you cannot tell which text belongs to a date, say so in "unresolved" rather than repeating the header.`;

export const USER_PROMPT = {
  document: 'Report every dated commitment on this document.',
  text: (t) => `Report every dated commitment in this text.\n\n---\n${t}\n---`,
};

/** Normalise whatever a provider returned into the shape verify.js expects. */
export function shapeResult(parsed, model) {
  return {
    ok: true,
    model,
    doc: {
      document_date: parsed.document_date ?? null,
      document_span: parsed.document_span ?? null,
      document_title: parsed.document_title ?? null,
      document_kind: parsed.document_kind ?? null,
    },
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

/** Models wrap JSON in a fence even when told not to. */
export function parseJSONLoosely(text) {
  const raw = String(text || '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(unfenced); } catch { /* keep looking */ }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

/**
 * Provider error bodies are shown to the user in the app, and some of them
 * quote your key back at you — OpenAI's 401 reads "Incorrect API key provided:
 * sk-proj-…". Nothing credential-shaped should reach a browser tab, a
 * screenshot, or a KevCal instance sitting on a public tunnel.
 *
 * The pattern list catches the common shapes; the loop at the end is the real
 * guarantee, because it removes the live key whatever shape it happens to be.
 */
export function redactSecrets(text) {
  let s = String(text ?? '');
  s = s.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{3,}/g, '[redacted]');
  s = s.replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '[redacted]');
  s = s.replace(/\b(bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]');
  s = s.replace(/((?:api[_-]?key|access[_-]?token|authorization)["'\s:=]{1,4})[A-Za-z0-9._-]{12,}/gi, '$1[redacted]');
  for (const secret of [process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY, process.env.KEVCAL_TOKEN]) {
    if (secret && secret.length >= 8) s = s.split(secret).join('[redacted]');
  }
  return s;
}

/**
 * Providers report failure in their own vocabulary, and the raw text lands in
 * front of the user. "http_403: Your project has been denied access" says
 * nothing about what to do next; these do.
 */
export function explainError(error, detail = '') {
  const text = String(detail || '');
  const code = String(error || '');

  if (/denied access|permission_denied/i.test(text)) {
    return 'The provider is refusing this project access to its models. The key itself is fine — '
         + 'it is the project behind it that is not allowed. Check the API is enabled and the terms '
         + 'accepted in the provider console, or switch readers with KEVCAL_READER.';
  }
  if (/no longer available/i.test(text)) {
    return 'That model has been retired. Set GEMINI_MODEL or OPENAI_MODEL in .env to a current one.';
  }
  if (code.startsWith('http_401') || /invalid.*(api key|authentication)/i.test(text)) {
    return 'The provider rejected the key. Check it was pasted whole into .env, then restart.';
  }
  if (code.startsWith('http_429') || /quota|rate limit/i.test(text)) {
    return 'You have hit the provider\'s rate limit or quota. Wait a few minutes, or raise the limit.';
  }
  if (code === 'timeout') return 'The reader took too long to answer. A smaller or clearer photo usually helps.';
  if (code === 'network') return 'Could not reach the provider. Check this machine is online.';
  if (code === 'no_api_key') return 'No reading key is set, so there was nothing to ask.';
  return null;
}

export function mediaTypeFor(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  }[ext] || 'image/jpeg';
}
