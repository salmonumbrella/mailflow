import { describe, expect, it } from 'vitest';
import { searchSourceKey, searchSourceVersion } from './searchIndexIdentity.js';

const row = { folder: 'INBOX', uid_validity: '9007199254740993', uid: '42', provider_msgid: '1789234567890123456' };

describe('search job immutable source identity', () => {
  it('uses physical identity until the actual global bootstrap consumer reports ready', () => {
    expect(searchSourceKey(row, false)).toBe('physical:INBOX:9007199254740993:42');
    expect(searchSourceKey(row, true)).toBe('provider:1789234567890123456');
    expect(searchSourceKey({ ...row, folder: 'Label', uid_validity: '19', uid: '91' }, true))
      .toBe('provider:1789234567890123456');
  });

  it('keeps a missing provider ID physical even after readiness and ignores RFC identity', () => {
    expect(searchSourceKey({ ...row, provider_msgid: null, message_id: '<same@example.test>' }, true))
      .toBe('physical:INBOX:9007199254740993:42');
    expect(searchSourceKey({ ...row, provider_msgid: null, folder: 'Label', message_id: '<same@example.test>' }, true))
      .toBe('physical:Label:9007199254740993:42');
  });

  it('keeps the contract generation separate from physical epochs and exact above 2^53', () => {
    expect(searchSourceVersion({ source_key: 'provider:7', source_generation: '0' })).toBe('["7b","provider:7","0"]');
    expect(searchSourceVersion({ source_key: 'provider:7', source_generation: '9007199254740993' }))
      .toBe('["7b","provider:7","9007199254740993"]');
    expect(searchSourceVersion({ source_key: 'provider:7', source_generation: '9007199254740992' }))
      .not.toBe(searchSourceVersion({ source_key: 'provider:7', source_generation: '9007199254740993' }));
  });

  it('keeps distinct physical locators distinct through seeded folder and bigint sequences', () => {
    let seed = 0x7b130d;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const keys = new Set();
    for (let i = 0; i < 128; i++) {
      const folder = ['INBOX', 'Label:7', '旅行', 'A/B'][next() % 4];
      const epoch = (9007199254740993n + BigInt(i)).toString();
      const uid = String(next() % 100000 + 1);
      const physical = { folder, uid_validity: epoch, uid, provider_msgid: null };
      const key = searchSourceKey(physical, true);
      expect(keys.has(key), `seed=${seed},step=${i}`).toBe(false);
      keys.add(key);
      expect(searchSourceKey({ ...physical, uid: String(BigInt(uid) + 1n) }, true)).not.toBe(key);
      expect(searchSourceKey({ ...physical, uid_validity: (BigInt(epoch) + 1n).toString() }, true)).not.toBe(key);
    }
  });
});
