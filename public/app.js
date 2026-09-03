// KevCal front end. No framework, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'capture',
  batch: null,
  items: [],
  sel: new Set(),
  settings: null,
  lastCommit: null,
  focusId: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
function toast(message, actionLabel, onAction, ms = 7000) {
  $('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { el.remove(); onAction?.(); };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------------ tabs

function show(view) {
  state.view = view;
  $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'dates') loadAgenda();
  if (view === 'imports') loadImports();
  if (view === 'settings') loadSettings();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
$$('nav.tabs button').forEach((b) => b.onclick = () => show(b.dataset.view));

// ------------------------------------------------------------------ capture

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function captureFile(file) {
  if (!file) return;
  busy(`Reading ${file.name || 'image'}…`);
  try {
    const data = await fileToBase64(file);
    const result = await api('/api/capture', {
      method: 'POST',
      body: { kind: file.type === 'application/pdf' ? 'pdf' : 'image', filename: file.name || 'capture.png', data },
    });
    renderResult(result);
  } catch (e) {
    $('#captureResult').innerHTML = `<div class="banner warn">Couldn't read that — ${esc(e.message)}</div>`;
  }
}

async function captureText(text) {
  if (!text.trim()) return;
  busy('Looking for dates…');
  try {
    const result = await api('/api/capture', { method: 'POST', body: { kind: 'text', text } });
    renderResult(result);
  } catch (e) {
    $('#captureResult').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
  }
}

function busy(msg) {
  $('#captureResult').innerHTML =
    `<div class="card" style="display:flex;align-items:center;gap:11px">
       <span class="spinner"></span><span class="muted">${esc(msg)}</span>
     </div>`;
}

$('#btnCamera').onclick = () => $('#fileCamera').click();
$('#btnFile').onclick = () => $('#filePicker').click();
$('#fileCamera').onchange = (e) => captureFile(e.target.files[0]);
$('#filePicker').onchange = (e) => captureFile(e.target.files[0]);
$('#btnPasteGo').onclick = () => captureText($('#pasteText').value);

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove('over');
}));
dz.addEventListener('drop', (e) => captureFile(e.dataTransfer.files[0]));

// Screenshot -> Cmd-V -> done. The fastest path on a Mac.
window.addEventListener('paste', (e) => {
  if (state.view !== 'capture') return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); captureFile(item.getAsFile()); return; }
  const text = e.clipboardData?.getData('text');
  if (text && text.trim().length > 12 && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    captureText(text);
  }
});

// ------------------------------------------------------------------ result

function confClass(c) { return c >= 0.8 ? 'hi' : c >= 0.6 ? 'mid' : 'lo'; }

function whenText(i) {
  if (!i.start_date) return 'No date yet';
  let s = i.human_date || i.start_date;
  if (i.end_date && i.end_date !== i.start_date) s += ` → ${i.end_date}`;
  if (i.human_time) s += `, ${i.human_time}`;
  return s;
}

