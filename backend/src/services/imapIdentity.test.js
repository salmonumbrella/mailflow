import { describe, expect, it } from 'vitest';
import { normalizeMessageId, uniqueMessageUid } from './imapIdentity.js';

const transport = entries => ({
  search: async (q, opts) => {
    expect(q).toEqual({ header: { 'Message-ID': 'target@test' } });
    expect(opts).toEqual({ uid: true });
    return entries.filter(([, id]) => id?.includes('target@test')).map(([uid]) => uid);
  },
  fetch: async function* (range, q, opts) {
    expect(q).toEqual({ uid: true, envelope: true }); expect(opts).toEqual({ uid: true });
    const selected = range.split(',').map(Number);
    for (const [uid, id] of entries) if (selected.includes(uid)) yield { uid, envelope: { messageId: id } };
  },
});

describe('exact unique Message-ID evidence', () => {
  // Exhaust the three live UID slots over absent, substring, exact bracketed,
  // exact bare and unrelated identities. The slot model is independent of SEARCH.
  const variants = [null, '<prefix-target@test>', '<target@test>', 'target@test', '<other@test>'];
  for (let a = 0; a < variants.length; a++) for (let b = 0; b < variants.length; b++) for (let c = 0; c < variants.length; c++) {
    it(`selects a UID only for one exact identity in generated slots ${a}/${b}/${c}`, async () => {
      const slots = [a, b, c], ids = [2, 17, 501];
      const exact = slots.flatMap((kind, slot) => kind === 2 || kind === 3 ? [ids[slot]] : []);
      const entries = slots.map((kind, slot) => [ids[slot], variants[kind]]);
      expect(await uniqueMessageUid(transport(entries), '<target@test>')).toBe(exact.length === 1 ? exact[0] : null);
    });
  }
  it('fetches through a full candidate chunk to find the exact identity', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => [i + 1, '<prefix-target@test>']);
    entries.push([701, '<target@test>']);
    expect(await uniqueMessageUid(transport(entries), '<target@test>')).toBe(701);
  });
  it.each([null, undefined, '', '<>', ' <> ', '<bad<>id>', 'bad\r\nid', 42, '<@>', '<x@>', '<@x>', '@', 'x@', '@x', '<missing-separator>', '<two@@parts>'])('rejects a missing or malformed identity %j', value => {
    expect(normalizeMessageId(value)).toBe(null);
  });
});
