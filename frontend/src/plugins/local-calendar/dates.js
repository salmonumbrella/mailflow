export const addDays = (day, amount) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
export const dateLabel = (day, options = {}, locale) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
export function wallTime(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
// Display only: wall-time conversion and native datetime inputs retain their 24-hour values.
export function timeLabel(wall, timeFormat = '24h', locale) {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: timeFormat === '12h' ? 'numeric' : '2-digit',
    minute: '2-digit', hourCycle: timeFormat === '12h' ? 'h12' : 'h23' }).format(new Date(`${wall}Z`));
}
export function toInstant(wall, timezone, t = (_key, fallback) => fallback) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) throw new Error(t('localCalendar.invalidDateTime', "Enter a valid date and time."));
  const target = Date.parse(`${wall}Z`);
  if (!Number.isFinite(target)) throw new Error(t('localCalendar.invalidDateTime', "Enter a valid date and time."));
  if (new Date(target).toISOString().slice(0, 16) !== wall) throw new Error(t('localCalendar.invalidDateTime', "Enter a valid date and time."));
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(target)); }
  catch { throw new Error(t('compose.availability.invalidZone', 'Enter a valid time zone, such as Europe/London.')); }
  const wallAt = at => Date.parse(`${wallTime(new Date(at).toISOString(), timezone)}Z`);
  const offsets = new Set([-36, 0, 36].map(hours => { const at = target + hours * 3600000; return wallAt(at) - at; }));
  const matches = [...offsets].map(offset => target - offset).filter(at => wallAt(at) === target);
  if (!matches.length) throw new Error(t('localCalendar.missingTime', "That time does not exist in this time zone. Choose another time."));
  if (matches.length > 1) throw new Error(t('localCalendar.ambiguousTime', "That time occurs twice when the clocks change. Choose an unambiguous time."));
  return new Date(matches[0]).toISOString();
}
export function visibleDays(day, view, weekStart) {
  const base = view === 'month' ? `${day.slice(0, 7)}-01` : day;
  const first = view === 'day' ? day : addDays(base, -((new Date(`${base}T12:00Z`).getUTCDay() - weekStart + 7) % 7));
  const monthDays = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
  const count = view === 'day' ? 1 : view === 'week' ? 7 : Math.ceil(((Date.parse(base) - Date.parse(first)) / 86400000 + monthDays) / 7) * 7;
  return Array.from({ length: count }, (_, index) => addDays(first, index));
}
export function navigateDate(day, view, amount) {
  if (view !== 'month') return addDays(day, amount * (view === 'week' ? 7 : 1));
  const date = new Date(`${day.slice(0, 7)}-01T12:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); return date.toISOString().slice(0, 10);
}
export function eventOnDay(event, day, timezone) {
  const start = event.allDay ? event.start : wallTime(event.start, timezone);
  const end = event.allDay ? event.end : wallTime(event.end, timezone);
  return start < `${addDays(day, 1)}${event.allDay ? '' : 'T00:00'}` && end > `${day}${event.allDay ? '' : 'T00:00'}`;
}
export function timedSegments(events, day, timezone) {
  const minutes = wall => Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
  const segments = events.filter(e => !e.allDay && eventOnDay(e, day, timezone)).map(event => {
    const start = wallTime(event.start, timezone), end = wallTime(event.end, timezone);
    const from = start.slice(0, 10) < day ? 0 : minutes(start);
    const to = end.slice(0, 10) > day ? 1440 : minutes(end);
    return { event, from, to: Math.max(to, from + 15), lane: 0, lanes: 1 };
  }).sort((a, b) => a.from - b.from || b.to - a.to);
  let group = [], until = -1;
  const finish = () => { const lanes = Math.max(1, ...group.map(s => s.lane + 1)); for (const segment of group) segment.lanes = lanes; };
  for (const segment of segments) {
    if (segment.from >= until) { finish(); group = []; until = -1; }
    const occupied = new Set(group.filter(s => s.to > segment.from).map(s => s.lane));
    while (occupied.has(segment.lane)) segment.lane++;
    group.push(segment); until = Math.max(until, segment.to);
  }
  finish(); return segments;
}
