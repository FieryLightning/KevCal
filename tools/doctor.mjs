// Is this machine set up to run KevCal safely?
//
// Deployment failures are almost never code. They are a token nobody set, a
// server whose clock is in UTC while its owner is not, a key with no ceiling,
// or a reverse proxy the app does not know is there. This checks for those and
// says which ones actually matter.
//
//   npm run doctor
//
// Exits non-zero if anything is dangerous, so it can gate a deploy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/lib/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const { priceOf, estimateCost, TYPICAL_CALL, formatUSD } = await import('../server/lib/pricing.js');

const PLAIN = process.env.NO_COLOR || !process.stdout.isTTY;
const paint = (code) => (s) => (PLAIN ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const bold = paint('1'), dim = paint('2'), red = paint('31'), green = paint('32'), amber = paint('33');

let problems = 0, warnings = 0;
const ok = (msg, detail) => console.log(`  ${green('✓')} ${msg}${detail ? dim(`  ${detail}`) : ''}`);
const warn = (msg, fix) => { warnings++; console.log(`  ${amber('!')} ${msg}`); if (fix) console.log(`      ${dim(fix)}`); };
const bad = (msg, fix) => { problems++; console.log(`  ${red('✗')} ${msg}`); if (fix) console.log(`      ${dim(fix)}`); };
const section = (t) => console.log(`\n${bold(t)}`);

const env = (k) => {
  const v = process.env[k];
  return v === undefined || v === '' ? null : v;
};
const truthy = (k) => ['1', 'true', 'yes'].includes(String(env(k) || '').toLowerCase());

console.log(`\n${bold('KevCal — deployment check')}`);
console.log(dim(`  ${os.type()} ${os.release()} · node ${process.version} · ${ROOT}`));

// ─────────────────────────────────────────────────────────── runtime

section('Runtime');
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old — node:sqlite needs 22.5 or newer.`, 'Install a newer Node.');

  const onMac = process.platform === 'darwin';
  const ocr = fs.existsSync(path.join(ROOT, 'bin', 'kevcal-ocr'));
  if (ocr) ok('On-device reader built', 'cross-check + offline fallback available');
  else if (onMac) warn('On-device reader not built, so there is no cross-check and no offline fallback.', 'npm run build:tools');
  else ok('No on-device reader', 'expected off macOS — the reader is the only way in, so keep a key working');
}

// ─────────────────────────────────────────────────────────── reading

section('Reading');
let activeModel = null;
{
  const gem = env('GEMINI_API_KEY');
  const oai = env('OPENAI_API_KEY');
  const forced = String(env('KEVCAL_READER') || '').toLowerCase();

  if (!gem && !oai) {
    warn('No reading key, so KevCal falls back to reading on this machine.',
      process.platform === 'darwin'
        ? 'Worse on real documents. Put GEMINI_API_KEY or OPENAI_API_KEY in .env.'
        : 'On this platform that fallback does not exist — imports of photos will find nothing.');
  } else {
    const chosen = forced && ['gemini', 'openai'].includes(forced)
      ? forced
      : (gem ? 'gemini' : 'openai');
    if (forced && !['gemini', 'openai'].includes(forced)) {
      bad(`KEVCAL_READER="${forced}" is not a reader KevCal knows.`, 'Use gemini or openai, or leave it unset.');
    }
    if (chosen === 'gemini' && !gem) bad('KEVCAL_READER=gemini but GEMINI_API_KEY is empty.');
    if (chosen === 'openai' && !oai) bad('KEVCAL_READER=openai but OPENAI_API_KEY is empty.');

    activeModel = chosen === 'gemini'
      ? (env('GEMINI_MODEL') || 'gemini-3.8-flash')
      : (env('OPENAI_MODEL') || 'gpt-5.6-terra');
    const perPage = estimateCost(activeModel, TYPICAL_CALL.in, TYPICAL_CALL.out);
    ok(`Reading with ${chosen}`, `${activeModel} · about ${formatUSD(perPage)} a page`);
    if (gem && oai) console.log(dim(`      Both keys present; ${chosen} wins. Set KEVCAL_READER to change that.`));

    const known = priceOf(activeModel).in < 12;
    if (!known) warn(`No published price on file for "${activeModel}", so spend is over-estimated.`,
      'Harmless — the cap just trips early. Update server/lib/pricing.js if you care.');
    if (chosen === 'gemini') {
      console.log(dim('      Free-tier Gemini trains on what you send and may put it before a human'));
      console.log(dim('      reviewer. Attach billing for the paid terms before sending real post.'));
    }
  }
}

// ─────────────────────────────────────────────────────────── money

section('Money');
{
  const budget = env('KEVCAL_MONTHLY_BUDGET');
  if (!budget) {
    warn('No KEVCAL_MONTHLY_BUDGET, so KevCal will keep reading however much you import.',
      'A cap set in .env cannot be raised from the browser. Also set one at the provider.');
  } else if (!Number.isFinite(Number(budget)) || Number(budget) <= 0) {
    bad(`KEVCAL_MONTHLY_BUDGET="${budget}" is not a positive number of dollars.`);
  } else {
    const perPage = activeModel ? estimateCost(activeModel, TYPICAL_CALL.in, TYPICAL_CALL.out) : 0;
    const pages = perPage > 0 ? Math.floor(Number(budget) / perPage) : null;
    ok(`Capped at ${formatUSD(Number(budget))} a month`, pages ? `roughly ${pages.toLocaleString()} pages` : '');
  }
}

// ─────────────────────────────────────────────────────────── exposure

section('Exposure');
{
  const token = env('KEVCAL_TOKEN');
  const host = env('KEVCAL_HOST') || '0.0.0.0';
  const proxied = truthy('KEVCAL_TRUST_PROXY');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  if (token && token.length < 16) {
    bad(`KEVCAL_TOKEN is only ${token.length} characters — that is guessable.`,
      'openssl rand -base64 24');
  } else if (token) {
    ok('Locked with a token');
  } else if (loopback) {
    ok('No token, but bound to loopback only', 'nothing off this machine can reach it');
  } else {
    bad(`No KEVCAL_TOKEN and bound to ${host} — anything that can reach this host can read your imports.`,
      'echo "KEVCAL_TOKEN=$(openssl rand -base64 24)" >> .env');
  }

  if (proxied && loopback) ok('Behind a reverse proxy', 'forwarded client IP and scheme are trusted');
  else if (proxied && !loopback) {
    warn(`KEVCAL_TRUST_PROXY is on but KevCal is bound to ${host}.`,
      'Anything reaching it directly can forge its own IP. Bind KEVCAL_HOST=127.0.0.1.');
  } else if (loopback && !token) {
    // fine: nothing can reach it
  } else if (!proxied && !loopback) {
    console.log(dim('      Not behind a proxy, so the auth cookie will not be marked Secure.'));
  }
}

// ─────────────────────────────────────────────────────────── time and disk

section('Time and storage');
{
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  if (zone === 'UTC' || zone === 'Etc/UTC') {
    warn('This machine is on UTC.',
      'Exported times are anchored to the zone in Settings, so set that — or run with TZ=Europe/London.');
  } else ok(`Timezone ${zone}`);

  const dataDir = env('KEVCAL_DATA') || path.join(ROOT, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.doctor');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    const db = path.join(dataDir, 'kevcal.db');
    const size = fs.existsSync(db) ? `${(fs.statSync(db).size / 1024).toFixed(0)} KB` : 'not created yet';
    ok(`Data directory writable`, `${dataDir} · ${size}`);
  } catch (e) {
    bad(`Cannot write to the data directory: ${e.message}`, 'Check ownership of that path.');
  }

  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const mode = fs.statSync(envFile).mode & 0o777;
    if (mode & 0o077) bad(`.env is mode ${mode.toString(8)} — other accounts on this host can read your keys.`, 'chmod 600 .env');
    else ok('.env is readable only by you');
  } else {
    warn('No .env file.', 'cp .env.example .env');
  }
}

// ─────────────────────────────────────────────────────────── verdict

console.log('');
if (problems) {
  console.log(red(`  ${problems} thing${problems === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} to consider` : ''}.`));
  console.log('');
  process.exit(1);
}
console.log(warnings
  ? amber(`  Safe to run. ${warnings} thing${warnings === 1 ? '' : 's'} worth considering.`)
  : green('  All clear.'));
console.log('');
