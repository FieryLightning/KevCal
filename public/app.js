// KevCal front end. No framework, no build step — the whole app is this file,
// one stylesheet and one HTML shell, served straight off disk.
//
// The shape of it follows one rule from the research: you should never have to
// reopen the original document to trust what came out. So every uncertain item
// carries its own explanation, its own alternatives, and a tap through to the
// exact place on the page it was read from.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'dates',
  health: {},
  settings: {},
  batch: null,          // the import currently under review
  items: [],
  scanTimer: null,
  shareCtx: null,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ───────────────────────────────────────────────────────── small helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pad(n) { return String(n).padStart(2, '0'); }

/** The phone's own wall clock, which is the only clock "tomorrow" means anything against. */
function localNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localDateOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function timezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}
function todayISO() { return localNow().slice(0, 10); }

function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function daysFromToday(iso) {
  return Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
}

function dayChip(item) {
  if (!item.start_date) return `<div class="daychip none"><div class="m">?</div><div class="d">–</div><div class="w">no date</div></div>`;
  const d = parseISO(item.start_date);
  const cls = item.kind === 'deadline' ? 'daychip due' : 'daychip';
  return `<div class="${cls}"><div class="m">${MONTHS[d.getMonth()]}</div><div class="d">${d.getDate()}</div><div class="w">${DAYS[d.getDay()]}</div></div>`;
}

function whenLabel(iso) {
  if (!iso) return 'No date yet';
  const n = daysFromToday(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return `In ${n} days`;
  if (n < -1 && n > -14) return `${Math.abs(n)} days ago`;
  const d = parseISO(iso);
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

function timeLabel(item) {
  if (!item.start_time) return '';
  const fmt = (t) => {
    const [h, m] = t.split(':').map(Number);
    const ap = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${pad(m)}${ap}` : `${h12}${ap}`;
  };
  return item.end_time ? `${fmt(item.start_time)}–${fmt(item.end_time)}` : fmt(item.start_time);
}

function haptic(ms = 8) { try { navigator.vibrate?.(ms); } catch { /* not everywhere */ } }

let toastTimer = null;
function toast(msg, action = null) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
    t.append(b);
  }
  t.hidden = false;
  $('#live').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) data.__status = res.status;
  return data;
}

function openOverlay(el) { el.hidden = false; document.body.classList.add('locked'); }
function closeOverlay(el) { el.hidden = true; if (!$$('.overlay:not([hidden]), .sheet-wrap:not([hidden])').length) document.body.classList.remove('locked'); }

// ───────────────────────────────────────────────────────── navigation

function go(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('show', v.dataset.view === view));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.go === view));
  window.scrollTo({ top: 0 });
  if (view === 'dates') loadDates();
  if (view === 'imports') loadImports();
  if (view === 'shared') loadShares();
  if (view === 'settings') loadSettings();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => { haptic(); go(t.dataset.go); }));

// ───────────────────────────────────────────────────────── dates view

async function loadDates() {
  const list = $('#datesList');
  const { items = [] } = await api('/api/agenda');
  const live = items.filter((i) => i.status === 'accepted');

  const upcoming = live.filter((i) => i.start_date && daysFromToday(i.start_date) >= 0);
  const past = live.filter((i) => i.start_date && daysFromToday(i.start_date) < 0);
  const undated = live.filter((i) => !i.start_date);
  const flagged = live.filter((i) => (i.flags || []).length);

  const openDeadlines = upcoming.filter((i) => i.kind === 'deadline' && !i.satisfied).length;
  $('#datesHeadline').textContent = upcoming.length ? 'Your dates' : 'Nothing yet';
  $('#datesSub').textContent = upcoming.length
    ? [`${upcoming.length} coming up`,
       openDeadlines ? `${openDeadlines} deadline${openDeadlines === 1 ? '' : 's'}` : null,
       flagged.length ? `${flagged.length} worth a check` : null].filter(Boolean).join(' · ')
    : 'Tap the camera and point it at something with a date on it.';

  if (!live.length) {
    list.innerHTML = `<div class="empty"><b>No dates yet</b>
      A school letter, a poster, a timetable, an appointment card — anything.
      <div style="margin-top:14px"><a class="btn" href="/help.html">How to use KevCal</a></div></div>`;
    return;
  }

  const groups = [];
  if (undated.length) groups.push(['Needs a date', undated]);
  if (upcoming.length) {
    const soon = upcoming.filter((i) => daysFromToday(i.start_date) <= 7);
    const later = upcoming.filter((i) => daysFromToday(i.start_date) > 7);
    if (soon.length) groups.push(['This week', soon]);
    if (later.length) groups.push(['Later', later]);
  }
  if (past.length) groups.push(['Gone by', past.slice(-12).reverse()]);

  list.innerHTML = groups.map(([label, rows]) => `
    <div class="section-label">${label}</div>
    ${rows.map((i, n) => itemCard(i, { delay: n, past: label === 'Gone by' })).join('')}
  `).join('');
  wireItemCards(list, live);
}

function itemCard(item, { delay = 0, past = false, showFlags = false } = {}) {
  const flags = item.flags || [];
  const worst = flags.some((f) => f.level === 'blocker') ? 'stop' : (flags.length ? 'warn' : '');
  const meta = [
    whenLabel(item.start_date),
    timeLabel(item),
    item.location,
    item.kind === 'deadline' ? '<span class="kindtag">DUE</span>' : '',
  ].filter(Boolean);

  const tags = [];
  if (item.satisfied) tags.push('<span class="tag ok">✓ sorted</span>');
  if (item.recurrence?.phrase && !item.recurrence_accepted) {
    tags.push(`<span class="tag">repeats? “${esc(item.recurrence.phrase)}”</span>`);
  }
  if (item.cost) tags.push(`<span class="tag">${esc(item.cost)}</span>`);
  if (item.owner) tags.push(`<span class="tag">${esc(item.owner)}</span>`);

  let runway = '';
  if (item.kind === 'deadline' && item.runway != null && !item.satisfied && item.runway > 0) {
    runway = `<div class="runway"><i style="width:${Math.round(item.runway * 100)}%"></i></div>`;
  }

  return `
  <div class="item ${worst} ${past ? 'gone' : ''}" role="button" tabindex="0"
       data-id="${item.id}" style="animation-delay:${Math.min(delay * 45, 400)}ms">
    ${dayChip(item)}
    <div class="item-main">
      <div class="item-title">${esc(item.title)}</div>
      <div class="item-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
      ${runway}
      ${showFlags ? flags.map((f) => flagBlock(item, f)).join('') : ''}
    </div>
  </div>`;
}

function flagBlock(item, f) {
  const stop = f.level === 'blocker';
  const opts = (f.options || []).map((o, n) => `
    <button class="opt" data-opt="${n}" data-flag="${esc(f.code)}" data-item="${item.id}" type="button">${esc(o.label)}</button>
  `).join('');
  // A blocker with no alternatives to offer still needs an obvious next move.
  // For something with no date at all that is "give it one", not "carry on".
  let keep = '';
  if (stop && !(f.options || []).length) {
    keep = item.start_date
      ? `<button class="opt" data-keep="${item.id}" type="button">Keep it as it is</button>`
      : `<button class="opt pick" data-pick="${item.id}" type="button">Pick a date</button>
         <button class="opt" data-drop="${item.id}" type="button">Drop it</button>`;
  }
  return `<div class="flag ${stop ? 'stop' : ''}">
    <b>${stop ? 'Needs your answer' : 'Worth a check'}</b>
    ${esc(f.message)}
    ${opts || keep ? `<div class="opts">${opts}${keep}</div>` : ''}
  </div>`;
}

function wireItemCards(root, pool) {
  $$('.item', root).forEach((card) => {
    const item = pool.find((i) => i.id === card.dataset.id);
    if (!item) return;
    const open = (e) => {
      if (e.target.closest('.opt')) return;
      haptic(); openEditor(item);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
  });

  $$('.opt[data-opt]', root).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = pool.find((i) => i.id === btn.dataset.item);
      const f = (item?.flags || []).find((x) => x.code === btn.dataset.flag);
      const opt = f?.options?.[Number(btn.dataset.opt)];
      if (!opt) return;
      haptic(12);
      btn.classList.add('pick');
      const res = await api(`/api/items/${item.id}`, { method: 'PATCH', body: opt.patch });
      if (res.error) return toast(res.error);
      await refreshCurrent();
    });
  });

  $$('.opt[data-pick]', root).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      const item = pool.find((i) => i.id === btn.dataset.pick);
      if (item) openEditor(item);
    });
  });

  $$('.opt[data-drop]', root).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      haptic(12);
      await api('/api/items/bulk', { method: 'POST', body: { op: 'reject', ids: [btn.dataset.drop] } });
      await refreshCurrent();
    });
  });

  $$('.opt[data-keep]', root).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      haptic(12);
      await api('/api/items/bulk', { method: 'POST', body: { op: 'review', ids: [btn.dataset.keep] } });
      await refreshCurrent();
    });
  });
}

async function refreshCurrent() {
  if (!$('#review').hidden && state.batch) return reloadReview();
  if (state.view === 'dates') return loadDates();
}

// ───────────────────────────────────────────────────────── capture

$('#btnCapture').addEventListener('click', () => { haptic(); openOverlay($('#chooser')); });
$('#pickCamera').addEventListener('click', () => { closeOverlay($('#chooser')); $('#fileCamera').click(); });
$('#pickLibrary').addEventListener('click', () => { closeOverlay($('#chooser')); $('#fileLibrary').click(); });
$('#pickFile').addEventListener('click', () => { closeOverlay($('#chooser')); $('#filePicker').click(); });
$('#pickText').addEventListener('click', () => { closeOverlay($('#chooser')); openOverlay($('#textSheet')); $('#pasteBox').focus(); });

['fileCamera', 'fileLibrary', 'filePicker'].forEach((id) => {
  $(`#${id}`).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) captureFile(file);
  });
});

