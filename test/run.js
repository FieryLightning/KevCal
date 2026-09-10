// End-to-end tests against a live server, using the sample documents.
// Run: npm test

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4455;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kevcal-test-'));

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name} ${detail}`); }
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

function captureImage(file, extra = {}) {
  const data = fs.readFileSync(path.join(ROOT, 'samples', file)).toString('base64');
  return api('/api/capture', { method: 'POST', body: { kind: 'image', filename: file, data, reference: '2025-09-03', ...extra } });
}

// The reader is a paid network call, so the tests drive it from a fixture file
// instead. Writing the file makes the next capture take the Gemini path with a
// known answer; deleting it drops back to the on-device grammar. One server,
// both engines, no key and no flakiness.
const FIXTURE = path.join(ROOT, 'test/fixtures/reader.json');
function reads(doc) { fs.mkdirSync(path.dirname(FIXTURE), { recursive: true }); fs.writeFileSync(FIXTURE, JSON.stringify(doc)); }
function readsNothing() { try { fs.unlinkSync(FIXTURE); } catch { /* already gone */ } }
readsNothing();

const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  env: {
    ...process.env,
    KEVCAL_PORT: String(PORT), KEVCAL_DATA: TMP_DATA, KEVCAL_HOST: '127.0.0.1',
    KEVCAL_FAKE_READER: FIXTURE,
    // Both cleared so a key in the developer's shell can never make the tests
    // reach the network or change which reader is reported.
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

async function waitForServer(ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

try {
  if (!await waitForServer()) throw new Error(`server did not start.\n${serverErr}`);

  console.log('\nhealth');
  const health = await api('/api/health');
  check('server healthy', health.data.ok === true);
  check('on-device OCR available', health.data.ocr === true, 'run npm run build:tools');
  check('a timezone is always resolved', !!(await api('/api/settings')).data.timezone);
  check('the reader in use is named', health.data.reader === 'fixture', health.data.reader);

  console.log('\ncapture: school letter (the flagship case)');
  const letter = await captureImage('school-letter.png');
  check('capture succeeded', letter.status === 200, letter.text.slice(0, 200));
  const items = letter.data.items || [];
  check('found several dates', items.length >= 7, `got ${items.length}`);
  check('nothing leaves the machine', letter.data.engine === 'vision+grammar', letter.data.engine);

  const parents = items.find((i) => /parents/i.test(i.title));
  check("parents' evening date correct", parents?.start_date === '2026-03-12', parents?.start_date);
  check("parents' evening time correct", parents?.start_time === '16:30', parents?.start_time);
  check('trip payment typed as a deadline',
    items.find((i) => /trip payment/i.test(i.title))?.kind === 'deadline');
  check('w/c resolved to the Monday',
    items.find((i) => /mock/i.test(i.title))?.start_date === '2025-11-17');
  check('half term captured as a range',
    items.find((i) => /half term/i.test(i.title))?.end_date === '2026-02-20');

  console.log('\nR1: recurrence is never invented');
  const club = items.find((i) => /homework club/i.test(i.title));
  check('recurring club has NO date guessed', club && club.start_date === null);
  check('recurring club is flagged for review', club?.needs_review === 1);
  check('recurring club records the hint, not a rule', !!club?.recurrence_suggestion);
  check('no item anywhere has an rrule', items.length > 0 && items.every((i) => !i.rrule));

  console.log('\nR3: provenance is present on every item');
  check('every item carries its source text', items.length > 0 && items.every((i) => i.src_raw));
  check('every item carries a bounding box', items.length > 0 && items.every((i) => i.src_bbox));
  check('an interpretation is recorded', items.length > 0 && items.every((i) => i.src_interpretation));

  console.log('\nR2/R4: review gating');
  // 'blocked' is the stronger form of 'high': something in here cannot be answered
  // by the machine at all, so the review is not merely advisable but compulsory.
  check('a bulky/uncertain import demands review',
    letter.data.risk === 'high' || letter.data.risk === 'blocked', letter.data.risk);
  const blocked = await api(`/api/batches/${letter.data.batch.id}/commit`, { method: 'POST' });
  check('commit blocked while an item needs review', blocked.status === 409, `got ${blocked.status}`);
  check('block names the offending item', (blocked.data.blocked || []).length >= 1);

  const fixed = await api(`/api/items/${club.id}`, { method: 'PATCH', body: { start_date: '2025-09-09' } });
  check('editing an item clears the block', fixed.status === 200);
  const committed = await api(`/api/batches/${letter.data.batch.id}/commit`, { method: 'POST' });
  check('commit now succeeds', committed.status === 200, committed.text.slice(0, 160));
  check('all items committed', committed.data.committed >= 8, String(committed.data.committed));

  console.log('\nR5: one-button undo of a whole import');
  const before = (await api('/api/agenda')).data.items.length;
  const undo = await api(`/api/batches/${letter.data.batch.id}/undo`, { method: 'POST' });
  check('undo removed the whole batch', undo.data.removed >= 8, String(undo.data.removed));
  const after = (await api('/api/agenda')).data.items.length;
  check('agenda is empty again', after === 0, `${before} -> ${after}`);
  await api(`/api/batches/${letter.data.batch.id}/redo`, { method: 'POST' });
  check('redo restores them', (await api('/api/agenda')).data.items.length === before);

  console.log('\nundo and redo are symmetric');
  const pair = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', reference: '2025-09-03',
    text: 'Book club on 3 October 2025\nPub quiz on 9 October 2025',
  } });
  const [keepIt, dropIt] = pair.data.items;
  await api('/api/items/bulk', { method: 'POST', body: { ids: [dropIt.id], op: 'reject' } });
  await api(`/api/batches/${pair.data.batch.id}/commit`, { method: 'POST' });
  await api(`/api/batches/${pair.data.batch.id}/undo`, { method: 'POST' });
  await api(`/api/batches/${pair.data.batch.id}/redo`, { method: 'POST' });
  const restored = (await api(`/api/batches/${pair.data.batch.id}`)).data.items;
  check('redo restores what undo took',
    restored.find((i) => i.id === keepIt.id)?.status === 'accepted');
  check('redo does NOT resurrect what the user rejected',
    restored.find((i) => i.id === dropIt.id)?.status === 'rejected',
    restored.find((i) => i.id === dropIt.id)?.status);
  await api(`/api/batches/${pair.data.batch.id}`, { method: 'DELETE' });

  console.log('\ndeleting a re-imported batch');
  const orig = await captureImage('car-reminder.png');
  const child = await captureImage('car-reminder.png', { parentBatchId: orig.data.batch.id });
  const delParent = await api(`/api/batches/${orig.data.batch.id}`, { method: 'DELETE' });
  check('a batch with a child deletes cleanly', delParent.status === 200, delParent.text.slice(0, 120));
  check('the child survives', (await api(`/api/batches/${child.data.batch.id}`)).status === 200);
  await api(`/api/batches/${child.data.batch.id}`, { method: 'DELETE' });

  console.log('\nfast path: a simple poster');
  const poster = await captureImage('poster.png');
  check('poster is low risk (three-tap path)', poster.data.risk === 'low', poster.data.risk);
  check('poster found the talk', poster.data.items.some((i) => i.start_date === '2025-10-15'));
  check('poster picked up its time range',
    poster.data.items.some((i) => i.start_time === '18:30' && i.end_time === '20:00'));
  const posterCommit = await api(`/api/batches/${poster.data.batch.id}/commit`, { method: 'POST' });
  check('low-risk batch commits with no review', posterCommit.status === 200);

  console.log('\nR11: relative dates resolve from an anchor found in the document');
  const term = await captureImage('term-dates.png');
  const appraisal = term.data.items.find((i) => /critical appraisal/i.test(i.title));
  check('"Wk 7 (Fri)" resolved', appraisal?.start_date === '2025-11-14', appraisal?.start_date);
  check('reading week was skipped in the count', appraisal?.start_date === '2025-11-14');
  check('the resolution is explained to the user', /week 1/i.test(appraisal?.src_interpretation || ''));

  console.log('\ncar reminder (deadline ladder)');
  const car = await captureImage('car-reminder.png');
  check('MOT expiry found', car.data.items.some((i) => i.start_date === '2026-08-14'));
  check('all three treated as deadlines', car.data.items.every((i) => i.kind === 'deadline'));
  await api(`/api/batches/${car.data.batch.id}/commit`, { method: 'POST' });

  console.log('\nR12: deadlines behave differently from events');
  const agenda = (await api('/api/agenda')).data.items;
  const mot = agenda.find((i) => i.start_date === '2026-08-14');
  check('deadline has an escalating ladder', (mot?.lead_days_resolved || []).length >= 4);
  check('deadline exposes a runway', mot && mot.runway !== null);
  await api('/api/items/bulk', { method: 'POST', body: { ids: [mot.id], op: 'satisfy' } });
  const afterSat = (await api('/api/agenda')).data.items.find((i) => i.id === mot.id);
  check('marking sorted silences without deleting', afterSat?.satisfied === 1 && !!afterSat);

  console.log('\nbulk correction');
  const carItems = (await api(`/api/batches/${car.data.batch.id}`)).data.items;
  const shiftIds = carItems.map((i) => i.id);
  const origin = carItems[0].start_date;
  await api('/api/items/bulk', { method: 'POST', body: { ids: shiftIds, op: 'shift_days', days: 7 } });
  const shifted = (await api(`/api/batches/${car.data.batch.id}`)).data.items;
  check('bulk shift moved every selected item', shifted[0].start_date !== origin);
  await api('/api/items/bulk', { method: 'POST', body: { ids: shiftIds, op: 'shift_days', days: -7 } });
  check('shifting back restores the dates',
    (await api(`/api/batches/${car.data.batch.id}`)).data.items[0].start_date === origin);

  console.log('\nR6: re-import diffs instead of duplicating');
  const reimport = await captureImage('school-letter.png', { parentBatchId: letter.data.batch.id });
  check('a re-import returns a diff', !!reimport.data.diff);
  check('diff finds no spurious changes',
    reimport.data.diff.summary.changed === 0 && reimport.data.diff.summary.added === 0,
    JSON.stringify(reimport.data.diff.summary));
  check('a hand-edited item is protected, not reverted',
    reimport.data.diff.summary.conflicts === 1, JSON.stringify(reimport.data.diff.summary));
  check('the protection is explained', /edited by hand/.test(reimport.data.diff.description || ''),
    reimport.data.diff.description);
  check('diff matched the existing items',
    reimport.data.diff.summary.unchanged >= 7, String(reimport.data.diff.summary.unchanged));
  await api(`/api/batches/${reimport.data.batch.id}`, { method: 'DELETE' });

  console.log('\nR7: sharing, four envelopes');
  const shareText = await api(`/api/share/text?batch=${car.data.batch.id}`);
  check('plain text renders', /MOT/.test(shareText.data.text), shareText.data.text?.slice(0, 60));
  check('text marks deadlines', /DUE:/.test(shareText.data.text));
  const ics = await fetch(`${BASE}/api/export.ics?batch=${car.data.batch.id}`);
  const icsBody = await ics.text();
  check('ics downloads', ics.status === 200);
  check('ics is well formed', icsBody.startsWith('BEGIN:VCALENDAR') && icsBody.trimEnd().endsWith('END:VCALENDAR'));
  check('ics uses CRLF line endings', icsBody.includes('\r\n'));
  check('ics carries reminder alarms', icsBody.includes('BEGIN:VALARM'));
  check('ics has no unaccepted RRULE', !icsBody.includes('RRULE'));
  const share = await api('/api/shares', { method: 'POST', body: { batchId: car.data.batch.id, label: 'Car dates' } });
  check('share link created', !!share.data.token);
  const feed = await fetch(`${BASE}/s/${share.data.token}.ics`);
  check('share feed is subscribable', feed.status === 200 && (await feed.text()).startsWith('BEGIN:VCALENDAR'));
  const revoked = await api(`/api/shares/${share.data.id}/revoke`, { method: 'POST' });
  check('share can be revoked', revoked.status === 200);
  check('revoked share is gone', (await fetch(`${BASE}/s/${share.data.token}.ics`)).status === 404);

  console.log('\nrecurrence can only be created explicitly');
  const clubNow = (await api(`/api/batches/${letter.data.batch.id}`)).data.items.find((i) => /homework club/i.test(i.title));
  const noEnd = await api(`/api/items/${clubNow.id}/recurrence`, { method: 'POST', body: { accept: true } });
  check('a repeat with no end date is refused', noEnd.status === 400, String(noEnd.status));
  const withEnd = await api(`/api/items/${clubNow.id}/recurrence`, { method: 'POST', body: { accept: true, until: '2025-12-19' } });
  check('a bounded repeat is accepted', withEnd.status === 200);
  check('the rule is bounded', /UNTIL=/.test(withEnd.data.rrule || ''), withEnd.data.rrule);

  console.log('\ntext capture');
  const textCap = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', reference: '2025-09-03',
    text: 'Dentist appointment on 4 November 2025 at 9.15am\nCar insurance renewal due 30 November 2025',
  } });
  check('text capture works', textCap.status === 200);
  check('found both entries', textCap.data.items.length === 2, String(textCap.data.items.length));
  check('renewal typed as a deadline',
    textCap.data.items.some((i) => i.kind === 'deadline' && i.start_date === '2025-11-30'));

  console.log('\nsafety');
  const traversal = await fetch(`${BASE}/../package.json`);
  check('path traversal blocked', traversal.status === 200 && !(await traversal.text()).includes('"name": "kevcal"'));
  const badJson = await fetch(`${BASE}/api/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  });
  check('malformed JSON rejected cleanly', badJson.status === 400);
  const csrfForm = await fetch(`${BASE}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"timezone":"Evil/Place"}',
  });
  check('cross-site style POST refused', csrfForm.status === 415, String(csrfForm.status));
  const csrfOrigin = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ timezone: 'Evil/Place' }),
  });
  check('foreign Origin refused', csrfOrigin.status === 403, String(csrfOrigin.status));
  check('settings untouched by either', (await api('/api/settings')).data.timezone !== 'Evil/Place');

  const invented = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', reference: '2025-09-03', text: 'Contract ends December 2031',
  } });
  check('a month+year alone invents no day', invented.data.items.length === 0,
    JSON.stringify(invented.data.items?.map((i) => i.start_date)));
  const impossible = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', reference: '2025-09-03', text: 'Review on 29 February 2027 and 31 April 2026',
  } });
  check('impossible dates are rejected, not coerced', impossible.data.items.length === 0,
    JSON.stringify(impossible.data.items?.map((i) => i.start_date)));

  const dentist = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', reference: '2025-09-03', text: 'Dentist on 4 November 2025',
  } });
  const dentistId = dentist.data.items[0].id;
  await api(`/api/batches/${dentist.data.batch.id}/commit`, { method: 'POST' });
  const wildShift = await api('/api/items/bulk', { method: 'POST', body: { ids: [dentistId], op: 'shift_days', days: 1e9 } });
  check('an absurd shift is refused', wildShift.status === 400, String(wildShift.status));
  const badDate = await api(`/api/items/${dentistId}`, { method: 'PATCH', body: { start_date: '9999-99-99' } });
  check('an impossible date is refused', badDate.status === 400, String(badDate.status));
  const backwards = await api(`/api/items/${dentistId}`, { method: 'PATCH', body: { start_date: '2026-05-20', end_date: '2026-05-14' } });
  check('an end before a start is refused', backwards.status === 400, String(backwards.status));
  const stillFine = await fetch(`${BASE}/api/export.ics`);
  check('the whole-calendar export still works', stillFine.status === 200, String(stillFine.status));

  const inject = await api(`/api/items/${dentistId}/recurrence`, { method: 'POST', body: {
    accept: true, count: 3, freq: 'WEEKLY\r\nATTENDEE:mailto:evil@example.com',
  } });
  check('iCalendar injection via repeat is refused', inject.status === 400, String(inject.status));

  const wideOpen = await api('/api/shares', { method: 'POST', body: {} });
  check('a share must name what it shares', wideOpen.status === 400, String(wideOpen.status));

  const ghostRedo = await api('/api/batches/nope/redo', { method: 'POST' });
  check('redo on a missing batch 404s', ghostRedo.status === 404, String(ghostRedo.status));

  const missing = await api('/api/batches/does-not-exist');
  check('unknown batch 404s', missing.status === 404);

  console.log('\nsafety: an upload is what its bytes say, not what its name says');
  const evilHtml = Buffer.from('<html><script>fetch("/api/agenda").then(r=>r.json())</script></html>').toString('base64');
  const smuggled = await api('/api/capture', { method: 'POST', body: {
    kind: 'image', filename: 'holiday-photo.png', data: evilHtml, now: '2026-09-10T10:00',
  } });
  check('HTML dressed up as a .png never reaches disk', smuggled.status === 400, String(smuggled.status));
  check('and is refused in words a person understands',
    /photo or a PDF/.test(smuggled.data.error || ''), smuggled.data.error);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const svgTry = await api('/api/capture', { method: 'POST', body: {
    kind: 'image', filename: 'chart.svg', data: svg, now: '2026-09-10T10:00',
  } });
  check('a scriptable SVG is refused too', svgTry.status === 400, String(svgTry.status));

  const realPng = fs.readFileSync(path.join(ROOT, 'samples/poster.png')).toString('base64');
  const honest = await api('/api/capture', { method: 'POST', body: {
    // Lying about the extension the other way round must not matter either.
    kind: 'image', filename: 'not-really.html', data: realPng, now: '2026-09-10T10:00',
  } });
  check('a real image is accepted whatever it is called', honest.status === 200, String(honest.status));
  const served = await fetch(`${BASE}/api/source/${honest.data.batch.id}`);
  check('and is served as an image, never as HTML',
    served.headers.get('content-type') === 'image/png', served.headers.get('content-type'));
  check('with sniffing turned off in the browser',
    served.headers.get('x-content-type-options') === 'nosniff');
  await api(`/api/batches/${honest.data.batch.id}`, { method: 'DELETE' });

  console.log('\nsafety: headers');
  const shell = await fetch(BASE + '/');
  const csp = shell.headers.get('content-security-policy') || '';
  check('the app ships a content security policy', csp.includes("default-src 'self'"), csp.slice(0, 60));
  const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name));
  check('scripts may only come from the app itself', directive('script-src') === "script-src 'self'", directive('script-src'));
  check('and nothing may be embedded as an object', directive('object-src') === "object-src 'none'");
  check('it cannot be framed', shell.headers.get('x-frame-options') === 'DENY');
  check('and it leaks no referrer', shell.headers.get('referrer-policy') === 'no-referrer');

  // ────────────────────────────────────────────────────────────────────
  //  v2: the reader reads, the checker decides, and nothing is guessed.
  // ────────────────────────────────────────────────────────────────────

  console.log('\nv2: a clean read goes straight through');
  reads({
    document_title: 'Netherfield Primary',
    items: [{
      title: 'Parents evening', kind: 'event', start_date: '2027-03-11',
      has_explicit_year: true, weekday_stated: 'Thursday',
      start_time: '16:30', end_time: '19:30', am_pm_stated: true,
      confidence: 0.96, source_quote: 'Parents evening — Thursday 11 March 2027, 4.30pm to 7.30pm',
      box_2d: [120, 80, 160, 700],
    }],
  });
  const clean = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T14:30', tz: 'Europe/London',
  } });
  check('the fixture reader was used', /fixture/.test(clean.data.engine), clean.data.engine);
  check('a clean item raises no flags', (clean.data.items[0].flags || []).length === 0,
    JSON.stringify(clean.data.items[0].flags));
  check('and takes the three-tap path', clean.data.risk === 'low', clean.data.risk);
  check('the batch is named from the document', clean.data.batch.title === 'Netherfield Primary');
  check('the model box became a bounding box', Array.isArray(clean.data.items[0].bbox));
  const cleanCommit = await api(`/api/batches/${clean.data.batch.id}/commit`, { method: 'POST' });
  check('it commits with no review at all', cleanCommit.status === 200, cleanCommit.text.slice(0, 120));

  console.log('\nv2: "tomorrow" just after midnight is asked about, not assumed');
  reads({ items: [{
    title: 'School trip', kind: 'event', start_date: null,
    relative_phrase: 'tomorrow', relative_kind: 'tomorrow',
    has_explicit_year: false, am_pm_stated: true, confidence: 0.95,
    source_quote: 'The trip leaves tomorrow at 8am', start_time: '08:00',
  }] });
  const midnight = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T00:20', tz: 'Europe/London',
  } });
  const trip = midnight.data.items[0];
  const midFlag = (trip.flags || []).find((f) => f.code === 'midnight_ambiguity');
  check('the small-hours ambiguity is raised', !!midFlag, JSON.stringify((trip.flags || []).map((f) => f.code)));
  check('it is a blocker', midFlag?.level === 'blocker');
  check('both days are offered as one tap', midFlag?.options?.length === 2);
  check('the batch is marked blocked', midnight.data.risk === 'blocked', midnight.data.risk);

  const blockedCommit = await api(`/api/batches/${midnight.data.batch.id}/commit`, { method: 'POST' });
  check('it cannot reach the calendar unanswered', blockedCommit.status === 409, String(blockedCommit.status));

  const chosen = midFlag.options[1];
  const answered = await api(`/api/items/${trip.id}`, { method: 'PATCH', body: chosen.patch });
  check('answering it sets the date', answered.data.item.start_date === chosen.patch.start_date);
  check('and retires the flag that asked', (answered.data.item.flags || []).every((f) => f.code !== 'midnight_ambiguity'),
    JSON.stringify(answered.data.item.flags));
  check('and unblocks the item', answered.data.item.blocked === 0);
  const nowCommits = await api(`/api/batches/${midnight.data.batch.id}/commit`, { method: 'POST' });
  check('now it commits', nowCommits.status === 200, nowCommits.text.slice(0, 120));

  console.log('\nv2: a document that dates itself needs no question');
  reads({ document_date: '2026-09-09', items: [{
    title: 'Sports day', kind: 'event', start_date: null,
    relative_phrase: 'tomorrow', relative_kind: 'tomorrow',
    has_explicit_year: false, am_pm_stated: true, confidence: 0.9,
    source_quote: 'Sports day is tomorrow',
  }] });
  const anchored = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T00:20', tz: 'Europe/London',
  } });
  check('it counts from the letter, not the clock', anchored.data.items[0].start_date === '2026-09-10',
    anchored.data.items[0].start_date);
  check('so nothing blocks', anchored.data.items[0].blocked === 0);
  check('and the reasoning is shown', /9 September/.test(anchored.data.items[0].src_interpretation || ''),
    anchored.data.items[0].src_interpretation);

  console.log('\nv2: the reader is cross-examined');
  reads({ items: [{
    title: 'Contract end', kind: 'deadline', start_date: '2025-12-20',
    has_explicit_year: true, am_pm_stated: true, confidence: 0.94,
    source_quote: 'Contract ends December 2031',
  }] });
  const caught = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T10:00', tz: 'Europe/London',
  } });
  const codes = (caught.data.items[0].flags || []).map((f) => f.code);
  check('a confident wrong year is caught', codes.includes('year_mismatch'), JSON.stringify(codes));
  check('and blocked at 94% confidence', caught.data.items[0].blocked === 1);
  await api(`/api/batches/${caught.data.batch.id}`, { method: 'DELETE' });

  reads({ items: [{
    title: 'Assembly', kind: 'event', start_date: '2027-03-12', weekday_stated: 'Thursday',
    has_explicit_year: true, am_pm_stated: true, confidence: 0.9,
    source_quote: 'Assembly on Thursday 12 March 2027',
  }] });
  const wrongDay = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T10:00', tz: 'Europe/London',
  } });
  const dayFlag = (wrongDay.data.items[0].flags || []).find((f) => f.code === 'weekday_mismatch');
  check('a weekday that contradicts the date is caught', !!dayFlag);
  check('and the Thursday is offered', dayFlag?.options?.[0]?.patch.start_date === '2027-03-11',
    JSON.stringify(dayFlag?.options?.map((o) => o.patch.start_date)));
  await api(`/api/batches/${wrongDay.data.batch.id}`, { method: 'DELETE' });

  console.log('\nv2: times carry a real timezone into the calendar');
  await api('/api/settings', { method: 'POST', body: { timezone: 'Europe/London' } });
  const tzIcs = await (await fetch(`${BASE}/api/export.ics?batch=${clean.data.batch.id}`)).text();
  check('a timed event is written as a real instant', /DTSTART:20270311T163000Z/.test(tzIcs),
    tzIcs.split('\r\n').find((l) => l.startsWith('DTSTART')));
  check('the calendar names its zone', /X-WR-TIMEZONE:Europe\/London/.test(tzIcs));

  console.log('\nv2: the share-sheet entry point');
  reads({ items: [{
    title: 'Dentist', kind: 'event', start_date: '2027-01-14', has_explicit_year: true,
    am_pm_stated: true, confidence: 0.9, source_quote: 'Dentist 14 January 2027',
  }] });
  const quick = await api('/api/quick', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T10:00',
  } });
  check('quick capture returns one URL to open', /^\/\?b=b_/.test(quick.data.url || ''), quick.data.url);
  check('and says what it found', quick.data.found === 1 && quick.data.needs_check === 0,
    JSON.stringify(quick.data));

  console.log('\nv2: a table whose columns did not line up is caught');
  reads({ items: [1, 2, 3, 4, 5].map((n) => ({
    title: 'CALIFORNIA INSTITUTE OF TECHNOLOGY', kind: 'event',
    start_date: `2027-0${n}-1${n}`, has_explicit_year: true, am_pm_stated: true,
    confidence: 0.9, source_quote: `row ${n}`,
  })) });
  const columns = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'anything', now: '2026-09-10T10:00',
  } });
  check('every row of a mis-aligned table is flagged',
    columns.data.items.every((i) => (i.flags || []).some((f) => f.code === 'repeated_title')),
    JSON.stringify(columns.data.items.map((i) => (i.flags || []).map((f) => f.code))));
  check('but it does not block — the dates may still be right',
    columns.data.items.every((i) => i.blocked === 0));
  await api(`/api/batches/${columns.data.batch.id}`, { method: 'DELETE' });

  readsNothing();
  const fellBack = await api('/api/capture', { method: 'POST', body: {
    kind: 'text', text: 'Dentist on 4 November 2027', now: '2026-09-10T10:00',
  } });
  check('with the reader unavailable it still works', fellBack.data.items.length === 1, fellBack.data.engine);
  check('and says which engine actually read it', /grammar/.test(fellBack.data.engine), fellBack.data.engine);
} catch (e) {
  failed++;
  failures.push(`harness: ${e.message}`);
  console.error('\nharness error:', e);
  if (serverErr) console.error('--- server stderr ---\n' + serverErr.split('\n').filter(l=>!/Experimental|trace-warnings/.test(l)).join('\n'));
} finally {
  server.kill();
  readsNothing();
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n  failures:');
  failures.forEach((f) => console.log(`   · ${f}`));
}
console.log('');
process.exit(failed ? 1 : 0);
