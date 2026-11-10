import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { protocolNumber, providerIdentityNamespace } from './messageIdentity.js';

describe('negotiated message identity provenance', () => {
  it('prefers OBJECTID exactly as pinned ImapFlow FETCH does, independent of hostname', () => {
    expect(providerIdentityNamespace({ capabilities: new Set(['OBJECTID', 'X-GM-EXT-1']) })).toBe('imap-objectid');
    expect(providerIdentityNamespace({ capabilities: new Set(['X-GM-EXT-1']) })).toBe('gmail-x-gm-msgid');
    expect(providerIdentityNamespace({ host: 'imap.gmail.com', capabilities: new Set() })).toBeNull();
    expect(providerIdentityNamespace({ capabilities: new Set(['UIDPLUS']) })).toBeNull();
  });
  it('keeps protocol integers exact and rejects invalid/unsafe coordinates', () => {
    for (const value of [1, '1', 1n, '0001']) expect(protocolNumber(value)).toBe('1');
    expect(protocolNumber(4294967295n)).toBe('4294967295');
    for (const value of [0, -1, '4294967296', 1.2, null, undefined, '', '1x', '1e3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(protocolNumber(value)).toBeNull();
    }
  });
});
