// Date primitives. Deliberately dependency-free and UK-first (day-before-month),
// because every research persona was working from UK documents.

export const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export const DOW = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD for a UTC-anchored date. All internal dates are date-only strings. */
export function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

export function toDate(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromDate(dt) {
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(isoStr, n) {
  const dt = toDate(isoStr);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromDate(dt);
}

export function dayOfWeek(isoStr) { return toDate(isoStr).getUTCDay(); }

export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

export function isValidYMD(y, m, d) {
  if (!(y >= 1970 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function today() { return fromDate(new Date()); }

/**
 * A document that says "5 June" with no year means the next 5 June, not a random one.
 * Window skews slightly into the past so a letter read a fortnight late still resolves.
 */
export function inferYear(month, day, reference = today()) {
  const refYear = Number(reference.slice(0, 4));
  const candidates = [refYear - 1, refYear, refYear + 1]
    .filter((y) => isValidYMD(y, month, day))
    .map((y) => ({ y, delta: daysBetween(reference, iso(y, month, day)) }));
  const forward = candidates.filter((c) => c.delta >= -45).sort((a, b) => a.delta - b.delta);
  if (forward.length) return forward[0].y;
  return candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0]?.y ?? refYear;
}

/** Two-digit years: 26 -> 2026. */
export function expandYear(raw) {
  const n = Number(raw);
  if (raw.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

/** Monday of the week containing the given date (ISO weeks start Monday). */
export function mondayOf(isoStr) {
  const dow = dayOfWeek(isoStr);
  return addDays(isoStr, dow === 0 ? -6 : 1 - dow);
}

/** The next given weekday on or after a date. */
export function nextDow(isoStr, targetDow) {
  const cur = dayOfWeek(isoStr);
  return addDays(isoStr, (targetDow - cur + 7) % 7);
}

export function formatHuman(isoStr, { withDow = true, withYear = true } = {}) {
  const [y, m, d] = isoStr.split('-').map(Number);
  const parts = [];
  if (withDow) parts.push(DOW_NAMES[dayOfWeek(isoStr)]);
  parts.push(String(d));
  parts.push(MONTH_NAMES[m - 1]);
  if (withYear) parts.push(String(y));
  return parts.join(' ');
}

export function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${pad(m)}${ampm}`;
}

export function normaliseTime(hour, minute, meridiem) {
  let h = Number(hour);
  const m = Number(minute ?? 0);
  if (meridiem) {
    const mer = meridiem.toLowerCase().replace(/\./g, '');
    // A 12-hour clock cannot say '13pm'; refuse rather than guess.
    if (h > 12 || h < 1) return null;
    if (mer.startsWith('p') && h < 12) h += 12;
    if (mer.startsWith('a') && h === 12) h = 0;
  }
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** UK bank-holiday-agnostic working-day math: Mon-Fri minus supplied holidays. */
export function isWorkingDay(isoStr, holidays = []) {
  const d = dayOfWeek(isoStr);
  return d !== 0 && d !== 6 && !holidays.includes(isoStr);
}

export function addWorkingDays(isoStr, n, holidays = []) {
  let cur = isoStr;
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    cur = addDays(cur, step);
    if (isWorkingDay(cur, holidays)) remaining--;
  }
  return cur;
}