function renderResult(result) {
  state.batch = result.batch;
  state.items = result.items;
  state.sel = new Set();

  const el = $('#captureResult');
  if (!result.items.length) {
    el.innerHTML = `
      <div class="banner warn"><strong>No dates found.</strong></div>
      <p class="muted">${result.ocrError
        ? `The reader couldn't open that file (${esc(result.ocrError)}).`
        : 'Nothing in there looked like a date. Try a clearer photo, or paste the text instead.'}</p>`;
    return;
  }

  const needing = result.items.filter((i) => i.needs_review);
  const fine = result.items.filter((i) => !i.needs_review);
  const fastPath = result.risk === 'low';

  const parts = [];

  if (result.diff) {
    parts.push(`<div class="banner info"><strong>${esc(result.diff.description)}</strong> — this looks like an updated version, so nothing was duplicated.</div>`);
  }

  parts.push(sourceBlock(result));

  parts.push(`<div class="card">
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <span class="bignum" id="foundCount">0</span>
      <span class="muted">${result.items.length === 1 ? 'thing found' : 'things found'}${
        needing.length ? ` · <strong style="color:var(--due)">${needing.length} need${needing.length === 1 ? 's' : ''} a look</strong>` : ''}</span>
    </div>
    <p class="muted" style="margin:0">${fastPath
      ? 'These all look clear. Have a glance and add them.'
      : 'The uncertain ones are at the top. The rest are folded away.'}</p>
  </div>`);

  parts.push('<div id="itemList"></div>');
  parts.push(`<div class="actions" style="margin-top:14px;justify-content:flex-start">
    <button class="btn primary big" id="btnCommit">Add ${result.items.length} to my calendar</button>
    <button class="btn" id="btnDiscard">Discard</button>
  </div>`);

  el.innerHTML = parts.join('');
  renderItemList();
  countUp($('#foundCount'), result.items.length);

  $('#btnCommit').onclick = commitCurrent;
  $('#btnDiscard').onclick = async () => {
    await api(`/api/batches/${state.batch.id}`, { method: 'DELETE' });
    el.innerHTML = '';
    toast('Discarded.');
  };
}

function sourceBlock(result) {
  if (state.batch.source_kind === 'text') return '';
  const boxes = result.items.filter((i) => i.bbox).map((i, n) => {
    const [x, y, w, h] = i.bbox;
    return `<rect data-id="${i.id}" class="${i.kind === 'deadline' ? 'due' : ''}"
      x="${(x * 100).toFixed(2)}" y="${(y * 100).toFixed(2)}"
      width="${(w * 100).toFixed(2)}" height="${(h * 100).toFixed(2)}"
      rx="0.6" style="animation-delay:${n * 55}ms"></rect>`;
  }).join('');
  return `<div class="source-wrap" id="sourceWrap">
    <img src="/api/source/${state.batch.id}" alt="The document you captured">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">${boxes}</svg>
  </div>`;
}

function countUp(el, target) {
  if (!el) return;
  let n = 0;
  const step = Math.max(1, Math.round(target / 14));
  const t = setInterval(() => {
    n = Math.min(target, n + step);
    el.textContent = n;
    if (n >= target) clearInterval(t);
  }, 28);
}

function renderItemList() {
  const list = $('#itemList');
  if (!list) return;
  const needing = state.items.filter((i) => i.needs_review);
  const fine = state.items.filter((i) => !i.needs_review);

  let html = '';
  if (needing.length) html += needing.map(itemRow).join('');
  if (fine.length) {
    html += needing.length
      ? `<details class="collapsed-ok"><summary>${fine.length} look fine</summary>${fine.map(itemRow).join('')}</details>`
      : fine.map(itemRow).join('');
  }
  list.innerHTML = html + bulkBar();
  wireItems(list);
}

function itemRow(i) {
  const sel = state.sel.has(i.id);
  const rec = i.recurrence;
  return `<div class="item ${i.needs_review ? 'review' : ''} ${sel ? 'selected' : ''} ${i.satisfied ? 'satisfied' : ''}" data-id="${i.id}">
    <div class="item-head">
      <div class="check" data-act="select">✓</div>
      <div class="item-main">
        <div class="title">${esc(i.title)}</div>
        <div class="when">${esc(whenText(i))}${i.location ? ` · ${esc(i.location)}` : ''}</div>
        <div class="meta">
          <span class="conf ${confClass(i.confidence)}"></span>
          <span class="chip ${i.kind === 'deadline' ? 'due' : 'evt'}">${i.kind === 'deadline' ? 'Deadline' : 'Event'}</span>
          ${i.needs_review ? '<span class="chip low">Needs a look</span>' : ''}
          ${rec ? `<span class="chip rec">repeats? “${esc(rec.phrase || '')}”</span>` : ''}
          ${i.cost ? `<span class="chip">${esc(i.cost)}</span>` : ''}
          <button class="btn tiny ghost" data-act="expand">Edit</button>
        </div>
        ${i.question ? `<div class="provenance" style="border-color:var(--due)"><b>${esc(i.question)}</b></div>` : ''}
      </div>
    </div>
  </div>`;
}

function itemEditor(i) {
  const rec = i.recurrence;
  return `<div class="item-body">
    <div class="field-row">
      <div class="field" style="flex:1 1 100%"><label>Title</label>
        <input data-f="title" value="${esc(i.title)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" data-f="start_date" value="${esc(i.start_date || '')}"></div>
      <div class="field"><label>Time</label><input type="time" data-f="start_time" value="${esc(i.start_time || '')}"></div>
      <div class="field"><label>Ends</label><input type="time" data-f="end_time" value="${esc(i.end_time || '')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Type</label>
        <select data-f="kind">
          <option value="event"${i.kind === 'event' ? ' selected' : ''}>Event</option>
          <option value="deadline"${i.kind === 'deadline' ? ' selected' : ''}>Deadline</option>
        </select></div>
      <div class="field"><label>Where</label><input data-f="location" value="${esc(i.location || '')}"></div>
    </div>
    ${i.notes ? `<div class="field"><label>Notes</label><textarea data-f="notes" rows="2">${esc(i.notes)}</textarea></div>` : ''}
    ${rec ? `<div class="provenance">
      <b>This might repeat.</b> The document said “${esc(rec.phrase || '')}”.
      KevCal has <b>not</b> made it repeat — a wrong repeat is worse than none.
      <div class="actions" style="justify-content:flex-start;margin-top:8px">
        <button class="btn tiny" data-act="repeat">Make it repeat…</button>
      </div></div>` : ''}
    <div class="provenance">
      <b>Where this came from</b><br>
      ${i.src_interpretation ? `${esc(i.src_interpretation)}<br>` : ''}
      ${i.src_raw ? `<span class="raw">“${esc(i.src_raw)}”</span>` : '<span class="raw">typed in by hand</span>'}
    </div>
    <div class="actions" style="justify-content:flex-start;margin-top:10px">
      <button class="btn tiny primary" data-act="save">Save</button>
      <button class="btn tiny danger" data-act="delete">Delete</button>
    </div>
  </div>`;
}

function bulkBar() {
  if (!state.sel.size) return '';
  return `<div class="bulkbar">
    <span class="count">${state.sel.size} selected</span>
    <button class="btn tiny" data-bulk="shift" data-days="7">+1 week</button>
    <button class="btn tiny" data-bulk="shift" data-days="-7">−1 week</button>
    <button class="btn tiny" data-bulk="shift" data-days="1">+1 day</button>
    <button class="btn tiny" data-bulk="shift" data-days="-1">−1 day</button>
    <button class="btn tiny" data-bulk="deadline">Mark deadline</button>
    <button class="btn tiny" data-bulk="review">Looks right</button>
    <button class="btn tiny danger" data-bulk="delete">Delete</button>
    <button class="btn tiny ghost" data-bulk="clear">Clear</button>
  </div>`;
}

function wireItems(root) {
  $$('.item', root).forEach((row) => {
    const id = row.dataset.id;
    const item = state.items.find((x) => x.id === id);
    if (!item) return;

    row.querySelector('[data-act="select"]').onclick = (e) => {
      e.stopPropagation();
      state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
      renderItemList();
    };

    row.querySelector('[data-act="expand"]').onclick = (e) => {
      e.stopPropagation();
      const open = row.querySelector('.item-body');
      if (open) { open.remove(); return; }
      row.insertAdjacentHTML('beforeend', itemEditor(item));
      wireEditor(row, item);
    };

    row.querySelector('.item-head').onclick = () => focusBox(id);
  });

  $$('[data-bulk]', root).forEach((b) => b.onclick = () => runBulk(b.dataset.bulk, b.dataset.days));
}

function wireEditor(row, item) {
  const body = row.querySelector('.item-body');
  body.querySelector('[data-act="save"]').onclick = async () => {
    const patch = {};
    $$('[data-f]', body).forEach((f) => { patch[f.dataset.f] = f.value || null; });
    patch.all_day = patch.start_time ? 0 : 1;
    const { item: updated } = await api(`/api/items/${item.id}`, { method: 'PATCH', body: patch });
    Object.assign(item, updated);
    renderItemList();
    toast('Saved.');
  };
  body.querySelector('[data-act="delete"]').onclick = async () => {
    await api('/api/items/bulk', { method: 'POST', body: { ids: [item.id], op: 'delete' } });
    state.items = state.items.filter((x) => x.id !== item.id);
    renderItemList();
    toast('Deleted.');
  };
  body.querySelector('[data-act="repeat"]')?.addEventListener('click', () => askRepeat(item));
}

/** A repeat is never created without an explicit end — we do not extrapolate. */
async function askRepeat(item) {
  const until = prompt(
    'Repeat until which date? (YYYY-MM-DD)\n\n' +
    'KevCal needs an end date — it will not invent repeats that run forever.',
    item.start_date || '');
  if (!until) return;
  try {
    await api(`/api/items/${item.id}/recurrence`, { method: 'POST', body: { accept: true, until } });
    toast('Repeat set.');
  } catch (e) { toast(e.message); }
}

function focusBox(id) {
  state.focusId = id;
  const rects = $$('#sourceWrap rect');
  if (!rects.length) return;
  rects.forEach((r) => {
    r.classList.toggle('focus', r.dataset.id === id);
    r.classList.toggle('dim', r.dataset.id !== id);
  });
  const target = rects.find((r) => r.dataset.id === id);
  if (target) $('#sourceWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runBulk(op, days) {
  const ids = [...state.sel];
  if (!ids.length) return;
  if (op === 'clear') { state.sel = new Set(); return renderItemList(); }
  const map = {
    shift: { op: 'shift_days', days: Number(days) },
    deadline: { op: 'set_kind', kind: 'deadline' },
    review: { op: 'review' },
    delete: { op: 'delete' },
  };
  await api('/api/items/bulk', { method: 'POST', body: { ids, ...map[op] } });
  if (op === 'delete') {
    state.items = state.items.filter((i) => !state.sel.has(i.id));
    state.sel = new Set();
  } else {
    const { items } = await api(`/api/batches/${state.batch.id}`);
    state.items = items;
  }
  renderItemList();
  toast(op === 'shift' ? `Moved ${ids.length} by ${days} day${Math.abs(days) === 1 ? '' : 's'}.` : 'Done.');
}

async function commitCurrent() {
  try {
    const r = await api(`/api/batches/${state.batch.id}/commit`, { method: 'POST' });
    const batchId = state.batch.id;
    state.lastCommit = batchId;
    $('#captureResult').innerHTML = `
      <div class="banner good">
        <strong>Added ${r.committed}.</strong> They're in your Dates list.
      </div>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn primary" id="btnOpenCal">Add to Apple Calendar</button>
        <button class="btn" id="btnShareNow">Share these</button>
        <button class="btn ghost" id="btnUndoNow">Undo the whole import</button>
      </div>`;
    $('#btnOpenCal').onclick = () => openInCalendar(batchId);
    $('#btnShareNow').onclick = () => openShare(batchId);
    $('#btnUndoNow').onclick = () => undoBatch(batchId, true);
    toast(`Added ${r.committed}.`, 'Undo', () => undoBatch(batchId, true));
  } catch (e) {
    if (e.status === 409) {
      toast(e.data.message || 'Some items still need checking.');
      const first = $('.item.review [data-act="expand"]');
      first?.click();
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else toast(e.message);
  }
}

async function openInCalendar(batchId) {
  try {
    const r = await api('/api/open-ics', { method: 'POST', body: { batchId } });
    toast(r.ok ? `Opening ${r.count} in your calendar…` : 'Download the .ics instead.');
    if (!r.ok) window.location = `/api/export.ics?batch=${batchId}`;
  } catch (e) { toast(e.message); }
}

async function undoBatch(batchId, fromCapture) {
  const r = await api(`/api/batches/${batchId}/undo`, { method: 'POST' });
  toast(`Removed ${r.removed}.`, 'Put them back', async () => {
    await api(`/api/batches/${batchId}/redo`, { method: 'POST' });
    toast('Restored.');
    if (state.view === 'imports') loadImports();
    if (state.view === 'dates') loadAgenda();
  });
  if (fromCapture) $('#captureResult').innerHTML = '<div class="banner info">Import undone.</div>';
  if (state.view === 'imports') loadImports();
  if (state.view === 'dates') loadAgenda();
}

// ------------------------------------------------------------------ dates

async function loadAgenda() {
  const { items } = await api('/api/agenda');
  const el = $('#datesContent');
  if (!items.length) {
    el.innerHTML = `<div class="empty"><span class="glyph">🗓️</span>Nothing in here yet.<br>
      <span class="muted">Capture something and it'll show up.</span></div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const dated = items.filter((i) => i.start_date);
  const undated = items.filter((i) => !i.start_date);

  let html = '';
  let month = '';
  for (const i of dated) {
    const m = i.start_date.slice(0, 7);
    if (m !== month) {
      month = m;
      const d = new Date(`${m}-01T00:00:00Z`);
      html += `<div class="month-head">${d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>`;
    }
    html += agendaRow(i, today);
  }
  if (undated.length) {
    html += `<div class="month-head">Waiting on a date</div>`;
    html += undated.map((i) => agendaRow(i, today)).join('');
  }
  el.innerHTML = html;

  $$('[data-satisfy]', el).forEach((b) => b.onclick = async () => {
    const id = b.dataset.satisfy;
    const item = items.find((x) => x.id === id);
    await api('/api/items/bulk', { method: 'POST', body: { ids: [id], op: item.satisfied ? 'unsatisfy' : 'satisfy' } });
    loadAgenda();
  });
  requestAnimationFrame(() => $$('.runway i', el).forEach((b) => { b.style.width = b.dataset.w; }));
}

