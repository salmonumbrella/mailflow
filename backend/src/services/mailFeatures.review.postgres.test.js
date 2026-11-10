import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
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
import { changeSnippet, listSnippets } from './mailSnippets.js';
import { putSavedSplits } from '../routes/savedSplitsPreferences.js';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('independent persisted mail review in PostgreSQL', () => {
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

  it('merges concurrent snippet creates, split CAS updates and ordinary preferences without lost writes', async () => {
    const replies = [];
    const requests = Array.from({ length: 8 }, (_, i) => {
      const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
      replies.push(response);
      return putSavedSplits({ session: { userId: 'alice' }, body: {
        savedSplits: [{ id: `split${i}`, label: `Split ${i}`, query: 'is:unread' }], hideEmptySplits: true, savedSplitsRevision: 0,
      } }, response);
    });
    await Promise.all([
      ...requests,
      ...Array.from({ length: 8 }, (_, i) => changeSnippet('alice', 'create', null, { ...draft, title: `Created ${i}` })),
      boundary.pool.query("UPDATE users SET preferences = preferences || '{\"theme\":\"light\"}'::jsonb WHERE id = 'alice'"),
    ]);
    expect(replies.filter(reply => reply.statusCode === 200)).toHaveLength(1);
    expect(replies.filter(reply => reply.statusCode === 409)).toHaveLength(7);
    const prefs = (await boundary.pool.query("SELECT preferences FROM users WHERE id = 'alice'")).rows[0].preferences;
    expect(prefs.savedSplits).toEqual(replies.find(reply => reply.statusCode === 200).body.savedSplits);
    expect(prefs.savedSplitsRevision).toBe(1); expect(prefs.theme).toBe('light');
    expect(prefs.snippets).toHaveLength(8);
    expect((await boundary.pool.query("SELECT preferences FROM users WHERE id = 'bob'")).rows[0].preferences).toEqual({});
  });

  it('edit/delete races have exactly one winner and never resurrect a deleted snippet', async () => {
    const snippet = await changeSnippet('alice', 'create', null, draft);
    const outcomes = await Promise.allSettled([
      changeSnippet('alice', 'delete', snippet.id, { version: 1 }),
      changeSnippet('alice', 'update', snippet.id, { ...draft, title: 'Changed', version: 1 }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    expect([404, 409]).toContain(failed.reason.status);
    const remaining = await listSnippets('alice');
    if (outcomes[0].status === 'fulfilled') expect(remaining).toEqual([]);
    else expect(remaining).toMatchObject([{ id: snippet.id, title: 'Changed', version: 2 }]);
  });

  it('failed persistence rolls the mutation back and does not consume a version', async () => {
    const snippet = await changeSnippet('alice', 'create', null, draft);
    await boundary.pool.query(`ALTER TABLE users ADD CONSTRAINT forbid_test_title CHECK (NOT jsonb_path_exists(preferences, '$.snippets[*] ? (@.title == "Fail this write")'))`);
    try {
      await expect(changeSnippet('alice', 'update', snippet.id, { ...draft, title: 'Fail this write', version: 1 })).rejects.toMatchObject({ code: '23514' });
      expect(await listSnippets('alice')).toEqual([snippet]);
      const saved = await changeSnippet('alice', 'update', snippet.id, { ...draft, title: 'Retry', version: 1 });
      expect(saved.version).toBe(2);
    } finally { await boundary.pool.query('ALTER TABLE users DROP CONSTRAINT forbid_test_title'); }
  });
});
