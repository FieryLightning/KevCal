// Reconciling a re-issued document against what was already imported.
//
// Research called this the actual product: "A tool that only does one-time
// imports gives me two parents' evenings and no idea which is live." So a
// re-import never wipes and recreates — it matches, then reports what moved,
// and user edits survive.

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Token-overlap similarity; good enough to survive OCR wobble and rewording. */
export function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

function daysApart(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);
}

/**
 * Score a candidate pairing. An identical title on a different date is the
 * signal that something MOVED — which is precisely the amendment case.
 */
function matchScore(oldItem, newItem) {
  if (oldItem.fingerprint && oldItem.fingerprint === newItem.fingerprint) return 1;
  const titleSim = similarity(oldItem.title, newItem.title);
  const gap = daysApart(oldItem.start_date, newItem.start_date);
  const sameDate = gap === 0;

  if (titleSim >= 0.6 && (sameDate || gap <= 400)) {
    return 0.5 + 0.4 * titleSim + (sameDate ? 0.1 : 0);
  }
  // Different wording, same date and time — likely the same thing re-described.
  if (sameDate && oldItem.start_time === newItem.start_time && titleSim >= 0.3) {
    return 0.55 + 0.2 * titleSim;
  }
  return 0;
}

const COMPARED = ['title', 'start_date', 'start_time', 'end_date', 'end_time', 'location', 'kind', 'all_day'];

export function fieldChanges(oldItem, newItem) {
  const changes = [];
  for (const f of COMPARED) {
    const a = oldItem[f] ?? null;
    const b = newItem[f] ?? null;
    if (String(a ?? '') !== String(b ?? '')) changes.push({ field: f, from: a, to: b });
  }
  return changes;
}

/**
 * @returns { added, changed, conflicts, removed, unchanged } where `changed`
 * carries the field-level delta so the UI can say "moved from 12 March to 19 March".
 *
 * A change that would overwrite something the user edited by hand is NOT reported
 * as a change — it goes to `conflicts`, which is surfaced but never auto-applied.
 * Re-issuing a document must not silently revert a correction someone made.
 */
export function diffItems(oldItems, newItems, { threshold = 0.55 } = {}) {
  const pairs = [];
  for (const o of oldItems) {
    for (const n of newItems) {
      const s = matchScore(o, n);
      if (s >= threshold) pairs.push({ o, n, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);

  const usedOld = new Set();
  const usedNew = new Set();
  const matched = [];
  for (const p of pairs) {
    if (usedOld.has(p.o.id ?? p.o.fingerprint) || usedNew.has(p.n.fingerprint)) continue;
    usedOld.add(p.o.id ?? p.o.fingerprint);
    usedNew.add(p.n.fingerprint);
    matched.push(p);
  }

  const changed = [];
  const conflicts = [];
  const unchanged = [];
  for (const { o, n, s } of matched) {
    const changes = fieldChanges(o, n);
    if (!changes.length) unchanged.push({ before: o, after: n });
    else if (o.user_edited) conflicts.push({ before: o, after: n, changes, score: s });
    else changed.push({ before: o, after: n, changes, score: s });
  }

  const added = newItems.filter((n) => !usedNew.has(n.fingerprint));
  const removed = oldItems.filter((o) => !usedOld.has(o.id ?? o.fingerprint));

  return {
    added, changed, conflicts, removed, unchanged,
    summary: {
      added: added.length,
      changed: changed.length,
      conflicts: conflicts.length,
      removed: removed.length,
      unchanged: unchanged.length,
    },
  };
}

/** Human sentence for the diff banner. */
export function describeDiff(d) {
  const bits = [];
  if (d.summary.changed) bits.push(`${d.summary.changed} changed`);
  if (d.summary.added) bits.push(`${d.summary.added} added`);
  if (d.summary.removed) bits.push(`${d.summary.removed} no longer listed`);
  if (d.summary.conflicts) {
    bits.push(`${d.summary.conflicts} you'd edited by hand (left alone)`);
  }
  if (!bits.length) return 'Nothing has changed since the last version.';
  return bits.join(', ');
}