function agendaRow(i, today) {
  const day = i.start_date ? i.start_date.slice(8, 10) : '—';
  const mon = i.start_date
    ? new Date(`${i.start_date}T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
    : '';
  const isToday = i.start_date === today;
  const overdue = i.days_left != null && i.days_left < 0 && !i.satisfied;
  const runway = i.kind === 'deadline' && i.runway != null && !i.satisfied
    ? `<div class="runway ${overdue ? 'past' : ''}"><i data-w="${Math.round(i.runway * 100)}%" style="width:0"></i></div>` : '';
  const left = i.days_left == null ? ''
    : i.days_left === 0 ? 'today'
    : i.days_left > 0 ? `in ${i.days_left} day${i.days_left === 1 ? '' : 's'}`
    : `${Math.abs(i.days_left)} day${Math.abs(i.days_left) === 1 ? '' : 's'} ago`;

  return `<div class="item ${i.satisfied ? 'satisfied' : ''}">
    <div class="item-head">
      <div class="day-badge ${isToday ? 'today' : ''}"><div class="d">${day}</div><div class="m">${mon}</div></div>
      <div class="item-main">
        <div class="title">${esc(i.title)}</div>
        <div class="when">${i.human_time ? esc(i.human_time) + ' · ' : ''}${esc(left)}${i.location ? ' · ' + esc(i.location) : ''}</div>
        ${runway}
        <div class="meta">
          <span class="chip ${i.kind === 'deadline' ? 'due' : 'evt'}">${i.kind === 'deadline' ? 'Deadline' : 'Event'}</span>
          ${i.satisfied ? '<span class="chip ok">Sorted</span>' : ''}
          ${i.batch_title ? `<span class="chip">${esc(i.batch_title)}</span>` : ''}
          ${i.kind === 'deadline'
            ? `<button class="btn tiny" data-satisfy="${i.id}">${i.satisfied ? 'Not done after all' : 'Mark sorted'}</button>`
            : ''}
        </div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ imports

async function loadImports() {
  const { batches } = await api('/api/batches');
  const el = $('#importsContent');
  if (!batches.length) {
    el.innerHTML = `<div class="empty"><span class="glyph">📥</span>No imports yet.</div>`;
    return;
  }
  el.innerHTML = `<div class="card">${batches.map((b) => {
    const when = new Date(b.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const undone = b.status === 'undone';
    const thumb = b.source_path
      ? `<img class="thumb" src="/api/source/${b.id}" alt="">`
      : `<div class="thumb glyph">📝</div>`;
    return `<div class="batch-row">
      ${thumb}
      <div style="flex:1;min-width:0">
        <div class="title" style="font-weight:570">${esc(b.title)}</div>
        <div class="muted" style="font-size:12.5px">
          ${when} · ${b.item_count} found${b.accepted_count ? `, ${b.accepted_count} added` : ''}
          ${undone ? ' · <span style="color:var(--warn)">undone</span>' : ''}
        </div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn tiny" data-share="${b.id}">Share</button>
        <button class="btn tiny" data-${undone ? 'redo' : 'undo'}="${b.id}">${undone ? 'Restore' : 'Undo'}</button>
        <button class="btn tiny danger" data-del="${b.id}">Delete</button>
      </div>
    </div>`;
  }).join('')}</div>`;

  $$('[data-share]', el).forEach((b) => b.onclick = () => openShare(b.dataset.share));
  $$('[data-undo]', el).forEach((b) => b.onclick = () => undoBatch(b.dataset.undo));
  $$('[data-redo]', el).forEach((b) => b.onclick = async () => {
    await api(`/api/batches/${b.dataset.redo}/redo`, { method: 'POST' });
    loadImports(); toast('Restored.');
  });
  $$('[data-del]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this import and its original image for good?')) return;
    await api(`/api/batches/${b.dataset.del}`, { method: 'DELETE' });
    loadImports(); toast('Deleted.');
  });
}

