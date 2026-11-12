import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleDays, navigateDate, wallTime, timeLabel, toInstant, eventOnDay, timedSegments } from './dates.js';
test('day week and month ranges honor all week starts across years', () => {
  assert.deepEqual(visibleDays('2027-01-01', 'day', 1), ['2027-01-01']);
  assert.equal(visibleDays('2027-01-01', 'week', 1)[0], '2026-12-28');
  assert.equal(visibleDays('2027-01-01', 'week', 0)[0], '2026-12-27');
  assert.equal(visibleDays('2027-01-01', 'week', 6)[0], '2026-12-26');
  assert.equal(visibleDays('2026-02-18', 'month', 1).length, 35);
  assert.equal(navigateDate('2026-12-31', 'month', 1), '2027-01-01');
});
test('time zones roundtrip real instants and reject nonexistent DST wall times', () => {
  assert.equal(wallTime('2026-07-01T16:30:00Z', 'America/New_York'), '2026-07-01T12:30');
  assert.equal(toInstant('2026-07-01T12:30', 'America/New_York'), '2026-07-01T16:30:00.000Z');
  assert.equal(toInstant('2026-01-01T12:30', 'Asia/Kolkata'), '2026-01-01T07:00:00.000Z');
  assert.throws(() => toInstant('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => toInstant('2026-11-01T01:30', 'America/New_York'), /occurs twice/);
  assert.throws(() => toInstant('2026-02-30T12:30', 'UTC'), /valid date/);
  assert.throws(() => toInstant('2026-04-05T01:45', 'Australia/Lord_Howe'), /occurs twice/);
});
test('exclusive all-day ends and midnight timed ends avoid phantom extra days', () => {
  assert.equal(eventOnDay({ allDay: true, start: '2026-01-01', end: '2026-01-03' }, '2026-01-02', 'UTC'), true);
  assert.equal(eventOnDay({ allDay: true, start: '2026-01-01', end: '2026-01-03' }, '2026-01-03', 'UTC'), false);
  assert.equal(eventOnDay({ allDay: false, start: '2026-01-01T23:00:00Z', end: '2026-01-02T00:00:00Z' }, '2026-01-02', 'UTC'), false);
});
test('multiday timed events are clipped and overlaps get separate lanes', () => {
  const events = [{ id: 'a', start: '2026-01-01T23:00Z', end: '2026-01-02T10:00Z' }, { id: 'b', start: '2026-01-02T09:00Z', end: '2026-01-02T11:00Z' }, { id: 'c', start: '2026-01-02T12:00Z', end: '2026-01-02T13:00Z' }];
  const result = timedSegments(events, '2026-01-02', 'UTC');
  assert.deepEqual(result.map(s => [s.from, s.to, s.lane, s.lanes]), [[0,600,0,2],[540,660,1,2],[720,780,0,1]]);
});


test('clock labels honor explicit 12/24-hour choices without changing wall-time math', () => {
  assert.equal(timeLabel('2026-11-10T00:00', '12h', 'en-US'), '12:00 AM');
  assert.equal(timeLabel('2026-11-10T12:00', '12h', 'en-US'), '12:00 PM');
  assert.equal(timeLabel('2026-11-10T15:30', '12h', 'en-US'), '3:30 PM');
  assert.equal(timeLabel('2026-11-10T00:00', '24h', 'en-US'), '00:00');
  assert.equal(timeLabel('2026-11-10T15:30', '24h', 'en-US'), '15:30');
  assert.equal(timeLabel(wallTime('2026-11-10T20:30:00Z', 'America/New_York'), '12h', 'en-US'), '3:30 PM');
  assert.equal(toInstant('2026-11-10T15:30', 'America/New_York'), '2026-11-10T20:30:00.000Z');
});
