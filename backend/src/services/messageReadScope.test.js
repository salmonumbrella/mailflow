import { describe, expect, it, vi } from 'vitest';
import { assertReadSourceIdentity } from './messageReadScope.js';

const source = { id: 'message', account_id: 'account', storage_generation: 'generation',
  uid_validity: '10', entity_id: 'entity', uid: 7, folder: 'INBOX' };
const account = { id: source.account_id, storage_generation: source.storage_generation };

describe('flag source identity projection', () => {
  it('loads identity and flag metadata only, never cached bodies or attachments', async () => {
    const current = { ...source, message_id: '<mail@example.test>', is_read: false, is_starred: false, is_deleted: false };
    const tx = { query: vi.fn(async () => ({ rows: [current] })) };
    expect(await assertReadSourceIdentity(tx, account, source)).toBe(current);
    const [sql, params] = tx.query.mock.calls[0];
    const projection = sql.slice('SELECT '.length, sql.indexOf(' FROM messages')).split(', ');
    expect(projection).toEqual(['id', 'account_id', 'storage_generation', 'uid_validity', 'entity_id',
      'uid', 'folder', 'message_id', 'is_read', 'is_starred', 'is_deleted']);
    expect(sql).toContain('FOR UPDATE');
    expect(params).toEqual([source.id, account.id, source.storage_generation, source.folder,
      source.uid, source.uid_validity, source.entity_id]);
  });
});
