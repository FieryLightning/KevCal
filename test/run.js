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

const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  env: { ...process.env, KEVCAL_PORT: String(PORT), KEVCAL_DATA: TMP_DATA, KEVCAL_HOST: '127.0.0.1' },
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
  check('AI is off by default', health.data.ai_enabled === false);

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
  check('a bulky/uncertain import is high risk', letter.data.risk === 'high');
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
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"ai_enabled":true}',
  });
  check('cross-site style POST refused', csrfForm.status === 415, String(csrfForm.status));
  const csrfOrigin = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ ai_enabled: true }),
  });
  check('foreign Origin refused', csrfOrigin.status === 403, String(csrfOrigin.status));
  check('privacy switch untouched', (await api('/api/settings')).data.ai_enabled === false);

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
} catch (e) {
  failed++;
  failures.push(`harness: ${e.message}`);
  console.error('\nharness error:', e);
  if (serverErr) console.error('--- server stderr ---\n' + serverErr.split('\n').filter(l=>!/Experimental|trace-warnings/.test(l)).join('\n'));
} finally {
  server.kill();
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
