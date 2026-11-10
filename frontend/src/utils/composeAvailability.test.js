import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityText } from './composeAvailability.js';
const now = new Date('2026-01-01T00:00:00Z');
test('manual availability uses the chosen timezone and an explicit year', () => {
  const result = availabilityText('2026-11-20', '14:30', 'America/New_York', now);
  assert.equal(result.at.toISOString(), '2026-11-20T19:30:00.000Z');
  assert.match(result.text, /November 20, 2026/); assert.match(result.text, /2:30 PM/); assert.match(result.text, /America\/New_York/);
});
test('availability rejects missing, impossible, past and invalid-zone times', () => {
  for (const [date, time, zone] of [['', '', 'UTC'], ['2026-02-30', '10:00', 'UTC'], ['2026-11-20', '29:00', 'UTC'], ['2025-12-31', '10:00', 'UTC'], ['2026-11-20', '10:00', 'bad-zone'], ['2026-11-20', '10:00', '']]) {
    assert.ok(availabilityText(date, time, zone, now).error);
  }
});
test('availability refuses DST gaps and folds rather than silently choosing another instant', () => {
  assert.match(availabilityText('2026-03-08', '02:30', 'America/New_York', now).error, /does not exist/);
  assert.match(availabilityText('2026-11-01', '01:30', 'America/New_York', now).error, /occurs twice/);
});