// ------------------------------------------------------------------ share

let shareBatchId = null;
async function openShare(batchId) {
  shareBatchId = batchId;
  const { text } = await api(`/api/share/text?batch=${batchId}`);
  $('#shareText').textContent = text;
  $('#shareDialog').showModal();
}
$('#btnCloseShare').onclick = () => $('#shareDialog').close();
$('#btnCopyText').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#shareText').textContent);
    toast('Copied — paste it anywhere.');
  } catch {
    const r = document.createRange();
    r.selectNode($('#shareText'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    toast('Selected — press ⌘C.');
  }
};
$('#btnShareIcs').onclick = () => { window.location = `/api/export.ics?batch=${shareBatchId}`; };
$('#btnShareImage').onclick = () => renderShareImage($('#shareText').textContent);

/** An image of the list is what people actually forward in a group chat. */
function renderShareImage(text) {
  const lines = text.split('\n');
  const pad = 44, lh = 30, width = 900;
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = (pad * 2 + lines.length * lh + 40) * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(0, 0, width, canvas.height / scale);
  ctx.fillStyle = '#2f6fd0';
  ctx.fillRect(0, 0, 6, canvas.height / scale);

  let y = pad + 10;
  lines.forEach((line, idx) => {
    const isTitle = idx === 0;
    const isRule = /^[─-]+$/.test(line.trim());
    if (isRule) { y += 6; return; }
    const due = line.startsWith('DUE: ');
    const indented = line.startsWith('  ');
    ctx.fillStyle = isTitle ? '#1b1a17' : due ? '#c2620d' : indented ? '#56534c' : '#1b1a17';
    ctx.font = isTitle
      ? '700 26px ui-sans-serif, -apple-system, system-ui, sans-serif'
      : `${indented ? '400 16px' : '600 18px'} ui-sans-serif, -apple-system, system-ui, sans-serif`;
    ctx.fillText(line.replace(/^ {2}/, '   '), pad, y);
    y += isTitle ? lh + 8 : lh;
  });
  ctx.fillStyle = '#8b877e';
  ctx.font = '400 13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('Made with KevCal', pad, y + 14);

  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dates.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Image saved.');
  }, 'image/png');
}

