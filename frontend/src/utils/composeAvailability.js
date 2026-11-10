export const QUICK_REPLIES = [
  { labelKey: 'compose.quickReplies.thanksLabel', bodyKey: 'compose.quickReplies.thanksBody', label: 'Thank you', body: 'Thank you for the update.' },
  { labelKey: 'compose.quickReplies.receivedLabel', bodyKey: 'compose.quickReplies.receivedBody', label: 'Received', body: 'Received, thank you.' },
  { labelKey: 'compose.quickReplies.reviewLabel', bodyKey: 'compose.quickReplies.reviewBody', label: 'I’ll review this', body: 'I’ll review this and follow up.' },
];

export function availabilityText(date, time, timeZone, now = new Date(), t = (_key, fallback, values = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name] ?? ''), locale = 'en-US') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { error: t('compose.availability.chooseDateTime', "Choose a date and time.") };
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(wall);
  if (year < 2000 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59
      || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return { error: t('compose.availability.invalidDateTime', "Choose a valid date and time.") };
  let formatter;
  try {
    if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 100) throw new Error('Invalid time zone');
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch { return { error: t('compose.availability.invalidZone', "Enter a valid time zone, such as Europe/London.") }; }
  const partsAt = at => Object.fromEntries(formatter.formatToParts(new Date(at)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const wallAt = at => { const p = partsAt(at); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); };
  // Sampling both sides of the proposed date catches daylight-saving gaps and repeated times.
  const offsets = new Set([-36, 0, 36].map(hours => { const at = wall + hours * 3600000; return wallAt(at) - at; }));
  const matches = [...offsets].map(offset => wall - offset).filter(at => wallAt(at) === wall);
  if (!matches.length) return { error: t('compose.availability.missingTime', "That time does not exist in this time zone because the clocks change. Choose another time.") };
  if (matches.length > 1) return { error: t('compose.availability.ambiguousTime', "That time occurs twice when the clocks change. Choose an unambiguous time.") };
  if (matches[0] <= now.getTime()) return { error: t('compose.availability.futureTime', "Choose a future date and time.") };
  const zone = formatter.resolvedOptions().timeZone;
  const dateText = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(matches[0]));
  return { text: t('compose.availability.message', "I’m available {{date}} ({{zone}}). Would that work for you?", { date: dateText, zone }), at: new Date(matches[0]), timeZone: zone };
}
