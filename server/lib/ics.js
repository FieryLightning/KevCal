// iCalendar output. This is the universal escape hatch: it reaches Apple
// Calendar, Outlook and Google without an account, an OAuth grant, or the
// recipient installing anything — which is what every persona actually needed.

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

function localDateTime(isoDate, hhmm) {
  return `${dateOnly(isoDate)}T${hhmm.replace(':', '')}00`;
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

export function itemToVEvent(item, { leadDays = [], domain = 'kevcal.local' } = {}) {
  // A single corrupt row must never take the whole calendar export down with it.
  if (!item.start_date || !ISO_DATE.test(item.start_date)) return null;
  if (item.end_date && !ISO_DATE.test(item.end_date)) return null;
  if (Number.isNaN(new Date(`${item.start_date}T00:00:00Z`).getTime())) return null;
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${item.id || item.fingerprint}@${domain}`);
  lines.push(`DTSTAMP:${stamp()}`);

  if (item.all_day || !item.start_time) {
    const end = item.end_date ? addOneDay(item.end_date) : addOneDay(item.start_date);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(item.start_date)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(end)}`);
  } else {
    lines.push(`DTSTART:${localDateTime(item.start_date, item.start_time)}`);
    const endDate = item.end_date || item.start_date;
    const endTime = item.end_time || item.start_time;
    lines.push(`DTEND:${localDateTime(endDate, endTime)}`);
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

  for (const item of items) {
    const ve = itemToVEvent(item, { leadDays: leadDaysFor(item), domain });
    if (ve) out.push(...ve);
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join(CRLF) + CRLF;
}