// ------------------------------------------------------------------ settings

async function loadSettings() {
  const s = await api('/api/settings');
  state.settings = s;
  $('#leadDeadline').value = (s.lead_days?.deadline || []).join(', ');
  $('#leadEvent').value = (s.lead_days?.event || []).join(', ');

  const aiOn = s.ai_enabled;
  $('#privacyText').innerHTML = `Everything is stored on this Mac, in <span class="raw">${esc(s.data_dir)}</span>.
    There's no account and no sign-in. Deleting an import deletes its original image too.
    ${aiOn
      ? '<br><br><strong style="color:var(--due)">AI reading is on</strong> — the image you import is sent to api.anthropic.com to be read. Nothing else leaves this machine.'
      : '<br><br><strong style="color:var(--good)">Nothing leaves this machine.</strong> Images are read on-device by macOS.'}`;

  $('#aiChip').textContent = aiOn ? 'on' : 'off';
  $('#aiText').textContent = s.ai_available
    ? (aiOn
      ? 'On. Messy layouts are read by Claude, which means the image is sent to Anthropic. Turn it off to stay entirely on-device.'
      : 'An API key is set, so you can switch this on for harder documents — grids, dense tables, bad handwriting. Off means nothing leaves your Mac.')
    : 'No API key set, so KevCal reads everything on-device. That works well for letters, posters and most tables. To enable the AI tier, set ANTHROPIC_API_KEY and restart.';
  const btn = $('#btnToggleAI');
  btn.hidden = !s.ai_available;
  btn.textContent = aiOn ? 'Turn off (stay on-device)' : 'Turn on AI reading';
  btn.onclick = async () => {
    await api('/api/settings', { method: 'POST', body: { ai_enabled: !aiOn } });
    loadSettings();
    updatePill();
  };

  const { anchors } = await api('/api/anchors');
  $('#anchorList').innerHTML = anchors.length
    ? anchors.map((a) => `${esc(a.name)} — week 1 begins ${esc(a.week1_start)}${a.is_default ? ' (default)' : ''}`).join('<br>')
    : 'No terms saved yet.';
}

