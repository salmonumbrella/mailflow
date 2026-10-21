import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialExpandedMessageIds } from './conversation.js';

const messages = [
  { id: 'match', message_id: '<match@synthetic.test>', date: '2026-10-20T10:00:00Z' },
  { id: 'context', message_id: '<context@synthetic.test>', date: '2026-10-20T11:00:00Z' },
];

describe('initial search conversation focus', () => {
  it('expands only the matched message, leaving newer context collapsed', () => {
    assert.deepEqual([...initialExpandedMessageIds(messages, 'match')], ['match']);
  });

  it('does not silently focus newer context when the match is absent', () => {
    assert.deepEqual([...initialExpandedMessageIds(messages, 'removed-match')], []);
  });

  it('preserves newest-message expansion when no search focus is supplied', () => {
    assert.deepEqual([...initialExpandedMessageIds(messages)], ['context']);
    assert.deepEqual([...initialExpandedMessageIds(messages, null)], ['context']);
  });

  it('does not depend on input order for matching focus', () => {
    assert.deepEqual([...initialExpandedMessageIds([...messages].reverse(), 'match')], ['match']);
    assert.deepEqual([...initialExpandedMessageIds([], 'match')], []);
  });
});