$('#btnReadText').addEventListener('click', () => {
  const text = $('#pasteBox').value.trim();
  if (!text) return toast('Paste something first');
  closeOverlay($('#textSheet'));
  $('#pasteBox').value = '';
  runCapture({ kind: 'text', text }, null);
});

// Paste a screenshot straight in, from anywhere in the app.
window.addEventListener('paste', (e) => {
  if (!$('#review').hidden || !$('#editor').hidden) return;
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) { e.preventDefault(); return captureFile(file); }
  const text = e.clipboardData?.getData('text');
  if (text && text.trim().length > 12 && $('#textSheet').hidden) {
    e.preventDefault();
    runCapture({ kind: 'text', text }, null);
  }
});

['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'drop' && e.dataTransfer?.files?.[0]) captureFile(e.dataTransfer.files[0]);
}));

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('could not read that file'));
    r.readAsDataURL(file);
  });
}

async function captureFile(file) {
  if (file.size > 32 * 1024 * 1024) return toast('That file is too big — 32 MB is the limit');
  let dataURL;
  try { dataURL = await readAsDataURL(file); } catch (e) { return toast(e.message); }
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  runCapture({
    kind: isPdf ? 'pdf' : 'image',
    filename: file.name || (isPdf ? 'document.pdf' : 'photo.jpg'),
    data: String(dataURL).split(',')[1],
    // When the photo was taken, not when it was imported: a letter photographed
    // yesterday saying "tomorrow" does not mean the day after today.
    takenAt: file.lastModified ? localDateOf(file.lastModified) : undefined,
  }, isPdf ? null : dataURL);
}

const SCAN_LINES = [
  'Looking at the page…',
  'Finding the dates…',
  'Reading what is actually printed…',
  'Checking the days against the dates…',
  'Almost there…',
];

