// KevCal, fully populated, without a key and without a single API call.
//
//   npm run demo
//
// Reading is served from a recorded answer instead of a model, so you can click
// through every screen — the review, the flags, the editor, the provenance
// overlay, sharing, undo — for free, as many times as you like.
//
// It writes to a throwaway directory, so your real imports are never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.KEVCAL_PORT || 4322);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'kevcal-demo');
const FIXTURE = path.join(DATA, 'reading.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const NOW = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const soon = (days) => {
  const t = new Date(Date.now() + days * 86400000);
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

// Dates are relative to today so the demo never goes stale, and the set is
// chosen to show every state KevCal has: clean, assumed, contradicted, unknown.
const DOCUMENTS = [
  {
    file: 'school-letter.png',
    reading: {
      document_title: 'Netherfield Primary — autumn newsletter',
      document_date: soon(-3),
      items: [
        { title: "Parents' evening", kind: 'event', start_date: soon(24), has_explicit_year: true,
          start_time: '16:30', end_time: '19:30', am_pm_stated: true, location: 'School hall',
          confidence: 0.96, source_quote: "Parents' evening, 4.30pm to 7.30pm, school hall",
          box_2d: [300, 60, 340, 900] },
        { title: 'Trip payment', kind: 'deadline', start_date: soon(9), has_explicit_year: false,
          am_pm_stated: true, cost: '£24.50', confidence: 0.93, box_2d: [370, 60, 410, 900],
          source_quote: 'Trip payment of £24.50 must be returned by then' },
        { title: 'Choir practice', kind: 'event', start_date: soon(4), has_explicit_year: false,
          am_pm_stated: false, start_time: '03:30', repeats_hint: 'every Wednesday',
          confidence: 0.7, source_quote: 'Choir practice every Wednesday at 3.30',
          box_2d: [650, 60, 690, 720] },
        { title: 'Swimming starts', kind: 'event', start_date: null, relative_phrase: 'after half term',
          relative_kind: 'other', has_explicit_year: false, am_pm_stated: true, confidence: 0.55,
          source_quote: 'Swimming lessons start after half term', box_2d: [510, 60, 550, 800],
          unresolved: 'The letter does not say when half term ends. Which week?' },
        { title: 'Book fair', kind: 'event', start_date: soon(40), end_date: soon(44),
          has_explicit_year: false, am_pm_stated: true, confidence: 0.9,
          source_quote: 'Book fair, all week', box_2d: [580, 60, 620, 640] },
      ],
    },
  },
  {
    file: 'car-reminder.png',
    reading: {
      document_title: 'Car — renewal reminders',
      items: [
        { title: 'MOT due', kind: 'deadline', start_date: soon(13), has_explicit_year: true,
          am_pm_stated: true, confidence: 0.95, source_quote: 'MOT expires', box_2d: [200, 80, 240, 800] },
        { title: 'Insurance renewal', kind: 'deadline', start_date: soon(60), has_explicit_year: true,
          am_pm_stated: true, cost: '£412', confidence: 0.94,
          source_quote: 'Insurance renews — £412', box_2d: [280, 80, 320, 800] },
      ],
    },
  },
  {
    file: 'poster.png',
    reading: {
      document_title: 'Autumn lecture',
      items: [
        { title: 'Talk: the deep sea', kind: 'event', start_date: soon(6), has_explicit_year: true,
          start_time: '18:30', end_time: '20:00', am_pm_stated: true, location: 'Corn Exchange',
          confidence: 0.97, source_quote: '6.30pm–8pm, Corn Exchange', box_2d: [600, 100, 660, 900] },
      ],
    },
  },
];

fs.writeFileSync(FIXTURE, JSON.stringify(DOCUMENTS[0].reading));

const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  env: {
    ...process.env,
    KEVCAL_PORT: String(PORT),
    KEVCAL_DATA: DATA,
    KEVCAL_FAKE_READER: FIXTURE,
    // Nothing can escape to a provider even if keys are sitting in .env.
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    KEVCAL_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let banner = '';
server.stdout.on('data', (chunk) => { banner += chunk; });

const stop = () => { server.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

if (!await waitForServer()) {
  console.error('\n  The demo server did not start.\n' + banner);
  server.kill();
  process.exit(1);
}

let added = 0;
for (const doc of DOCUMENTS) {
  fs.writeFileSync(FIXTURE, JSON.stringify(doc.reading));
  const image = fs.readFileSync(path.join(ROOT, 'samples', doc.file)).toString('base64');
  const res = await fetch(`${BASE}/api/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'image', filename: doc.file, data: image, now: NOW, tz: TZ }),
  });
  const body = await res.json();
  if (body.error) { console.error(`  could not seed ${doc.file}: ${body.error}`); continue; }
  added += body.items.length;
  // The car and the poster are already agreed; the school letter is left in
  // review so there is something to actually do when you open it.
  if (doc.file !== 'school-letter.png') {
    await fetch(`${BASE}/api/batches/${body.batch.id}/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  }
}

// No key is set, so a fixture reading cannot cost anything — keep it honest.
fs.rmSync(FIXTURE, { force: true });

console.log('');
console.log('  KevCal — demo');
console.log('  ─────────────');
console.log(`  Open           ${BASE}`);
console.log(`  Seeded         ${added} dates across ${DOCUMENTS.length} imports`);
console.log('  Reading        a recorded answer — no key used, nothing uploaded, nothing charged');
console.log(`  Data           ${DATA}  (thrown away next run)`);
console.log('');
console.log('  Worth a look:  Imports → the newsletter is still in review.');
console.log('                 One date needs an answer, one is worth a check.');
console.log('                 Tap any date to see where on the page it came from.');
console.log('');
console.log('  Ctrl-C to stop.');
console.log('');