$('#btnSaveLeads').onclick = async () => {
  const parse = (v) => v.split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isFinite(n));
  await api('/api/settings', { method: 'POST', body: {
    lead_days: { deadline: parse($('#leadDeadline').value), event: parse($('#leadEvent').value) },
  } });
  toast('Saved.');
};

$('#btnSaveAnchor').onclick = async () => {
  const week1 = $('#anchorStart').value;
  if (!week1) return toast('Pick the Monday that week 1 starts.');
  await api('/api/anchors', { method: 'POST', body: {
    name: $('#anchorName').value || 'Term',
    week1_start: week1,
    skip_weeks: $('#anchorSkips').value.split(',').map((s) => s.trim()).filter(Boolean),
    is_default: true,
  } });
  toast('Term saved — “Wk 7 (Fri)” will resolve now.');
  loadSettings();
};

async function updatePill() {
  try {
    const h = await api('/api/health');
    const pill = $('#privacyPill');
    const cloud = h.ai_enabled && h.ai_key_present;
    pill.textContent = cloud ? 'AI reading on' : 'on-device';
    pill.className = `pill ${cloud ? 'cloud' : 'local'}`;
    pill.title = cloud
      ? 'Imported images are sent to Anthropic to be read.'
      : 'Images are read on your Mac. Nothing leaves it.';
  } catch { /* server not up yet */ }
}

updatePill();