async function runCapture(payload, previewURL) {
  const scanner = $('#scanner');
  const img = $('#scanImg');
  const doc = $('#scanDoc');
  $('#scanBoxes').innerHTML = '';
  if (previewURL) { img.src = previewURL; img.hidden = false; doc.hidden = true; }
  else { img.hidden = true; img.removeAttribute('src'); doc.hidden = false; }

  openOverlay(scanner);
  let step = 0;
  $('#scanText').textContent = SCAN_LINES[0];
  state.scanTimer = setInterval(() => {
    step = Math.min(step + 1, SCAN_LINES.length - 1);
    $('#scanText').textContent = SCAN_LINES[step];
  }, 2100);

  let cancelled = false;
  $('#scanCancel').onclick = () => { cancelled = true; stopScan(); closeOverlay(scanner); };

  const res = await api('/api/capture', {
    method: 'POST',
    body: {
      ...payload,
      now: localNow(),
      tz: timezone(),
      // Set when you picked "Update" on an existing import: the server then
      // reconciles against it rather than giving you two of everything.
      parentBatchId: state.updatingBatch || undefined,
    },
  });
  state.updatingBatch = null;
  if (cancelled) return;
  stopScan();

  if (res.error) { closeOverlay(scanner); return toast(res.error); }

  // Let the boxes land on the page before moving on — this is the moment the
  // app proves it actually read the thing in front of you.
  if (previewURL && res.items?.length) {
    drawBoxes($('#scanBoxes'), res.items);
    $('#scanText').textContent = res.items.length === 1 ? 'Found 1 date' : `Found ${res.items.length} dates`;
    await new Promise((r) => setTimeout(r, 780));
  }
  closeOverlay(scanner);
  haptic(18);
  showReview(res);
  refreshCost();
}

function stopScan() { clearInterval(state.scanTimer); state.scanTimer = null; }

function drawBoxes(svg, items) {
  svg.innerHTML = items.map((i, n) => {
    if (!i.bbox) return '';
    const [x, y, w, h] = i.bbox;
    const hot = (i.flags || []).length ? ' class="hot"' : '';
    return `<rect${hot} x="${x * 100}" y="${y * 100}" width="${w * 100}" height="${h * 100}"
            rx="0.8" style="animation-delay:${n * 70}ms"></rect>`;
  }).join('');
}

// ───────────────────────────────────────────────────────── review

function showReview(res) {
  state.batch = res.batch;
  state.items = res.items || [];
  state.lastResponse = res;
  if (res.diff) renderDiff(res); else renderReview();
  openOverlay($('#review'));
}

const FIELD_NAMES = {
  start_date: 'date', start_time: 'starts', end_date: 'ends', end_time: 'ends',
  title: 'name', location: 'where', kind: 'kind', all_day: 'all day',
};

function fieldValue(field, v) {
  if (v === null || v === undefined || v === '') return 'nothing';
  if (field === 'start_date' || field === 'end_date') return whenLabel(v);
  if (field === 'all_day') return v ? 'yes' : 'no';
  return String(v);
}

/**
 * A re-issued document, next to the one you already have.
 *
 * Nothing here is applied until you press the button: a school sending a
 * corrected calendar should not be able to silently rewrite what is already in
 * yours, and anything you fixed by hand is held back by default rather than
 * being quietly overwritten by the new version.
 */
