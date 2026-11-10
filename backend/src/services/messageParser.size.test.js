import { describe, expect, it } from 'vitest';
import { parseMessage } from './messageParser.js';

describe('authoritative RFC822.SIZE metadata', () => {
  it.each([0, 1, 1048576, Number.MAX_SAFE_INTEGER])('accepts exact safe FETCH size %s', async size => {
    expect((await parseMessage({ uid: 1, size })).rfc822SizeBytes).toBe(size);
  });

  it.each([undefined, null, '', '123', 1n, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'keeps invalid or missing FETCH size %s unknown', async size => {
      expect((await parseMessage({ uid: 1, size })).rfc822SizeBytes).toBeNull();
    });

  it('never estimates from source, body structure or attachment sizes', async () => {
    const parsed = await parseMessage({ uid: 1, source: Buffer.alloc(2048),
      bodyStructure: { type: 'application/pdf', size: 1000, disposition: 'attachment' } });
    expect(parsed.rfc822SizeBytes).toBeNull();
  });
});
