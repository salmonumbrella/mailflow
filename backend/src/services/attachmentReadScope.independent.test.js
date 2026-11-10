import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./messageIdentity.js', async original => ({
  ...await original(), assertExpectedSource: vi.fn(async () => {}),
  withMailboxIdentity: vi.fn(async (_context, run) => {
    const { query } = await import('./db.js');
    return run({ query });
  }),
}));
import { query } from './db.js';
import { assertExpectedSource } from './messageIdentity.js';
import { assertAttachmentRequestSource, assertAttachmentSource, sameAttachmentSource } from './attachmentReadScope.js';

const source = Object.freeze({
  messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444',
  folder: '受信/%25/📎', uidValidity: '4294967295', uid: '7',
});
const row = Object.freeze({ id: source.messageId, account_id: source.accountId, storage_generation: source.storageGeneration,
  entity_id: source.entityId, folder: source.folder, uid_validity: 4294967295n, uid: 7 });
const encode = value => encodeURIComponent(JSON.stringify(value));
const account = Object.freeze({ id: source.accountId, user_id: 'owner', storage_generation: source.storageGeneration });
const proof = Object.freeze({ context: {}, expectedSource: row });

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [{ ...row }] });
  assertExpectedSource.mockReset().mockResolvedValue(row);
});

describe('independent complete clicked-source proof', () => {
  it('round trips Unicode and literal percent folder names without changing the physical tuple', () => {
    expect(() => assertAttachmentRequestSource(encode(source), row)).not.toThrow();
    expect(sameAttachmentSource(row, { ...row, uid: '7', uid_validity: source.uidValidity })).toBe(true);
  });

  it('keeps legacy absence explicit, while refusing an empty or null supplied proof', () => {
    expect(() => assertAttachmentRequestSource(undefined, row)).not.toThrow();
    for (const header of ['', null, 'null', encode([])]) {
      expect(() => assertAttachmentRequestSource(header, row)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it.each(Object.keys(source))('rejects missing or null %s rather than filling from the new row', key => {
    const absent = { ...source }; delete absent[key];
    for (const value of [absent, { ...source, [key]: null }]) {
      expect(() => assertAttachmentRequestSource(encode(value), row)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it.each(['messageId', 'accountId', 'storageGeneration', 'entityId'])('rejects non-UUID or compound %s', key => {
    for (const value of ['not-a-uuid', source[key] + ' ', source[key] + ',other', 123, {}, []]) {
      expect(() => assertAttachmentRequestSource(encode({ ...source, [key]: value }), row)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it.each(['uid', 'uidValidity'])('requires canonical nonzero uint32 string %s', key => {
    for (const value of [0, 7, -1, '0', '-1', '01', '+1', '1.0', '1e2', ' 7', '7 ', '4294967296', 'Infinity', 'NaN', '', '٧']) {
      expect(() => assertAttachmentRequestSource(encode({ ...source, [key]: value }), row)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it.each(['', 'x'.repeat(501), '\u0000INBOX', 'INBOX\r\nOther', 'INBOX\u007f', {}, []])('rejects invalid folder %j', folder => {
    expect(() => assertAttachmentRequestSource(encode({ ...source, folder }), row)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('rejects undecodable, nested, double encoded and extra-field envelopes', () => {
    for (const header of ['%', '%E0%A4%A', 'x'.repeat(8193), encode(encode(source)), encode({ source }), encode({ ...source, filename: 'innocent.pdf' })]) {
      expect(() => assertAttachmentRequestSource(header, row)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it.each(Object.keys(source))('treats a well formed replacement %s as stale, never another source', key => {
    const value = key === 'folder' ? 'Other' : ['uid', 'uidValidity'].includes(key) ? '99' : '99999999-9999-4999-8999-999999999999';
    expect(() => assertAttachmentRequestSource(encode({ ...source, [key]: value }), row)).toThrow(expect.objectContaining({ status: 409, code: 'identity_source_changed' }));
  });
});

describe('independent attachment source authority recheck', () => {
  it('uses the captured owner and requires a live message in an enabled account', async () => {
    await assertAttachmentSource(account, proof);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([source.messageId, 'owner']);
    expect(sql).toContain('a.user_id = $2');
    expect(sql).toContain('a.enabled = true');
    expect(sql).toContain('m.is_deleted = false');
    expect(sql).not.toMatch(/message_id\s*=/);
  });

  it.each(Object.keys(row))('refuses a changed physical %s discovered after the awaited identity fence', async key => {
    assertExpectedSource.mockImplementation(async () => {
      query.mockResolvedValue({ rows: [{ ...row, [key]: key === 'uid' || key === 'uid_validity' ? 99 : 'changed' }] });
    });
    await expect(assertAttachmentSource(account, proof)).rejects.toMatchObject({ status: 409, code: 'identity_source_changed' });
  });

  it('does not accept a source whose ownership disappears during the awaited fence', async () => {
    assertExpectedSource.mockImplementation(async () => { query.mockResolvedValue({ rows: [] }); });
    await expect(assertAttachmentSource(account, proof)).rejects.toMatchObject({ status: 409, code: 'identity_source_changed' });
  });

  it('rejects a different account even if a faulty downstream lookup returns the original row', async () => {
    await expect(assertAttachmentSource({ ...account, id: 'other-account' }, proof)).rejects.toMatchObject({ status: 409, code: 'identity_source_changed' });
  });
});
