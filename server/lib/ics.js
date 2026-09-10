// iCalendar output. This is the universal escape hatch: it reaches Apple
// Calendar, Outlook and Google without an account, an OAuth grant, or the
// recipient installing anything — which is what every persona actually needed.
//
// v2 fixes the floating-time bug. A timed event used to be written with no zone
// at all, so a shared .ics landed at the wrong hour for anyone in a different
// one. Times are now converted to a real instant in the capturing device's zone
// and written as UTC, which every calendar app renders back correctly.

const CRLF = '\r\n';

function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** RFC 5545 says fold at 75 octets; fold on bytes, not characters. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Do not split a multi-byte character.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join(`${CRLF} `);
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const dateOnly = (isoDate) => isoDate.replace(/-/g, '');

/** How far the given zone was from UTC at that instant, in minutes. */
function offsetMinutes(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const asIfUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day),
                           hour, Number(map.minute), Number(map.second));
  return (asIfUTC - instant.getTime()) / 60000;
}

/**
 * A wall-clock time in a named zone to the actual instant it names.
 * Applied twice because the offset itself depends on the instant, which is what
 * makes the hour either side of a clock change come out right.
 */
export function zonedToUTC(isoDate, hhmm, tz) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = wall - offsetMinutes(new Date(wall), tz) * 60000;
  ts = wall - offsetMinutes(new Date(ts), tz) * 60000;
  return new Date(ts);
}

function validTZ(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  catch { return null; }
}

function localDateTime(isoDate, hhmm) {
  return `${dateOnly(isoDate)}T${hhmm.replace(':', '')}00`;
}

function timedStamp(isoDate, hhmm, tz) {
  if (!tz) return localDateTime(isoDate, hhmm);   // floating, last resort
  return stamp(zonedToUTC(isoDate, hhmm, tz));
}

function addOneDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function alarmsFor(item, leadDays) {
  const days = Array.isArray(leadDays) ? leadDays : [];
  return days.map((d) => {
    const trigger = d === 0
      ? (item.all_day ? '-PT9H' : '-PT30M')   // morning-of for all-day items
      : `-P${d}D`;
    const label = d === 0 ? 'Today' : `${d} day${d === 1 ? '' : 's'} to go`;
    return [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:${trigger}`,
      `DESCRIPTION:${esc(`${label} — ${item.title}`)}`,
      'END:VALARM',
    ];
  }).flat();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function itemToVEvent(item, { leadDays = [], domain = 'kevcal.local', tz = null } = {}) {
  // A single corrupt row must never take the whole calendar export down with it.
  if (!item.start_date || !ISO_DATE.test(item.start_date)) return null;
  if (item.end_date && !ISO_DATE.test(item.end_date)) return null;
  if (Number.isNaN(new Date(`${item.start_date}T00:00:00Z`).getTime())) return null;
  const zone = validTZ(tz);
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${item.id || item.fingerprint}@${domain}`);
  lines.push(`DTSTAMP:${stamp()}`);

  if (item.all_day || !item.start_time) {
    // All-day entries are deliberately zoneless: a school trip on the 12th is on
    // the 12th wherever you read it.
    const end = item.end_date ? addOneDay(item.end_date) : addOneDay(item.start_date);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(item.start_date)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(end)}`);
  } else {
    const endDate = item.end_date || item.start_date;
    const endTime = item.end_time || item.start_time;
    lines.push(`DTSTART:${timedStamp(item.start_date, item.start_time, zone)}`);
    lines.push(`DTEND:${timedStamp(endDate, endTime, zone)}`);
  }

  const prefix = item.kind === 'deadline' ? 'DUE: ' : '';
  const done = item.satisfied ? ' ✓' : '';
  lines.push(`SUMMARY:${esc(prefix + item.title + done)}`);

  const desc = [];
  if (item.notes) desc.push(item.notes);
  if (item.cost) desc.push(`Cost: ${item.cost}`);
  if (item.owner) desc.push(`Owner: ${item.owner}`);
  if (item.src_interpretation) desc.push(`Read as: ${item.src_interpretation}`);
  if (item.src_raw) desc.push(`Source text: "${item.src_raw}"`);
  desc.push('Added by KevCal');
  lines.push(`DESCRIPTION:${esc(desc.join('\n'))}`);

  if (item.location) lines.push(`LOCATION:${esc(item.location)}`);
  if (item.kind === 'deadline') lines.push('CATEGORIES:DEADLINE');
  if (item.satisfied) lines.push('STATUS:CONFIRMED');

  // Only ever emitted when the user explicitly accepted the suggestion (R1).
  if (item.recurrence_accepted && item.rrule) lines.push(`RRULE:${item.rrule}`);

  if (!item.satisfied) lines.push(...alarmsFor(item, leadDays));
  lines.push('END:VEVENT');
  return lines;
}

export function buildICS(items, opts = {}) {
  const {
    calName = 'KevCal',
    leadDaysFor = () => [],
    domain = 'kevcal.local',
    tz = null,
  } = opts;

  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KevCal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
    `NAME:${esc(calName)}`,
  ];
  const zone = validTZ(tz);
  if (zone) out.push(`X-WR-TIMEZONE:${esc(zone)}`);

  for (const item of items) {
    const ve = itemToVEvent(item, { leadDays: leadDaysFor(item), domain, tz: zone });
    if (ve) out.push(...ve);
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join(CRLF) + CRLF;
}
