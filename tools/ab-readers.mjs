// Run one document through both readers and show where they disagree.
//
// The general benchmarks say nothing useful about the only question that
// matters here — which model reads YOUR folded, badly-lit school letter
// correctly — so this settles it on your own documents instead of arguing it
// from someone else's leaderboard.
//
// It compares the CHECKED output, not the raw model answers, because that is
// what would actually reach your calendar. It deliberately does not attach the
// on-device OCR geometry, so the boxes reported are each model's own.
//
//   npm run ab -- samples/school-letter.png
//   npm run ab -- --text "Parents evening Thursday 12 March at 4.30"
//   npm run ab -- samples/term.pdf --now 2026-09-10T00:20 --json out.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/lib/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const { verifyItems } = await import('../server/extract/verify.js');
const { diffItems, fieldChanges } = await import('../server/lib/diff.js');
const gemini = await import('../server/extract/gemini.js');
const openai = await import('../server/extract/openai.js');

// ─────────────────────────────────────────────────────────── presentation

const PLAIN = process.env.NO_COLOR || !process.stdout.isTTY;
const c = (code) => (s) => (PLAIN ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const bold = c('1'), dim = c('2'), red = c('31'), green = c('32');
const amber = c('33'), blue = c('34'), cyan = c('36');

const rule = (label = '') => console.log(
  dim('─'.repeat(4)) + (label ? ` ${bold(label)} ` : '') + dim('─'.repeat(Math.max(0, 68 - label.length))),
);

const pad = (s, n) => String(s ?? '').padEnd(n);
const NAMES = { gemini: 'Gemini', openai: 'OpenAI' };

// ─────────────────────────────────────────────────────────── arguments

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : null;
};
const target = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--now'
  && argv[argv.indexOf(a) - 1] !== '--text' && argv[argv.indexOf(a) - 1] !== '--json');

const textInput = flag('text');
const jsonOut = flag('json');

if (!target && !textInput) {
  console.log(`
  ${bold('Compare the two readers on one of your own documents.')}

    npm run ab -- <file>              an image or a PDF
    npm run ab -- --text "..."        a block of text

  ${dim('Options')}
    --now 2026-09-10T00:20            pretend it is this moment (tests the midnight rule)
    --json out.json                   write both full answers to a file
`);
  process.exit(target === undefined && !textInput ? 0 : 1);
}

/** The clock the checker reasons against — same shape the server builds. */
function clock(raw) {
  const m = String(raw || '').match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (m) return { date: m[1], time: m[2] || '12:00', hour: m[2] ? Number(m[2].slice(0, 2)) : 12 };
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    hour: d.getHours(),
  };
}

const now = clock(flag('now'));
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ─────────────────────────────────────────────────────────── input

let input;
if (textInput && textInput !== true) {
  input = { text: String(textInput) };
} else {
  const file = path.resolve(target);
  if (!fs.existsSync(file)) { console.error(red(`No such file: ${file}`)); process.exit(1); }
  const isPdf = /\.pdf$/i.test(file);
  input = { base64: fs.readFileSync(file).toString('base64'), filename: path.basename(file), isPdf };
}

const READERS = [['gemini', gemini], ['openai', openai]];
const missing = READERS.filter(([, m]) => !m.available()).map(([n]) => n);
if (missing.length === 2) {
  console.error(red('\n  Neither GEMINI_API_KEY nor OPENAI_API_KEY is set — nothing to compare.\n'));
  process.exit(1);
}
if (missing.length === 1) {
  console.error(amber(`\n  Only one reader has a key (${missing[0]} is missing), so there is nothing to compare against.`));
  console.error(dim(`  Put ${missing[0].toUpperCase()}_API_KEY in .env and run this again.\n`));
  process.exit(1);
}

// ─────────────────────────────────────────────────────────── run both

console.log('');
console.log(`  ${bold('Document')}  ${textInput && textInput !== true ? dim('(pasted text)') : target}`);
console.log(`  ${bold('Clock')}     ${now.date} ${now.time}  ${dim(tz)}`);
console.log('');

/** Token counts sit under different names per provider; take whatever is there. */
function tokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = usage[k] ?? usage[k.replace(/_/g, '')] ?? null;
      if (typeof v === 'number') return v;
    }
    return null;
  };
  const inp = pick('input_tokens', 'prompt_tokens', 'prompt_token_count');
  const out = pick('output_tokens', 'completion_tokens', 'candidates_token_count');
  return inp || out ? { in: inp, out } : null;
}

const runs = await Promise.all(READERS.map(async ([name, mod]) => {
  const started = Date.now();
  let raw;
  try { raw = await mod.read(input); }
  catch (e) { raw = { ok: false, error: 'threw', detail: e.message }; }
  const ms = Date.now() - started;
  if (!raw.ok) return { name, ok: false, ms, error: raw.error, detail: raw.detail };

  const ctx = {
    now, tz,
    documentDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.doc?.document_date || '') ? raw.doc.document_date : null,
    documentSpan: raw.doc?.document_span || null,
  };
  // Fingerprint-free: the diff matches on title and date, which is what we want
  // to compare anyway.
  const items = verifyItems(raw.items || [], ctx).map((i, n) => ({ ...i, fingerprint: `${name}-${n}` }));
  return { name, ok: true, ms, model: raw.model, doc: raw.doc, rawItems: raw.items || [], items, usage: tokens(raw.usage) };
}));