function renderDiff(res) {
  const d = res.diff;
  state.diff = d;
  state.picked = new Set();

  const row = (key, title, detail, on = true) => {
    if (on) state.picked.add(key);
    return `<div class="item diffrow ${on ? 'on' : ''}" role="button" tabindex="0" data-pick="${key}">
      <div class="tick">${on ? '✓' : ''}</div>
      <div class="item-main">
        <div class="item-title">${esc(title)}</div>
        <div class="item-meta">${detail}</div>
      </div>
    </div>`;
  };

  const groups = [];

  if (d.changed.length) {
    groups.push('<div class="section-label">Moved or corrected</div>' + d.changed.map((c) => row(
      'c:' + c.after.id + ':' + c.before.id,
      c.after.title,
      c.changes.map((ch) => `<span>${FIELD_NAMES[ch.field] || ch.field}: ${esc(fieldValue(ch.field, ch.from))} → <b>${esc(fieldValue(ch.field, ch.to))}</b></span>`).join(''),
    )).join(''));
  }
  if (d.added.length) {
    groups.push('<div class="section-label">New in this version</div>' + d.added.map((a) => row(
      'a:' + a.id, a.title,
      `<span>${whenLabel(a.start_date)}</span>` + (a.blocked ? '<span class="kindtag">needs an answer first</span>' : ''),
      !a.blocked,
    )).join(''));
  }
  if (d.removed.length) {
    groups.push('<div class="section-label">Gone from this version</div>' + d.removed.map((r) => row(
      'r:' + r.id, r.title, `<span>${whenLabel(r.start_date)} — would be taken out</span>`,
    )).join(''));
  }
  if (d.conflicts.length) {
    groups.push('<div class="section-label">You edited these — kept as they are</div>' + d.conflicts.map((c) => row(
      'f:' + c.after.id + ':' + c.before.id,
      c.after.title,
      `<span>your version: ${esc(whenLabel(c.before.start_date))} · new version: ${esc(whenLabel(c.after.start_date))}</span>`,
      false,
    )).join(''));
  }
  if (d.unchanged.length) {
    groups.push(`<div class="section-label">Unchanged</div>
      <div class="banner">${d.unchanged.length} date${d.unchanged.length === 1 ? '' : 's'} are the same in both versions and are left alone.</div>`);
  }

  $('#reviewTitle').textContent = 'Updated version';
  $('#foundCount').textContent = d.summary.changed + d.summary.added + d.summary.removed;
  $('#foundLabel').textContent = 'things to change';
  $('#foundSub').textContent = d.summary.unchanged + ' unchanged';
  $('#diffBanner').innerHTML = `<div class="banner">${esc(d.description)}</div>`;
  $('#reviewList').innerHTML = groups.join('') || '<div class="banner">Nothing has changed since the last version.</div>';

  $$('.diffrow', $('#reviewList')).forEach((el) => {
    const toggle = () => {
      const key = el.dataset.pick;
      if (state.picked.has(key)) { state.picked.delete(key); el.classList.remove('on'); $('.tick', el).textContent = ''; }
      else { state.picked.add(key); el.classList.add('on'); $('.tick', el).textContent = '✓'; }
      haptic();
      updateDiffButton();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });

  $('#btnDiscard').textContent = 'Keep what I have';
  $('#btnDiscard').onclick = async () => {
    await api(`/api/batches/${state.batch.id}`, { method: 'DELETE' });
    closeOverlay($('#review'));
    toast('Left alone — nothing changed');
    go('imports');
  };
  $('#btnAdd').onclick = applyDiff;
  updateDiffButton();
}

function updateDiffButton() {
  const n = state.picked.size;
  const btn = $('#btnAdd');
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? 'Nothing selected' : `Apply ${n} change${n === 1 ? '' : 's'}`;
}

async function applyDiff() {
  const accept = [];
  for (const key of state.picked) {
    const [kind, a, b] = key.split(':');
    if (kind === 'c') accept.push({ op: 'change', newItemId: a, targetId: b });
    if (kind === 'f') accept.push({ op: 'change', newItemId: a, targetId: b, force: true });
    if (kind === 'a') accept.push({ op: 'add', newItemId: a });
    if (kind === 'r') accept.push({ op: 'remove', targetId: a });
  }
  const res = await api(`/api/batches/${state.batch.id}/apply-diff`, { method: 'POST', body: { accept } });
  if (res.error) return toast(res.error);
  haptic(30);
  closeOverlay($('#review'));
  const bits = [];
  if (res.changed) bits.push(`${res.changed} updated`);
  if (res.added) bits.push(`${res.added} added`);
  if (res.removed) bits.push(`${res.removed} taken out`);
  if (res.blocked) bits.push(`${res.blocked} still need an answer`);
  toast(bits.join(', ') || 'Nothing to change');
  go('dates');
}

async function reloadReview() {
  const res = await api(`/api/batches/${state.batch.id}`);
  if (res.error) return;
  state.batch = res.batch;
  state.items = res.items;
  renderReview({ silent: true });
}

function renderReview({ silent = false } = {}) {
  const items = state.items;
  const blockers = items.filter((i) => i.blocked && !i.reviewed);
  const checks = items.filter((i) => !i.blocked && (i.flags || []).length);

  $('#reviewTitle').textContent = state.batch?.title?.slice(0, 40) || 'Found';
  $('#foundLabel').textContent = items.length === 1 ? 'date found' : 'dates found';
  $('#foundSub').textContent = blockers.length
    ? `${blockers.length} need${blockers.length === 1 ? 's' : ''} your answer`
    : checks.length ? `${checks.length} worth a check` : 'All clear';

  if (silent) $('#foundCount').textContent = items.length;
  else countUp($('#foundCount'), items.length);

  const src = state.lastResponse || {};
  let banner = '';
  if (!items.length) {
    banner = `<div class="banner warn">I couldn't find any dates on that. Try a straighter photo, or paste the text instead.</div>`;
  } else if (blockers.length) {
    banner = `<div class="banner stop"><b>Nothing here is guessed.</b> Where I couldn't be certain, I've asked instead — answer the ${blockers.length === 1 ? 'one below' : `${blockers.length} below`} and you're done.</div>`;
  }
  if (src.readerError) {
    banner += `<div class="banner warn">The reader couldn't handle this one (${esc(String(src.readerError).slice(0, 60))}), so this is the on-device reader's best effort.</div>`;
  }
  if (src.diff?.description) {
    banner += `<div class="banner">Compared with the earlier version: ${esc(src.diff.description)}</div>`;
  }
  // A term calendar is a schedule, but it is full of the words that mean
  // deadline — "last day for", "grades due". Each one then carries a five-step
  // reminder ladder, and twenty of those is not a calendar, it is an alarm
  // clock. Offer to retype the lot in one go.
  const dues = items.filter((i) => i.kind === 'deadline');
  if (dues.length >= 3) {
    banner += `<div class="banner warn" id="kindBanner">
      <b>${dues.length} of these are set as deadlines</b>, so each gets several reminders counting down.
      On a schedule you usually just want the day itself.
      <div class="opts"><button class="opt" id="allEvents" type="button">Make them all events</button></div>
    </div>`;
  }
  $('#diffBanner').innerHTML = banner;

  const ordered = [...blockers,
                   ...checks.filter((i) => !blockers.includes(i)),
                   ...items.filter((i) => !blockers.includes(i) && !checks.includes(i))];

  $('#reviewList').innerHTML = ordered.length
    ? ordered.map((i, n) => itemCard(i, { delay: n, showFlags: true })).join('')
    : '';
  wireItemCards($('#reviewList'), items);

  const allEvents = $('#allEvents');
  if (allEvents) allEvents.addEventListener('click', async () => {
    haptic(12);
    const ids = items.filter((i) => i.kind === 'deadline').map((i) => i.id);
    const res = await api('/api/items/bulk', { method: 'POST', body: { op: 'set_kind', kind: 'event', ids } });
    if (res.error) return toast(res.error);
    toast(`${res.affected} changed to events`);
    reloadReview();
  });

  const addable = items.filter((i) => i.status !== 'rejected');
  const btn = $('#btnAdd');
  btn.disabled = !addable.length || blockers.length > 0;
  btn.textContent = blockers.length
    ? `${blockers.length} still to answer`
    : addable.length ? `Add ${addable.length} to calendar` : 'Nothing to add';
}

function countUp(el, to) {
  const start = performance.now();
  const dur = Math.min(160 + to * 90, 900);
  const tick = (t) => {
    const p = Math.min((t - start) / dur, 1);
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

$('#reviewClose').addEventListener('click', () => { closeOverlay($('#review')); go('dates'); });
$('#reviewSource').addEventListener('click', () => openViewer(null));

$('#btnDiscard').addEventListener('click', async () => {
  if (!state.batch) return;
  await api(`/api/batches/${state.batch.id}`, { method: 'DELETE' });
  closeOverlay($('#review'));
  toast('Thrown away');
  go('dates');
});

$('#btnAdd').addEventListener('click', async () => {
  if (!state.batch) return;
  const res = await api(`/api/batches/${state.batch.id}/commit`, { method: 'POST', body: {} });
  if (res.error === 'needs_review') { toast(res.message); return reloadReview(); }
  if (res.error) return toast(res.error);
  haptic(30);
  showAdded(res.committed);
});

function showAdded(count) {
  const batchId = state.batch.id;
  $('#reviewList').innerHTML = `
    <div class="done-mark">
      <svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="27"/><path d="M18 31l8.5 8.5L43 23"/></svg>
    </div>
    <div class="hero" style="text-align:center">
      <h1>${count} added</h1>
      <p class="sub">They're in KevCal. Send them to your real calendar too:</p>
    </div>
    <div class="choices two" style="margin-top:4px">
      <button class="choice" id="doneIcs" type="button"><span class="ico">📅</span><b>Add to Calendar</b></button>
      <button class="choice" id="doneShare" type="button"><span class="ico">📤</span><b>Send to someone</b></button>
    </div>`;
  $('#diffBanner').innerHTML = '';
  $('#foundSub').textContent = 'Undo any time from Imports';
  $('#doneIcs').onclick = () => window.open(`/api/export.ics?batch=${batchId}`, '_blank');
  $('#doneShare').onclick = () => openShare({ batchId });
  $('#btnAdd').textContent = 'Done';
  $('#btnAdd').disabled = false;
  $('#btnAdd').onclick = () => { closeOverlay($('#review')); go('dates'); };
  $('#btnDiscard').textContent = 'Undo';
  $('#btnDiscard').onclick = async () => {
    await api(`/api/batches/${batchId}/undo`, { method: 'POST' });
    closeOverlay($('#review'));
    toast('Taken back out');
    go('dates');
  };
}

// ───────────────────────────────────────────────────────── item editor

let editing = null;

function openEditor(item) {
  editing = item;
  const crop = $('#editCrop');
  const batchId = item.batch_id || state.batch?.id;
  if (item.bbox && batchId) {
    const [x, y, w, h] = item.bbox;
    const padX = Math.min(0.04, x), padY = Math.min(0.06, y);
    const zoom = 1 / Math.min(1, Math.max(w + padX * 2, 0.12));
    crop.innerHTML = `
      <div style="overflow:hidden;position:relative;aspect-ratio:16/6">
        <img src="/api/source/${batchId}" alt="" style="position:absolute;width:${zoom * 100}%;max-width:none;
             left:${-(x - padX) * zoom * 100}%;top:${-(y - padY) * zoom * 100}%">
      </div>
      <span class="tapme">see the page</span>`;
    crop.onclick = () => openViewer(item);
  } else {
    crop.innerHTML = `<div class="quote">${esc(item.src_raw || 'Added by hand')}</div>`;
    crop.onclick = null;
  }

  $('#editFlags').innerHTML = (item.flags || []).map((f) => flagBlock(item, f)).join('')
    + (item.src_interpretation ? `<div class="banner">${esc(item.src_interpretation)}</div>` : '');
  wireItemCards($('#editFlags'), [item]);

  $('#edTitle').value = item.title || '';
  $('#edDate').value = item.start_date || '';
  $('#edEndDate').value = item.end_date || '';
  $('#edStart').value = item.start_time || '';
  $('#edEnd').value = item.end_time || '';
  $('#edWhere').value = item.location || '';
  $('#edNotes').value = item.notes || '';
  $('#edAllDay').checked = !!item.all_day;
  $('#edTimes').style.display = item.all_day ? 'none' : '';
  $$('#edKind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === item.kind));

  openOverlay($('#editor'));
}

$('#edAllDay').addEventListener('change', (e) => {
  $('#edTimes').style.display = e.target.checked ? 'none' : '';
});
$$('#edKind button').forEach((b) => b.addEventListener('click', () => {
  $$('#edKind button').forEach((x) => x.classList.toggle('on', x === b));
}));

$('#edSave').addEventListener('click', async () => {
  if (!editing) return;
  const allDay = $('#edAllDay').checked;
  const body = {
    title: $('#edTitle').value.trim() || '(untitled)',
    kind: $('#edKind button.on')?.dataset.kind || 'event',
    start_date: $('#edDate').value || null,
    end_date: $('#edEndDate').value || null,
    all_day: allDay ? 1 : 0,
    start_time: allDay ? null : ($('#edStart').value || null),
    end_time: allDay ? null : ($('#edEnd').value || null),
    location: $('#edWhere').value.trim() || null,
    notes: $('#edNotes').value.trim() || null,
  };
  const res = await api(`/api/items/${editing.id}`, { method: 'PATCH', body });
  if (res.error) return toast(res.error);
  haptic(12);
  closeOverlay($('#editor'));
  toast('Saved');
  await refreshCurrent();
});

$('#edDelete').addEventListener('click', async () => {
  if (!editing) return;
  await api('/api/items/bulk', { method: 'POST', body: { op: 'delete', ids: [editing.id] } });
  closeOverlay($('#editor'));
  toast('Removed');
  await refreshCurrent();
});

// ───────────────────────────────────────────────────────── source viewer

function openViewer(item) {
  const batchId = item?.batch_id || state.batch?.id;
  if (!batchId) return toast('No original for this one');
  $('#viewerImg').src = `/api/source/${batchId}`;
  const pool = item ? [item] : state.items;
  drawBoxes($('#viewerBoxes'), pool);
  $('#viewerCap').textContent = item?.src_raw
    ? `“${item.src_raw}”`
    : 'Every date KevCal read, boxed on the original.';
  openOverlay($('#viewer'));
}
$('#viewerClose').addEventListener('click', () => closeOverlay($('#viewer')));

// ───────────────────────────────────────────────────────── imports

async function loadImports() {
  const { batches = [] } = await api('/api/batches');
  const list = $('#importsList');
  if (!batches.length) {
    list.innerHTML = `<div class="empty"><b>No imports yet</b>Every capture shows up here, and every one can be undone whole.</div>`;
    return;
  }
  // An import and its later versions are one thing to a person — "the school
  // calendar" — so they are one row here, however many times it was re-issued.
  const byId = new Map(batches.map((x) => [x.id, x]));
  const rootOf = (x) => {
    let cur = x;
    const seen = new Set();
    while (cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parent_id); }
    return cur;
  };
  const groups = new Map();
  for (const x of batches) {
    const root = rootOf(x);
    if (!groups.has(root.id)) groups.set(root.id, { root, all: [] });
    groups.get(root.id).all.push(x);
  }

  list.innerHTML = [...groups.values()].map(({ root, all }) => {
    const revisions = all.length - 1;
    const kept = all.reduce((n, x) => n + (x.accepted_count || 0), 0);
    const total = all.reduce((n, x) => n + (x.item_count || 0), 0);
    const newest = all.map((x) => x.created_at).sort().at(-1);
    const when = new Date(newest);
    const undone = all.every((x) => x.status === 'undone');
    return `<div class="card">
      <h3>${esc(root.title)}</h3>
      <div class="item-meta" style="margin-bottom:10px">
        <span>${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <span>${kept} of ${total} kept</span>
        ${revisions ? `<span class="kindtag">updated ${revisions}×</span>` : ''}
        ${undone ? '<span class="kindtag">UNDONE</span>' : ''}
      </div>
      <div class="row">
        <button class="btn" data-open="${root.id}" type="button">Open</button>
        <button class="btn" data-update="${root.id}" type="button">Update</button>
        ${undone
          ? `<button class="btn" data-redo="${root.id}" type="button">Restore</button>`
          : `<button class="btn" data-undo="${root.id}" type="button">Undo</button>`}
        <button class="btn" data-share="${root.id}" type="button">Share</button>
        <button class="btn ghost" data-del="${root.id}" type="button">Delete</button>
      </div>
    </div>`;
  }).join('');

  $$('[data-open]', list).forEach((b) => b.onclick = async () => {
    const res = await api(`/api/batches/${b.dataset.open}?lineage=1`);
    if (res.error) return toast(res.error);
    state.lastResponse = {};
    showReview(res);
  });
  $$('[data-update]', list).forEach((b) => b.onclick = () => {
    state.updatingBatch = b.dataset.update;
    haptic();
    toast('Now capture the new version of it');
    openOverlay($('#chooser'));
  });
  $$('[data-undo]', list).forEach((b) => b.onclick = async () => {
    const r = await api(`/api/batches/${b.dataset.undo}/undo?lineage=1`, { method: 'POST' });
    toast(`Took back ${r.removed} date${r.removed === 1 ? '' : 's'}`, {
      label: 'Restore',
      run: async () => { await api(`/api/batches/${b.dataset.undo}/redo`, { method: 'POST' }); loadImports(); },
    });
    loadImports();
  });
  $$('[data-redo]', list).forEach((b) => b.onclick = async () => {
    await api(`/api/batches/${b.dataset.redo}/redo`, { method: 'POST' });
    toast('Put back');
    loadImports();
  });
  $$('[data-share]', list).forEach((b) => b.onclick = () => openShare({ batchId: b.dataset.share }));
  $$('[data-del]', list).forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this and every version of it, including the original images? This cannot be undone.')) return;
    await api(`/api/batches/${b.dataset.del}?lineage=1`, { method: 'DELETE' });
    toast('Deleted');
    loadImports();
  });
}

// ───────────────────────────────────────────────────────── share

async function openShare(ctx) {
  state.shareCtx = ctx;
  const q = ctx.batchId ? `batch=${ctx.batchId}` : `items=${(ctx.itemIds || []).join(',')}`;
  const { text = '' } = await api(`/api/share/text?${q}`);
  $('#shareText').textContent = text;
  openOverlay($('#shareSheet'));

  $('#shCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Select the text and copy it'); }
  };
  $('#shIcs').onclick = () => window.open(`/api/export.ics?${q}`, '_blank');
  $('#shNative').onclick = async () => {
    if (!navigator.share) return toast('Sharing isn\'t available in this browser');
    try { await navigator.share({ title: 'Dates', text }); } catch { /* dismissed */ }
  };
  $('#shLink').onclick = async () => {
    const res = await api('/api/shares', { method: 'POST', body: { batchId: ctx.batchId, itemIds: ctx.itemIds } });
    if (res.error) return toast(res.error);
    const url = `${location.origin}${res.path}.ics`;
    try { await navigator.clipboard.writeText(url); toast('Subscribe link copied'); }
    catch { toast(url); }
  };
}

