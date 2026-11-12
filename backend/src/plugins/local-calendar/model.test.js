import { describe, it, expect } from 'vitest';
import { catalogData, eventData } from './model.js';
const calendar = { id: '11111111-1111-4111-8111-111111111111', name: 'My calendar', color: '#aabbcc', visible: true };
const event = { title: 'Real event', start: '2026-11-01T09:00:00.000Z', end: '2026-11-01T10:00:00.000Z', allDay: false, calendarId: calendar.id, timezone: 'America/New_York' };
describe('local calendar validation', () => {
  it('accepts timed and multiday all-day records with exclusive ends', () => {
    expect(eventData(event, [calendar])).toMatchObject({ title: 'Real event', rangeStart: event.start });
    expect(eventData({ ...event, allDay: true, start: '2026-11-01', end: '2026-11-04' }, [calendar])).toMatchObject({ rangeStart: '2026-10-31T00:00:00.000Z', rangeEnd: '2026-11-05T00:00:00.000Z' });
  });
  it('rejects nonexistent dates, missing zones, reversed ends and foreign calendars', () => {
    for (const patch of [{ allDay: true, start: '2026-02-30', end: '2026-03-02' }, { start: 'tomorrow' }, { timezone: 'Mars/Base' }, { end: event.start }, { calendarId: '22222222-2222-4222-8222-222222222222' }, { title: ' ' }]) expect(() => eventData({ ...event, ...patch }, [calendar])).toThrow();
  });
  it('bounds catalogs and templates and validates week starts', () => {
    const catalog = { calendars: [calendar], templates: [], timezone: 'UTC', weekStart: 6 };
    expect(catalogData(catalog)).toEqual({ ...catalog, timeFormat: '24h' });
    for (const patch of [{ calendars: [calendar, calendar] }, { weekStart: 4 }, { templates: [{ id: calendar.id, title: 'Focus', duration: -1 }] }, { calendars: Array(31).fill(calendar) }]) expect(() => catalogData({ ...catalog, ...patch })).toThrow();
  });
  it('validates and persists explicit 12/24-hour catalog preferences with a compatible default', () => {
    const base = { calendars: [], templates: [], timezone: 'UTC', weekStart: 1 };
    expect(catalogData(base).timeFormat).toBe('24h');
    for (const timeFormat of ['12h', '24h']) expect(catalogData({ ...base, timeFormat }).timeFormat).toBe(timeFormat);
    for (const timeFormat of [null, '', '12 hour', 12, 'h24']) expect(() => catalogData({ ...base, timeFormat })).toThrow('Invalid time format');
  });

});
