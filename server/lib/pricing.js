// What a page costs to read.
//
// A static table, checked against both providers' published list prices on
// 2026-09-11. Nothing here is fetched at runtime: a spend guard that depends on
// a network call is a spend guard that fails open the day the network hiccups.
//
// Every figure is an ESTIMATE and the app says so wherever it shows one. It
// exists to stop a runaway bill, not to reconcile an invoice.

const MTOK = (input, output) => ({ in: input, out: output });

const PER_MTOK = {
  // Google — Flash tier. Google has published a step-up from 1 January 2027.
  'gemini-3.8-flash': { ...MTOK(0.75, 3.75), from2027: MTOK(1.50, 7.50) },
  'gemini-3.6-flash': { ...MTOK(0.75, 3.75), from2027: MTOK(1.50, 7.50) },
  'gemini-3.5-flash': { ...MTOK(0.75, 3.75), from2027: MTOK(1.50, 7.50) },
  'gemini-3-flash':   { ...MTOK(0.75, 3.75), from2027: MTOK(1.50, 7.50) },
  'gemini-2.5-flash': MTOK(0.30, 2.50),

  // OpenAI — short-context standard rates. Long context is roughly double, and
  // KevCal's calls are nowhere near it.
  'gpt-6-astra':  MTOK(10.00, 50.00),
  'gpt-5.6-sol':  MTOK(4.00, 20.00),
  'gpt-5.6-terra': MTOK(2.00, 12.00),
  'gpt-5.6-luna': MTOK(0.20, 1.20),
};

// Deliberately dearer than the dearest model listed, so an unrecognised name
// over-estimates. A rename upstream should make the cap too cautious, never
// silently useless.
const UNKNOWN = MTOK(12.00, 60.00);

/**
 * A typical KevCal call, MEASURED rather than guessed: a dense school letter
 * read by gpt-5.6-terra came to 4,578 tokens in and 1,996 out. The first guess
 * here was 2,500/700, which under-counted spend by about two and a half times —
 * and a budget that under-counts is a budget that overshoots.
 *
 * A poster costs less than this; a multi-page PDF costs more.
 */
export const TYPICAL_CALL = { in: 5000, out: 2000 };

export const PRICES_CHECKED = '2026-09-11';

export function priceOf(model, when = new Date()) {
  if (!model) return UNKNOWN;
  const key = String(model).toLowerCase();
  const exact = PER_MTOK[key]
    // A dated or versioned name ("gemini-3.8-flash-002") prices as its family.
    ?? PER_MTOK[Object.keys(PER_MTOK).find((k) => key.startsWith(k)) ?? ''];
  if (!exact) return UNKNOWN;
  if (exact.from2027 && when.getFullYear() >= 2027) return exact.from2027;
  return { in: exact.in, out: exact.out };
}

export function estimateCost(model, inTokens, outTokens, when = new Date()) {
  const p = priceOf(model, when);
  return ((Number(inTokens) || 0) / 1e6) * p.in + ((Number(outTokens) || 0) / 1e6) * p.out;
}

export function isKnownModel(model) {
  const p = priceOf(model);
  return !(p.in === UNKNOWN.in && p.out === UNKNOWN.out);
}

/** What one page costs on each model, for the price list in Settings. */
export function priceList(when = new Date()) {
  return Object.keys(PER_MTOK).map((model) => {
    const p = priceOf(model, when);
    return {
      model,
      provider: model.startsWith('gemini') ? 'Gemini' : 'OpenAI',
      in: p.in,
      out: p.out,
      per_page: estimateCost(model, TYPICAL_CALL.in, TYPICAL_CALL.out, when),
    };
  }).sort((a, b) => a.per_page - b.per_page);
}

export function formatUSD(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.005) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/** Providers name their token counts differently; take whichever is present. */
export function tokensFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = usage[k] ?? usage[k.replace(/_/g, '')] ?? null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const input = pick('input_tokens', 'prompt_tokens', 'prompt_token_count');
  const output = pick('output_tokens', 'completion_tokens', 'candidates_token_count');
  return input == null && output == null ? null : { in: input ?? 0, out: output ?? 0 };
}