async function loadShares() {
  const { shares = [] } = await api('/api/shares');
  const list = $('#sharedList');
  if (!shares.length) {
    list.innerHTML = `<div class="empty"><b>Nothing shared</b>Share an import and the link shows up here, with a switch to kill it.</div>`;
    return;
  }
  list.innerHTML = shares.map((s) => `<div class="card">
    <h3>${esc(s.label || 'Shared dates')}</h3>
    <div class="item-meta" style="margin-bottom:10px">
      <span>opened ${s.fetch_count} time${s.fetch_count === 1 ? '' : 's'}</span>
      <span>${new Date(s.created_at).toLocaleDateString()}</span>
    </div>
    <div class="row">
      <button class="btn" data-copy="${s.token}" type="button">Copy link</button>
      <button class="btn ghost" data-revoke="${s.id}" type="button">Stop sharing</button>
    </div>
  </div>`).join('');
  $$('[data-copy]', list).forEach((b) => b.onclick = async () => {
    const url = `${location.origin}/s/${b.dataset.copy}.ics`;
    try { await navigator.clipboard.writeText(url); toast('Copied'); } catch { toast(url); }
  });
  $$('[data-revoke]', list).forEach((b) => b.onclick = async () => {
    await api(`/api/shares/${b.dataset.revoke}/revoke`, { method: 'POST' });
    toast('Link killed');
    loadShares();
  });
}

