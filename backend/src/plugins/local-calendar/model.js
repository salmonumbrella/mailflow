export const PLUGIN_ID = 'local-calendar';
export const catalogKey = userId => `${userId}/catalog`;
export const eventPrefix = userId => `${userId}/events/`;
export const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function text(value, max, name, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`Invalid ${name}`);
  return value.trim();
}
export function timezone(value) {
  if (typeof value !== 'string' || value.length > 100) fail('Invalid time zone');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { fail('Invalid time zone'); }
  return value;
}
export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Invalid date');
  return value;
}
export function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('Invalid event time');
  date(value.slice(0, 10));
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail('Invalid event time');
  return new Date(value).toISOString();
}
export function eventData(body, calendars) {
  if (!body || typeof body.allDay !== 'boolean' || !validId(body.calendarId) || !calendars.some(c => c.id === body.calendarId)) fail('Choose an existing calendar');
  const start = body.allDay ? date(body.start) : instant(body.start);
  const end = body.allDay ? date(body.end) : instant(body.end);
  if (end <= start || Date.parse(end) - Date.parse(start) > 366 * 86400000) fail('End must be after start, within one year');
  return { title: text(body.title, 300, 'title', true), start, end, allDay: body.allDay,
    calendarId: body.calendarId, timezone: timezone(body.timezone), location: text(body.location ?? '', 1000, 'location'), description: text(body.description ?? '', 10000, 'description'),
    // Conservative UTC bounds cover all-day dates in every IANA time zone; clients intersect exact local dates.
    rangeStart: body.allDay ? new Date(Date.parse(start) - 86400000).toISOString() : start,
    rangeEnd: body.allDay ? new Date(Date.parse(end) + 86400000).toISOString() : end };
}
export function catalogData(body) {
  if (!body || !Array.isArray(body.calendars) || body.calendars.length > 30 || !Array.isArray(body.templates) || body.templates.length > 100 || ![0, 1, 6].includes(body.weekStart)) fail('Invalid calendar settings');
  const ids = new Set();
  const calendars = body.calendars.map(c => {
    if (!c || typeof c !== 'object' || !validId(c.id) || ids.has(c.id) || !/^#[0-9a-f]{6}$/i.test(c.color) || typeof c.visible !== 'boolean') fail('Invalid calendar');
    ids.add(c.id);
    return { id: c.id, name: text(c.name, 100, 'calendar name', true), color: c.color, visible: c.visible };
  });
  const templateIds = new Set();
  const templates = body.templates.map(t => {
    if (!t || typeof t !== 'object' || !validId(t.id) || templateIds.has(t.id) || !Number.isInteger(t.duration) || t.duration < 5 || t.duration > 1440) fail('Invalid event template');
    templateIds.add(t.id);
    return { id: t.id, title: text(t.title, 300, 'template title', true), duration: t.duration, location: text(t.location ?? '', 1000, 'location'), description: text(t.description ?? '', 10000, 'description') };
  });
  const timeFormat = body.timeFormat === undefined ? '24h' : body.timeFormat;
  if (!['12h', '24h'].includes(timeFormat)) fail('Invalid time format');
  const value = { calendars, templates, timezone: timezone(body.timezone), weekStart: body.weekStart, timeFormat };
  if (Buffer.byteLength(JSON.stringify(value)) > 120000) fail('Calendar settings are too large');
  return value;
}
