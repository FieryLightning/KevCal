// Which reader is on duty.
//
// The reader is deliberately the most replaceable part of KevCal. Everything
// that decides whether a date is trustworthy lives in verify.js, and it works
// off the words the reader quoted rather than the reader's authority — so
// changing provider changes accuracy and cost, never the safety rules.
//
// Choose with KEVCAL_READER=gemini|openai, or just set one of the two keys.

import fs from 'node:fs';
import * as gemini from './gemini.js';
import * as openai from './openai.js';

const PROVIDERS = { gemini, openai };

/**
 * Gemini first when both keys are present: it returns a box round the phrase it
 * read, so the "where did this come from" overlay works even on a machine
 * without the on-device OCR. Set KEVCAL_READER to override.
 */
const PREFERENCE = ['gemini', 'openai'];

function chosen() {
  const forced = String(process.env.KEVCAL_READER || '').toLowerCase().trim();
  if (forced && PROVIDERS[forced]) return forced;
  return PREFERENCE.find((name) => PROVIDERS[name].available()) || null;
}

export function readerAvailable() {
  return Boolean(process.env.KEVCAL_FAKE_READER) || Boolean(chosen() && PROVIDERS[chosen()].available());
}

export function readerName() {
  if (process.env.KEVCAL_FAKE_READER) return 'fixture';
  return chosen() || 'none';
}

export function readerModel() {
  const name = chosen();
  return name ? PROVIDERS[name].model() : null;
}

/** Every reader KevCal knows how to use, and whether its key is present. */
export function readerOptions() {
  return Object.entries(PROVIDERS).map(([name, mod]) => ({
    name,
    available: mod.available(),
    model: mod.model(),
    active: name === chosen(),
  }));
}

/**
 * A recorded reader response, used by the tests.
 *
 * The checking rules are the part of KevCal most likely to be wrong and most
 * expensive to get wrong, and they sit downstream of a paid network call — which
 * would make them the least-tested code in the app. This hook lets the whole
 * pipeline run against a fixture instead, so every flag has an end-to-end test
 * that costs nothing and never flakes.
 */
function fakeRead() {
  try {
    const parsed = JSON.parse(fs.readFileSync(process.env.KEVCAL_FAKE_READER, 'utf8'));
    return {
      ok: true,
      model: 'fixture',
      doc: {
        document_date: parsed.document_date ?? null,
        document_span: parsed.document_span ?? null,
        document_title: parsed.document_title ?? null,
        document_kind: parsed.document_kind ?? null,
      },
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (e) {
    return { ok: false, error: 'fixture_unreadable', detail: e.message };
  }
}

/**
 * @param {{base64?:string, filename?:string, isPdf?:boolean, text?:string, timeoutMs?:number}} input
 * @returns {Promise<{ok:boolean, doc?:object, items?:object[], model?:string, error?:string, detail?:string}>}
 */
export async function readDocument(input) {
  if (process.env.KEVCAL_FAKE_READER) return fakeRead();
  const name = chosen();
  if (!name) return { ok: false, error: 'no_api_key' };
  return PROVIDERS[name].read(input);
}