// ───────────────────────────────────────────────────────── settings

const READER_SHORT = { gemini: 'Gemini', openai: 'OpenAI', fixture: 'a fixture' };
const READER_NAME = { gemini: 'Google Gemini', openai: 'OpenAI', fixture: 'Recorded fixture' };
const READER_HOST = { gemini: 'Google', openai: 'OpenAI' };

async function loadSettings() {
  const s = await api('/api/settings');
  state.settings = s;
  const h = state.health;

  $('#readerStatus').innerHTML = `
    <div class="line"><span class="dot ${h.reader_available ? '' : 'warn'}"></span><div>
      <b>${h.reader_available
        ? `${READER_NAME[h.reader] || esc(h.reader)}${h.reader_model ? ` — ${esc(h.reader_model)}` : ''}`
        : 'No reading key yet'}</b><br>
      <span class="muted">${!h.reader_available
        ? 'Put GEMINI_API_KEY or OPENAI_API_KEY in a .env file next to the app, then restart it. Until then KevCal falls back to reading on this Mac, which is worse on real documents.'
        : h.reader === 'fixture'
          ? 'Test mode: answers come from a recorded file and nothing is uploaded anywhere.'
          : `The page you import is uploaded to ${READER_HOST[h.reader] || 'the reader'} to be read. Nothing else is.`}</span>
    </div></div>
    <div class="line"><span class="dot ${h.ocr ? '' : 'off'}"></span><div>
      <b>Cross-check</b><br><span class="muted">${h.ocr
        ? 'Every date is re-read on this Mac and compared. Disagreements get flagged, never silently resolved.'
        : 'On-device reader not built — run npm run build:tools for the second opinion.'}</span>
    </div></div>
    <div class="line"><span class="dot ${h.locked ? '' : 'warn'}"></span><div>
      <b>${h.locked ? 'Locked' : 'Open to anyone who can reach it'}</b><br>
      <span class="muted">${h.locked
        ? 'Requests need your key. Keep using the link you saved to the home screen.'
        : 'Fine on your own wifi. Set KEVCAL_TOKEN before you put this on a public address.'}</span>
    </div></div>`;

  renderBudget(s);
  renderPrices(s);
  loadFeed();
  $('#tzInput').value = s.timezone || timezone();
  $('#leadDeadline').value = (s.lead_days?.deadline || []).join(', ');
  $('#leadEvent').value = (s.lead_days?.event || []).join(', ');

  $('#installSteps').innerHTML = [
    'Open this page in Safari on your phone.',
    'Tap the Share button, then <b>Add to Home Screen</b>.',
    'Open it from the icon — it runs full screen, like an app.',
  ].map((t) => `<li>${t}</li>`).join('');

  $('#shortcutSteps').innerHTML = [
    'Shortcuts app → <b>+</b> → tap the ⓘ and turn on <b>Show in Share Sheet</b>.',
    'Add <b>Base64 Encode</b> with the Shortcut Input as its input.',
    `Add <b>Get contents of URL</b>: <code>${location.origin}/api/quick</code>, method <code>POST</code>, headers <code>Content-Type: application/json</code>, body <b>JSON</b> with <code>data</code> = the Base64 result, <code>filename</code> = <code>photo.jpg</code>, <code>now</code> = Current Date formatted <code>yyyy-MM-dd'T'HH:mm</code>.`,
    'Add <b>Open URLs</b> with the <code>url</code> value from the response. Name it “KevCal”.',
  ].map((t) => `<li>${t}</li>`).join('');

  const { anchors = [] } = await api('/api/anchors');
  $('#anchorList').innerHTML = anchors.length
    ? `Saved: ${anchors.map((a) => `${esc(a.name)} (week 1 from ${a.week1_start})`).join(', ')}`
    : '';
}

