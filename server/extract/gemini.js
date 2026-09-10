// Reader: Google Gemini, via the interactions API.
//
// Same contract as the OpenAI reader, same output shape. Its advantage for
// KevCal is spatial grounding: it will put a box round the phrase it read, which
// is what draws the highlight on your photo without needing the on-device OCR to
// find the line first.

import { SYSTEM, SCHEMA, USER_PROMPT, shapeResult, parseJSONLoosely, mediaTypeFor } from './contract.js';

const URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const PRIMARY = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACKS = ['gemini-3.6-flash', 'gemini-2.5-flash'];

export function available() { return Boolean(process.env.GEMINI_API_KEY); }
export function model() { return PRIMARY; }

function outputTextOf(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) return body.output_text;
  const chunks = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    // A thought block is the model's reasoning, not its answer.
    if (node.type === 'thought' || node.thought === true) return;
    if (typeof node.text === 'string') chunks.push(node.text);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(body?.steps ?? body);
  return chunks.join('');
}

async function callOnce(name, parts, signal) {
  const res = await fetch(URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      model: name,
      system_instruction: SYSTEM,
      input: parts,
      response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
      generation_config: { temperature: 0, thinking_level: 'low' },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `http_${res.status}`, detail: detail.slice(0, 400) };
  }
  return { ok: true, body: await res.json() };
}

export async function read(input) {
  if (!available()) return { ok: false, error: 'no_api_key' };

  const parts = [];
  if (input.base64) {
    parts.push(input.isPdf
      ? { type: 'document', data: input.base64, mime_type: 'application/pdf' }
      : { type: 'image', data: input.base64, mime_type: mediaTypeFor(input.filename) });
  }
  parts.push({
    type: 'text',
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
        attempt = await callOnce(name, parts, controller.signal);
      } catch (e) {
        if (e.name === 'AbortError') return { ok: false, error: 'timeout' };
        return { ok: false, error: 'network', detail: e.message };
      }
      if (attempt.ok) {
        const parsed = parseJSONLoosely(outputTextOf(attempt.body));
        if (!parsed) return { ok: false, error: 'unreadable_response', model: name };
        return { ...shapeResult(parsed, name), usage: attempt.body?.usage ?? null };
      }
      last = attempt;
      // Only a missing or renamed model is worth retrying down the chain; an auth
      // or quota failure will fail identically on every model.
      const retryable = attempt.status === 404 || (attempt.status === 400 && /model/i.test(attempt.detail || ''));
      if (!retryable) break;
    }
    return { ok: false, error: last?.error || 'failed', detail: last?.detail, status: last?.status };
  } finally {
    clearTimeout(timer);
  }
}
