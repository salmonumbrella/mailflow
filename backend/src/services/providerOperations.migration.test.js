import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0053_provider_operations.sql', import.meta.url),
  'utf8',
);

describe('provider operations migration', () => {
  it('stores monotonic intent, ownership, uncertainty, observations, and receipt data', () => {
    expect(migration).toMatch(/CREATE TABLE provider_operations/i);
    expect(migration).toMatch(/operation_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(migration).toMatch(/state\s+TEXT\s+NOT NULL/i);
    expect(migration).toMatch(/provider_started/i);
    expect(migration).toMatch(/provider_applied/i);
    expect(migration).toMatch(/completed/i);
    expect(migration).toMatch(/manual_intervention/i);
    expect(migration).toMatch(/attempt_generation\s+BIGINT\s+NOT NULL/i);
    expect(migration).toMatch(/attempt_owner\s+UUID/i);
    expect(migration).toMatch(/marker\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(migration).toMatch(/source_observation\s+JSONB/i);
    expect(migration).toMatch(/destination_observation\s+JSONB/i);
    expect(migration).toMatch(/receipt\s+JSONB/i);
    expect(migration).toMatch(/uncertainty\s+JSONB/i);
  });

  it('gives snooze wakeup an exact message-row identity', () => {
    expect(migration).toMatch(/ALTER TABLE snoozed_messages[\s\S]*message_row_id\s+UUID/i);
    expect(migration).toMatch(/REFERENCES messages\s*\(id\)/i);
    expect(migration).toMatch(/REFERENCES messages\s*\(id\)\s+ON DELETE SET NULL/i);
    expect(migration).not.toMatch(/message_row_id[\s\S]{0,100}ON DELETE CASCADE/i);
    expect(migration).toMatch(/UPDATE\s+snoozed_messages[\s\S]*SET\s+message_row_id/i);
    expect(migration).not.toMatch(/MIN\s*\(\s*m\.id\s*\)/i);
    expect(migration).toMatch(/COUNT\s*\(\*\)\s+OVER\s*\(\s*PARTITION BY\s+sm\.id\s*\)/i);
    expect(migration).toMatch(/m\.metadata_complete\s*=\s*true/i);
    expect(migration).toMatch(/JOIN\s+folders\s+f[\s\S]*f\.is_present\s*=\s*true[\s\S]*f\.uid_validity\s+IS\s+NOT\s+NULL/i);
  });

  it('preserves active and manual snoozes when their correlated message is later deleted', () => {
    expect(migration).toMatch(/message_row_id\s+UUID[\s\S]{0,100}ON DELETE SET NULL/i);
  });

  it('retains ambiguous and null legacy snoozes for manual reconciliation', () => {
    expect(migration).not.toMatch(/DELETE\s+FROM\s+snoozed_messages/i);
  });

  it('persists a manual state that orphan cleanup cannot consume', () => {
    expect(migration).toMatch(/resolution_state\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'active'/i);
    expect(migration).toMatch(/manual_intervention/i);
  });
});