for (const r of runs) {
  const label = pad(NAMES[r.name], 8);
  if (!r.ok) {
    console.log(`  ${red('✗')} ${label} ${red(r.error)} ${dim(String(r.detail || '').slice(0, 70))}`);
    continue;
  }
  const boxed = r.rawItems.filter((i) => Array.isArray(i.box_2d) && i.box_2d.length === 4).length;
  const blockers = r.items.filter((i) => i.blocked).length;
  const checks = r.items.filter((i) => !i.blocked && (i.flags || []).length).length;
  console.log(
    `  ${green('✓')} ${label} ${pad(r.model, 18)} ${pad(`${r.items.length} items`, 10)}` +
    `${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)}` +
    `${pad(r.usage ? `${r.usage.in ?? '?'} in / ${r.usage.out ?? '?'} out` : 'tokens n/a', 22)}` +
    dim(`${boxed}/${r.rawItems.length} boxed`),
  );
  if (r.doc?.document_date) console.log(dim(`      ${pad('', 8)} document dates itself: ${r.doc.document_date}`));
  if (blockers || checks) {
    console.log(dim(`      ${pad('', 8)} flags: ${blockers} blocker${blockers === 1 ? '' : 's'}, ${checks} check${checks === 1 ? '' : 's'}`));
  }
}
console.log('');

const [g, o] = runs;
if (!g.ok || !o.ok) {
  console.log(amber('  One reader failed, so there is nothing to compare. Fix that and re-run.\n'));
  process.exit(1);
}

// ─────────────────────────────────────────────────────────── compare

const when = (i) => [i.start_date || '(no date)', i.start_time].filter(Boolean).join(' ');
const flagsOf = (i) => (i.flags || []).map((f) => f.code).join(', ');

const d = diffItems(g.items, o.items);
const agreed = d.unchanged;
const differing = [...d.changed, ...d.conflicts];
const onlyGemini = d.removed;
const onlyOpenai = d.added;

rule('BOTH READ IT THE SAME');
if (!agreed.length) console.log(dim('  nothing\n'));
for (const { before } of agreed) {
  console.log(`  ${green('=')} ${pad(before.title.slice(0, 34), 36)} ${cyan(when(before))}` +
    (flagsOf(before) ? dim(`   [${flagsOf(before)}]`) : ''));
}
console.log('');

rule('THEY DISAGREE — LOOK HERE FIRST');
if (!differing.length) console.log(dim('  nothing\n'));
for (const { before, after } of differing) {
  console.log(`  ${amber('≠')} ${bold(before.title)}`);
  for (const ch of fieldChanges(before, after)) {
    console.log(`      ${pad(ch.field, 12)} ${blue('gemini')} ${pad(ch.from ?? '—', 24)} ${blue('openai')} ${ch.to ?? '—'}`);
  }
  if (before.src_raw !== after.src_raw) {
    console.log(dim(`      quoted by gemini: "${String(before.src_raw || '').slice(0, 90)}"`));
    console.log(dim(`      quoted by openai: "${String(after.src_raw || '').slice(0, 90)}"`));
  }
  console.log('');
}

const onlyOne = (label, rows) => {
  rule(label);
  if (!rows.length) { console.log(dim('  nothing\n')); return; }
  for (const i of rows) {
    console.log(`  ${red('•')} ${pad(i.title.slice(0, 34), 36)} ${cyan(when(i))}` +
      (flagsOf(i) ? dim(`   [${flagsOf(i)}]`) : ''));
    if (i.src_raw) console.log(dim(`      from: "${String(i.src_raw).slice(0, 90)}"`));
  }
  console.log('');
};
onlyOne('ONLY GEMINI FOUND', onlyGemini);
onlyOne('ONLY OPENAI FOUND', onlyOpenai);

// ─────────────────────────────────────────────────────────── verdict

rule('READ THIS');
const total = agreed.length + differing.length + onlyGemini.length + onlyOpenai.length;
console.log(`  ${agreed.length}/${total} agreed outright.`);
if (differing.length) {
  console.log(`  ${amber(`${differing.length} disagree`)} — open the document and see which one is right. That is the answer.`);
}
if (onlyGemini.length || onlyOpenai.length) {
  console.log(`  ${onlyGemini.length} found only by Gemini, ${onlyOpenai.length} only by OpenAI. Check whether the misses are real dates.`);
}
if (!differing.length && !onlyGemini.length && !onlyOpenai.length) {
  console.log(`  ${green('Identical.')} On this document either reader will do — pick on price.`);
}
const gBoxed = g.rawItems.filter((i) => Array.isArray(i.box_2d)).length;
const oBoxed = o.rawItems.filter((i) => Array.isArray(i.box_2d)).length;
console.log(dim(`  Boxes: gemini ${gBoxed}/${g.rawItems.length}, openai ${oBoxed}/${o.rawItems.length}. ` +
  'On this Mac the on-device OCR supplies these anyway, so it only matters if you move KevCal off macOS.'));
console.log('');

if (jsonOut && jsonOut !== true) {
  fs.writeFileSync(jsonOut, JSON.stringify({ now, tz, runs }, null, 2));
  console.log(dim(`  Full answers written to ${jsonOut}\n`));
}