/**
 * The running-cost line under every screen. It shows the per-page estimate and
 * the month's total together, because a per-page figure on its own invites you
 * to forget how many pages there were.
 */
function renderCostbar() {
  const h = state.health || {};
  const c = h.cost || {};
  const bar = $('#costbar');
  if (!h.reader_available) {
    bar.className = 'costbar free';
    bar.innerHTML = '<b>Read on this Mac.</b> <span>Nothing is uploaded, and nothing is charged.</span>';
    bar.hidden = false;
    return;
  }
  const name = READER_SHORT[h.reader] || h.reader;
  const model = h.reader_model ? ' \u00b7 ' + esc(h.reader_model) : '';
  const bits = ['<b>' + esc(name) + model + '</b>'];
  if (c.paused) {
    bar.className = 'costbar over';
    bits.push('<span>' + money(c.spent) + ' of ' + money(c.limit)
      + ' this month \u2014 <b>paused</b>, reading on this Mac</span>');
  } else {
    bar.className = 'costbar';
    bits.push('<span class="sep">\u00b7</span><span>about ' + money(c.per_page) + ' a page</span>');
    bits.push('<span class="sep">\u00b7</span><span>' + money(c.spent)
      + (c.limit != null ? ' of ' + money(c.limit) : '') + ' this month</span>');
  }
  bar.innerHTML = bits.join(' ');
  bar.hidden = false;
}

$('#costbar').addEventListener('click', () => go('settings'));

/** Keep the line honest immediately after an import that spent something. */
async function refreshCost() {
  state.health = await api('/api/health');
  renderCostbar();
}

const money = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  return v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);
};

/**
 * The subscription is the answer to "how do I get these into my actual
 * calendar" — and, more importantly, to "how do I take them out again".
 * webcal:// is what makes a phone offer to subscribe rather than download.
 */
async function loadFeed() {
  const f = await api('/api/feed');
  if (f.error) return;
  const url = location.host + f.path;
  state.feedUrl = location.protocol + '//' + url;
  $('#btnSubscribe').href = 'webcal://' + url;
  $('#feedStatus').innerHTML =
    '<div class="banner"><b>' + f.dates + ' date' + (f.dates === 1 ? '' : 's')
    + '</b> are in this feed right now.'
    + (f.fetch_count
        ? ' Your calendar has picked it up ' + f.fetch_count + ' time' + (f.fetch_count === 1 ? '' : 's') + '.'
        : ' Nothing has subscribed to it yet.')
    + '</div>'
    + '<p class="muted small" style="margin-top:8px">Anyone with this link can read your dates, '
    + 'because a calendar app cannot log in. Treat it like a password; <b>New link</b> kills the old one.</p>';
}

