// Reader: OpenAI, via the Responses API.
//
// Same contract as the Gemini reader, same output shape. The one meaningful
// difference is in KevCal's favour: `strict: true` makes the API itself enforce
// the schema, so the answer cannot come back a shape verify.js does not expect.
// The one against it is box_2d — these models are weaker at putting a box round
// a phrase than Gemini is, so on a machine without the on-device OCR the
// provenance overlay degrades to the quoted text alone.

import { SYSTEM, SCHEMA, USER_PROMPT, toStrict, shapeResult, parseJSONLoosely, mediaTypeFor, redactSecrets } from './contract.js';

const URL = 'https://api.openai.com/v1/responses';

const PRIMARY = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const FALLBACKS = ['gpt-5.6-luna', 'gpt-6-astra'];

const STRICT_SCHEMA = toStrict(SCHEMA);

export function available() { return Boolean(process.env.OPENAI_API_KEY); }
export function model() { return PRIMARY; }

/** The raw REST response nests text inside output[].content[]; SDKs flatten it, we can't. */
function outputTextOf(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) return body.output_text;
  const chunks = [];
  for (const item of body?.output || []) {
    if (item?.type === 'reasoning') continue;
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
}

async function callOnce(name, content, signal) {
  const res = await fetch(URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: name,
      instructions: SYSTEM,
      input: [{ role: 'user', content }],
      text: {
        format: {
          type: 'json_schema',
          name: 'dated_commitments',
          schema: STRICT_SCHEMA,
          strict: true,
        },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `http_${res.status}`, detail: redactSecrets(detail).slice(0, 400) };
  }
  return { ok: true, body: await res.json() };
}

export async function read(input) {
  if (!available()) return { ok: false, error: 'no_api_key' };

  const content = [];
  if (input.base64) {
    content.push(input.isPdf
      ? {
          type: 'input_file',
          filename: input.filename || 'document.pdf',
          file_data: `data:application/pdf;base64,${input.base64}`,
        }
      : {
          type: 'input_image',
          image_url: `data:${mediaTypeFor(input.filename)};base64,${input.base64}`,
          detail: 'high',   // fine print is the whole point; low detail loses footnotes
        });
  }
  content.push({
    type: 'input_text',
    text: input.text ? USER_PROMPT.text(input.text) : USER_PROMPT.document,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 90_000);
  try {
    const chain = [PRIMARY, ...FALLBACKS.filter((m) => m !== PRIMARY)];
    let last = null;
    for (const name of chain) {
      let attempt;
      try {
        attempt = await callOnce(name, content, controller.signal);
      } catch (e) {
        if (e.name === 'AbortError') return { ok: false, error: 'timeout' };
        return { ok: false, error: 'network', detail: redactSecrets(e.message) };
      }
      if (attempt.ok) {
        if (attempt.body?.status === 'incomplete') {
          return { ok: false, error: 'incomplete', detail: attempt.body?.incomplete_details?.reason };
        }
        const refusal = (attempt.body?.output || [])
          .flatMap((o) => o?.content || [])
          .find((c) => c?.type === 'refusal');
        if (refusal) return { ok: false, error: 'refusal', detail: refusal.refusal };
        const parsed = parseJSONLoosely(outputTextOf(attempt.body));
        if (!parsed) return { ok: false, error: 'unreadable_response', model: name };
        return { ...shapeResult(parsed, name), usage: attempt.body?.usage ?? null };
      }
      last = attempt;
      // A model that is missing, renamed, or not entitled to this project is
      // worth retrying further down the chain. A refusal aimed at the whole
      // project is not — every model will say the same thing.
      const projectWide = /project/i.test(attempt.detail || '');
      const retryable = !projectWide && (
        attempt.status === 404
        || attempt.status === 403
        || (attempt.status === 400 && /model/i.test(attempt.detail || ''))
      );
      if (!retryable) break;
    }
    return { ok: false, error: last?.error || 'failed', detail: last?.detail, status: last?.status };
  } finally {
    clearTimeout(timer);
  }
}
