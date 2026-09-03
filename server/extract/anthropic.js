// Tier 2 extraction (OPTIONAL, off by default).
//
// Deliberate choice: raw fetch rather than @anthropic-ai/sdk. KevCal is a
// zero-dependency app so that `node server/index.js` just works with no install
// step and nothing in node_modules to audit. The AI tier is opt-in; everything
// works without it. If you later add dependencies, swap this for the official SDK.
//
// Uses a strict tool definition rather than free-form JSON so the model's output
// is schema-validated by the API itself.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'kind', 'start_date', 'confidence', 'source_text'],
        properties: {
          title: { type: 'string', description: 'Short human title, no dates in it' },
          kind: { type: 'string', enum: ['event', 'deadline'] },
          start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if the document does not give one' },
          start_time: { type: ['string', 'null'], description: 'HH:MM 24h, or null for all-day' },
          end_date: { type: ['string', 'null'] },
          end_time: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          owner: { type: ['string', 'null'] },
          cost: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          confidence: { type: 'number', description: '0..1, be honest; low is better than wrong' },
          source_text: { type: 'string', description: 'The exact text from the document this came from, verbatim' },
          interpretation: { type: ['string', 'null'], description: 'How a shorthand was read, e.g. "w/c 18 Nov -> week beginning Mon 17 Nov"' },
          repeats_hint: { type: ['string', 'null'], description: 'Wording that suggests repetition, verbatim. Do NOT invent a rule.' },
          unresolved: { type: ['string', 'null'], description: 'If a date could not be resolved, the question you would ask' },
        },
      },
    },
  },
};

const SYSTEM = `You extract dated commitments from documents so they can become calendar entries.

Rules, in priority order:
1. NEVER invent a date. If the document says "Wk 7 (Fri)" or "every Tuesday" with no
   anchor you can resolve from the document itself, set start_date to null and put the
   question you would ask in "unresolved". A missing date is fine; a wrong date is not.
2. NEVER produce a recurrence rule. If wording implies repetition, quote it in
   "repeats_hint" and emit only the instances the document actually evidences.
3. Copy "source_text" verbatim from the document. It is used to show the user where
   each item came from; a paraphrase breaks that.
4. Be honest in "confidence". Low confidence routes the item to human review, which is
   the desired outcome for anything ambiguous. Confident errors are the worst outcome.
5. Classify as "deadline" when the date is a moment to act BEFORE (due, expires, closes,
   must be returned by, payment cutoff). Otherwise "event".
6. Capture context that would otherwise force the user back to the document: location,
   owner, cost, asset specs, and anything in fine print. Put it in notes.
7. Titles must be short and free of dates.`;

function mediaTypeFor(name = '') {
  const ext = name.toLowerCase().split('.').pop();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png';
}

export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * @param {{ base64?, filename?, isPdf?, text?, reference? }} input
 * @returns {Promise<{ok, items, error?, usage?}>}
 */
export async function extractWithAI(input) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, items: [], error: 'no_api_key' };

  const content = [];
  if (input.base64) {
    content.push(input.isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaTypeFor(input.filename), data: input.base64 } });
  }
  const todayLine = `Today's date is ${input.reference}. Use it only to resolve a year that the document omits; prefer the next upcoming occurrence.`;
  content.push({
    type: 'text',
    text: input.text
      ? `${todayLine}\n\nExtract every dated commitment from this text:\n\n${input.text}`
      : `${todayLine}\n\nExtract every dated commitment from this document.`,
  });

  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    tools: [{
      name: 'record_items',
      description: 'Record every dated commitment found in the document.',
      input_schema: ITEM_SCHEMA,
      strict: true,
    }],
    tool_choice: { type: 'tool', name: 'record_items' },
    messages: [{ role: 'user', content }],
  };

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, items: [], error: `network: ${e.message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, items: [], error: `http_${res.status}: ${detail.slice(0, 300)}` };
  }

  const json = await res.json();
  if (json.stop_reason === 'refusal') {
    return { ok: false, items: [], error: 'refusal' };
  }
  const block = (json.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_items');
  if (!block) return { ok: false, items: [], error: 'no_tool_use_in_response' };

  return { ok: true, items: block.input?.items ?? [], usage: json.usage };
}