$('#btnCopyFeed').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.feedUrl); toast('Link copied'); }
  catch { toast(state.feedUrl); }
});

$('#btnRotateFeed').addEventListener('click', async () => {
  if (!confirm('Make a new link? Any calendar already subscribed to the old one will stop updating.')) return;
  const f = await api('/api/feed/rotate', { method: 'POST' });
  if (f.error) return toast(f.error);
  toast('New link made — subscribe again on each device');
  loadFeed();
});

function renderPrices(s) {
  const rows = s.prices || [];
  const active = (state.health || {}).reader_model;
  const cell = (n) => '$' + Number(n).toFixed(2);
  const html = rows.map((p) => {
    const isNow = p.model === active;
    return '<div class="r' + (isNow ? ' now' : '') + '">'
      + '<span class="m">' + esc(p.provider) + ' \u00b7 ' + esc(p.model)
      + (isNow ? ' \u2014 in use' : '') + '</span>'
      + '<span class="p">' + money(p.per_page) + '/page</span>'
      + '<span class="p">' + cell(p.in) + '/' + cell(p.out) + ' per Mtok</span>'
      + '</div>';
  }).join('');
  $('#priceTable').innerHTML = '<div class="pricetable">' + html + '</div>'
    + '<p class="muted small" style="margin-top:8px">Rates as published on ' + esc(s.prices_checked || '')
    + '. A page is taken as about 2,500 tokens in and 700 out.</p>';
}

function renderBudget(s) {
  const b = s.budget || {};
  const el = $('#budgetStatus');
  const monthName = new Date(`${b.month || '1970-01'}-01T00:00:00`).toLocaleString(undefined, { month: 'long' });
  const guessed = (s.budget_history || []).length ? '' : '';

  if (b.limit == null) {
    el.innerHTML = `<div class="banner">${money(b.spent)} estimated in ${esc(monthName)} across ${b.calls || 0} read${b.calls === 1 ? '' : 's'}.
      <b>No cap set</b> — KevCal will keep reading however much you import.${guessed}</div>`;
  } else {
    const pct = Math.min(100, Math.round(((b.spent || 0) / b.limit) * 100));
    el.innerHTML = `
      <div class="item-meta" style="margin-bottom:6px">
        <span><b>${money(b.spent)}</b> of ${money(b.limit)} in ${esc(monthName)}</span>
        <span>${b.calls || 0} read${b.calls === 1 ? '' : 's'}</span>
      </div>
      <div class="runway" style="margin-top:0"><i style="width:${pct}%"></i></div>
      ${b.paused
        ? '<div class="banner stop" style="margin-top:10px"><b>Reading is paused.</b> KevCal is falling back to reading on this Mac until next month, or until you raise the cap.</div>'
        : `<p class="muted small" style="margin-top:8px">About ${money(b.next_call_estimate)} per document. Estimated from published prices — treat it as a guard rail, not a bill.</p>`}`;
  }

  $('#budgetInput').value = b.limit == null ? '' : String(b.limit);
  if (s.budget_locked) {
    $('#budgetInput').disabled = true;
    $('#btnSaveBudget').disabled = true;
    $('#btnSaveBudget').textContent = 'Set in .env';
  }
}

$('#btnSaveBudget').addEventListener('click', async () => {
  const raw = $('#budgetInput').value.trim().replace(/^\$/, '');
  const res = await api('/api/settings', {
    method: 'POST',
    body: { monthly_budget: raw === '' ? null : Number(raw) },
  });
  if (res.error) return toast(res.error);
  toast(raw === '' ? 'Cap removed' : 'Capped at ' + money(Number(raw)) + ' a month');
  loadSettings();
});

$('#btnTzDetect').addEventListener('click', () => { $('#tzInput').value = timezone(); });

$('#btnSaveLeads').addEventListener('click', async () => {
  const parse = (v) => v.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  await api('/api/settings', {
    method: 'POST',
    body: {
      lead_days: { deadline: parse($('#leadDeadline').value), event: parse($('#leadEvent').value) },
      timezone: $('#tzInput').value.trim(),
    },
  });
  toast('Saved');
});

$('#btnSaveAnchor').addEventListener('click', async () => {
  const week1 = $('#anchorStart').value;
  if (!week1) return toast('Pick the Monday week 1 starts');
  await api('/api/anchors', {
    method: 'POST',
    body: { name: $('#anchorName').value.trim() || 'Term', week1_start: week1, is_default: true },
  });
  toast('Term saved');
  loadSettings();
});

// ───────────────────────────────────────────────────────── boot

$$('[data-close]').forEach((el) => el.addEventListener('click', () => closeOverlay(el.closest('.sheet-wrap'))));
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = $$('.overlay:not([hidden]), .sheet-wrap:not([hidden])').pop();
  if (open) closeOverlay(open);
});
window.addEventListener('scroll', () => {
  $('#topbar').classList.toggle('stuck', window.scrollY > 4);
}, { passive: true });

$('#readerChip').addEventListener('click', () => go('settings'));

async function boot() {
  state.health = await api('/api/health');
  const chip = $('#readerChip');
  if (state.health.reader_available) {
    chip.textContent = `read by ${READER_SHORT[state.health.reader] || state.health.reader}`;
    chip.classList.add('cloud');
  } else {
    chip.textContent = 'on-device only';
    chip.classList.add('warn');
  }

  renderCostbar();

  // Arriving from the share-sheet Shortcut: go straight to what it found.
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  const b = params.get('b');
  if (b) {
    history.replaceState({}, '', location.pathname);
    const res = await api(`/api/batches/${b}`);
    if (!res.error) { state.lastResponse = {}; showReview(res); }
  }
  go(['dates', 'imports', 'shared', 'settings'].includes(tab) ? tab : 'dates');
}

boot();
