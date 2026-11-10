import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { getOwnedThreadIdentities } from './mailAccess.js';

beforeEach(() => query.mockReset());
describe('bounded owned thread identities', () => {
  it('binds owner and selected message, limits account membership, and retains deleted anchor identities', async () => {
    const rows = [{ message_id: '<reply>', thread_id: '<root>', in_reply_to: '<root>', thread_references: '<root>' }];
    query.mockResolvedValue({ rows });
    expect(await getOwnedThreadIdentities('owner', 'message')).toEqual(rows);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['owner', 'message', 101]);
    expect(sql).toContain('a.user_id = $1');
    expect(sql).toContain('m.id = $2');
    expect(sql).toContain('m.account_id = t.account_id');
    expect(sql).toContain('m.thread_key = t.thread_key');
    expect(sql.match(/is_deleted/g)).toHaveLength(1);
  });
  it('never silently truncates an oversized conversation or header', async () => {
    query.mockResolvedValue({ rows: Array(101).fill({ message_id: '<message>' }) });
    await expect(getOwnedThreadIdentities('owner', 'message')).rejects.toMatchObject({ status: 413 });
    query.mockResolvedValue({ rows: [{ message_id: 'x'.repeat(4097) }] });
    await expect(getOwnedThreadIdentities('owner', 'message')).rejects.toMatchObject({ status: 413 });
    query.mockResolvedValue({ rows: [{ thread_references: 'x'.repeat(16385) }] });
    await expect(getOwnedThreadIdentities('owner', 'message')).rejects.toMatchObject({ status: 413 });
  });
  it('rejects unsafe limits before querying', async () => {
    for (const limit of [0, 101, '100', 1.5]) await expect(getOwnedThreadIdentities('owner', 'message', { limit })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
