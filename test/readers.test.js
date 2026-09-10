// The two readers, checked without spending a penny or needing a key.
//
// The request body is the one part of KevCal that cannot be verified by running
// it — a malformed body just comes back as an HTTP 400 at the worst possible
// moment, on a real document, on a phone, in a corridor. So `fetch` is stubbed
// and the exact bytes each reader would send are inspected here.

import { SCHEMA, toStrict, redactSecrets } from '../server/extract/contract.js';
import { estimateCost, priceOf, tokensFrom, TYPICAL_CALL } from '../server/lib/pricing.js';

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name} ${detail}`); }
};
const group = (n) => console.log(`\n${n}`);

const realFetch = globalThis.fetch;
let sent = null;

/** Capture the request instead of making it, and reply with a canned answer. */
function stubFetch(reply) {
  globalThis.fetch = async (url, opts) => {
    sent = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
}

const ANSWER = {
  document_title: 'Newsletter',
  document_date: '2026-09-07',
  items: [{
    title: 'Sports day', kind: 'event', start_date: '2027-06-01',
    has_explicit_year: true, am_pm_stated: true, confidence: 0.9,
    source_quote: 'Sports day 1 June 2027', box_2d: [100, 200, 300, 600],
  }],
};

const IMAGE = { base64: 'QUJD', filename: 'letter.jpg', isPdf: false };
const PDF = { base64: 'QUJD', filename: 'term.pdf', isPdf: true };

// ─────────────────────────────────────────────── the shared contract

group('the schema OpenAI strict mode requires');
{
  const strict = toStrict(SCHEMA);
  const objects = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object' && n.properties) objects.push(n);
    Object.values(n).forEach(walk);
  };
  walk(strict);
  check('every object forbids extra properties', objects.length >= 2 && objects.every((o) => o.additionalProperties === false),
    `${objects.length} objects`);
  check('every property is listed as required', objects.every((o) =>
    Object.keys(o.properties).every((k) => o.required.includes(k))));
  check('optionality survives as a null union',
    strict.properties.items.items.properties.start_date.type.includes('null'));
  check('the lenient schema is left alone', SCHEMA.required.length === 1 && !SCHEMA.additionalProperties,
    JSON.stringify(SCHEMA.required));
}

group('a key never reaches the user, whatever the provider says back');
{
  process.env.OPENAI_API_KEY = 'sk-proj-SUPERSECRETVALUE123';
  const real = redactSecrets('Incorrect API key provided: sk-proj-SUPERSECRETVALUE123. Check your keys.');
  check('the live key is stripped verbatim', !real.includes('SUPERSECRETVALUE123'), real);
  check('and the rest of the message survives', /Incorrect API key provided/.test(real) && /Check your keys/.test(real), real);

  check('an OpenAI-shaped key it has never seen is stripped',
    !redactSecrets('bad key sk-abc123def456ghi').includes('sk-abc123def456ghi'));
  check('a Google-shaped key is stripped',
    !redactSecrets('key AIzaSyC7xQ_notarealkey12345').includes('AIzaSyC7xQ_notarealkey12345'));
  check('a bearer header is stripped',
    !redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9').includes('eyJhbGciOiJIUzI1NiJ9'));
  check('ordinary error text is left alone',
    redactSecrets('model not found: gemini-9-flash') === 'model not found: gemini-9-flash');
  check('empty input is safe', redactSecrets(null) === '' && redactSecrets(undefined) === '');
}

// ─────────────────────────────────────────────── OpenAI

group('OpenAI reader');
{
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.KEVCAL_FAKE_READER;
  const openai = await import('../server/extract/openai.js');

  stubFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ANSWER) }] }] });
  const res = await openai.read(IMAGE);

  check('posts to the Responses API', sent.url === 'https://api.openai.com/v1/responses', sent.url);
  check('authenticates with a bearer token', sent.opts.headers.authorization === 'Bearer sk-test');
  check('sends the system prompt as instructions', /You are the READER/.test(sent.body.instructions));
  check('asks for a strict json_schema', sent.body.text.format.type === 'json_schema' && sent.body.text.format.strict === true);
  check('names the schema', typeof sent.body.text.format.name === 'string' && sent.body.text.format.name.length > 0);
  check('the schema it sends is the strict one',
    sent.body.text.format.schema.additionalProperties === false);

  const parts = sent.body.input[0].content;
  const img = parts.find((p) => p.type === 'input_image');
  check('an image goes as a data URL', img?.image_url === 'data:image/jpeg;base64,QUJD', img?.image_url);
  check('at high detail, because fine print is the point', img?.detail === 'high');
  check('and the ask follows the picture', parts.at(-1).type === 'input_text');

  check('the answer is unwrapped from output[].content[]', res.ok && res.items.length === 1, JSON.stringify(res).slice(0, 120));
  check('the document date comes through', res.doc.document_date === '2026-09-07');
  check('the model that answered is reported', typeof res.model === 'string' && res.model.length > 0, res.model);

  await openai.read(PDF);
  const file = sent.body.input[0].content.find((p) => p.type === 'input_file');
  check('a PDF goes as input_file with its name', file?.filename === 'term.pdf');
  check('and a data URL of its own type', file?.file_data === 'data:application/pdf;base64,QUJD');

  // The 401 that quotes your key back at you, which is shown in the app.
  process.env.OPENAI_API_KEY = 'sk-proj-LIVEKEY9876543210';
  globalThis.fetch = async () => ({
    ok: false, status: 401,
    text: async () => 'Incorrect API key provided: sk-proj-LIVEKEY9876543210 (also seen: sk-test). Check your keys.',
  });
  const unauthorised = await openai.read(IMAGE);
  check('a 401 that echoes the live key is redacted before it can be displayed',
    !unauthorised.detail.includes('LIVEKEY9876543210'), unauthorised.detail);
  check('and a short key-shaped token in the same body goes too',
    !unauthorised.detail.includes('sk-test'), unauthorised.detail);
  check('the reason still reaches the user', /Incorrect API key provided/.test(unauthorised.detail), unauthorised.detail);
  process.env.OPENAI_API_KEY = 'sk-test';

  stubFetch({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] });
  const refused = await openai.read(IMAGE);
  check('a refusal is an error, not an empty page', !refused.ok && refused.error === 'refusal');

  stubFetch({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
  const cut = await openai.read(IMAGE);
  check('a truncated answer is refused rather than half-read', !cut.ok && cut.error === 'incomplete');
}

// ─────────────────────────────────────────────── Gemini

group('Gemini reader');
{
  process.env.GEMINI_API_KEY = 'g-test';
  const gemini = await import('../server/extract/gemini.js');

  stubFetch({ output_text: JSON.stringify(ANSWER) });
  const res = await gemini.read(IMAGE);

  check('posts to the interactions API', /generativelanguage\.googleapis\.com\/v1beta\/interactions$/.test(sent.url), sent.url);
  check('authenticates with the api-key header', sent.opts.headers['x-goog-api-key'] === 'g-test');
  check('sends the same system prompt', /You are the READER/.test(sent.body.system_instruction));
  check('asks for JSON against the schema',
    sent.body.response_format.mime_type === 'application/json' && !!sent.body.response_format.schema);
  check('runs at temperature 0', sent.body.generation_config.temperature === 0);

  const img = sent.body.input.find((p) => p.type === 'image');
  check('an image goes as raw base64 plus a mime type',
    img?.data === 'QUJD' && img?.mime_type === 'image/jpeg', JSON.stringify(img));

  check('the answer comes through identically', res.ok && res.items[0].title === 'Sports day');
  check('and the doc block matches OpenAI\'s', res.doc.document_title === 'Newsletter');

  await gemini.read(PDF);
  check('a PDF goes as a document part',
    sent.body.input.find((p) => p.type === 'document')?.mime_type === 'application/pdf');

  // Thought blocks are reasoning, not the answer; letting one through would
  // put prose in front of the JSON.
  stubFetch({ steps: [
    { type: 'thought', text: 'Let me think about this…' },
    { type: 'message', content: [{ text: JSON.stringify(ANSWER) }] },
  ] });
  const thoughtful = await gemini.read(IMAGE);
  check('reasoning blocks are skipped when reading the answer',
    thoughtful.ok && thoughtful.items.length === 1, thoughtful.error || '');
}

group('pricing a page');
{
  check('a known model prices from its published rate',
    Math.abs(estimateCost('gemini-2.5-flash', 1e6, 0) - 0.30) < 1e-9,
    String(estimateCost('gemini-2.5-flash', 1e6, 0)));
  check('input and output are priced separately',
    Math.abs(estimateCost('gemini-2.5-flash', 1e6, 1e6) - 2.80) < 1e-9);
  check('a dated variant prices as its family',
    priceOf('gemini-3.8-flash-002').in === priceOf('gemini-3.8-flash').in);
  check('an unknown model is priced ABOVE every known one, never below',
    Object.keys({ a: 1 }) && priceOf('gemini-99-turbo').in > priceOf('gpt-6-astra').in,
    `${priceOf('gemini-99-turbo').in} vs ${priceOf('gpt-6-astra').in}`);
  check('zero tokens cost nothing', estimateCost('gemini-2.5-flash', 0, 0) === 0);

  check('OpenAI token counts are read', tokensFrom({ input_tokens: 10, output_tokens: 2 }).in === 10);
  check('Gemini token counts are read', tokensFrom({ prompt_token_count: 7, candidates_token_count: 3 }).out === 3);
  check('no usage at all reads as null, so it can be charged as typical',
    tokensFrom(null) === null && tokensFrom({}) === null);
  check('a typical call is a sane size', TYPICAL_CALL.in > 500 && TYPICAL_CALL.in < 20000);
}

// ─────────────────────────────────────────────── the selector

group('picking a reader');
{
  const fresh = async () => {
    const mod = await import(`../server/extract/reader.js?v=${Math.random()}`);
    return mod;
  };

  process.env.GEMINI_API_KEY = 'g';
  process.env.OPENAI_API_KEY = 'o';
  delete process.env.KEVCAL_READER;
  let r = await fresh();
  check('with both keys, Gemini leads (it draws the boxes)', r.readerName() === 'gemini', r.readerName());

  process.env.KEVCAL_READER = 'openai';
  r = await fresh();
  check('KEVCAL_READER overrides that', r.readerName() === 'openai', r.readerName());

  delete process.env.KEVCAL_READER;
  delete process.env.GEMINI_API_KEY;
  r = await fresh();
  check('with only an OpenAI key it picks OpenAI', r.readerName() === 'openai', r.readerName());

  delete process.env.OPENAI_API_KEY;
  r = await fresh();
  check('with no key at all there is no reader', r.readerName() === 'none' && r.readerAvailable() === false);

  process.env.KEVCAL_FAKE_READER = '/nonexistent.json';
  r = await fresh();
  check('a fixture stands in for one', r.readerName() === 'fixture' && r.readerAvailable() === true);
  const failed = await r.readDocument({ text: 'x' });
  check('and a missing fixture fails loudly rather than inventing', !failed.ok);
  delete process.env.KEVCAL_FAKE_READER;
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
