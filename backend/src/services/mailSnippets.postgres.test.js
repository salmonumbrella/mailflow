import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const boundary = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  query: (sql, params) => boundary.pool.query(sql, params),
  withTransaction: async fn => {
    const client = await boundary.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
import { changeSnippet, listSnippets, recordSnippetUse } from './mailSnippets.js';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('user-owned snippet persistence in PostgreSQL', () => {
  const schema = `snippet_test_${process.pid}_${Date.now()}`;
  let admin;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    boundary.pool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}` });
    await boundary.pool.query("CREATE TABLE users (id text PRIMARY KEY, preferences jsonb DEFAULT '{}'::jsonb)");
  });
  afterAll(async () => { await boundary.pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  beforeEach(async () => {
    await boundary.pool.query('TRUNCATE users');
    await boundary.pool.query(`INSERT INTO users (id, preferences) VALUES ('alice', '{"theme":"dark"}'), ('bob', '{}')`);
  });
  const draft = { title: 'Snippet', body: 'Saved text' };

  it('retains other preferences, scopes by authenticated owner and persists across reads', async () => {
    const saved = await changeSnippet('alice', 'create', null, draft);
    expect(await listSnippets('alice')).toEqual([saved]);
    expect(await listSnippets('bob')).toEqual([]);
    await expect(changeSnippet('bob', 'update', saved.id, { ...draft, version: 1 })).rejects.toMatchObject({ status: 404 });
    expect((await boundary.pool.query("SELECT preferences->>'theme' AS theme FROM users WHERE id='alice'")).rows[0].theme).toBe('dark');
  });

  it('serializes concurrent creates so none are lost and the limit cannot be exceeded', async () => {
    await Promise.all(Array.from({ length: 48 }, (_, i) => changeSnippet('alice', 'create', null, { ...draft, title: `Saved ${i}` })));
    const raced = await Promise.allSettled(Array.from({ length: 6 }, () => changeSnippet('alice', 'create', null, draft)));
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(raced.filter(r => r.status === 'rejected').every(r => r.reason.status === 409)).toBe(true);
    const items = await listSnippets('alice');
    expect(items).toHaveLength(50); expect(new Set(items.map(item => item.id)).size).toBe(50);
  });

  it('deduplicates concurrent uses, retains usage across edits and isolates owners', async () => {
    const saved = await changeSnippet('alice', 'create', null, draft);
    const requestId = randomUUID();
    await Promise.all(Array.from({ length: 8 }, () => recordSnippetUse('alice', saved.id, requestId)));
    await Promise.all([
      ...Array.from({ length: 12 }, () => recordSnippetUse('alice', saved.id, randomUUID())),
      changeSnippet('alice', 'update', saved.id, { ...draft, title: 'Edited', version: 1 }),
    ]);
    const [used] = await listSnippets('alice');
    expect(used.usageCount).toBe(13); expect(used.lastUsedAt).toBeTruthy(); expect(used.version).toBe(2); expect(used.title).toBe('Edited');
    expect(used).not.toHaveProperty('usageRequestIds');
    await expect(recordSnippetUse('bob', saved.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await listSnippets('bob')).toEqual([]);
  });

  it('accepts only one of two concurrent edits based on the same version', async () => {
    const saved = await changeSnippet('alice', 'create', null, draft);
    const results = await Promise.allSettled(['One', 'Two'].map(title => changeSnippet('alice', 'update', saved.id, { ...draft, title, version: 1 })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.status).toBe(409);
    expect((await listSnippets('alice'))[0].version).toBe(2);
  });
});
