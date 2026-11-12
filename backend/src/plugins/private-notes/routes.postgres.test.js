import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const boundary = vi.hoisted(() => ({ pool: null }));
vi.mock('../../services/db.js', () => ({
  query: (...args) => boundary.pool.query(...args),
  withTransaction: async fn => {
    const client = await boundary.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('../api.js', async () => ({
  storage: await vi.importActual('../storage.js'),
  ...(await vi.importActual('../../services/mailAccess.js')),
  requireAuth: (_req, _res, next) => next(), isPluginActivated: async () => true,
}));
import router from './routes.js';
import * as storage from '../storage.js';
import { getOwnedThreadIdentities } from '../../services/mailAccess.js';
const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherAccount = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const first = '33333333-3333-4333-8333-333333333333';
const second = '44444444-4444-4444-8444-444444444444';
const noteA = '55555555-5555-4555-8555-555555555555';
const noteB = '66666666-6666-4666-8666-666666666666';

const call = async (id, method = 'get', body = {}, owner = user, noteId = null) => {
  const path = noteId ? '/:messageId/:noteId' : '/:messageId';
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  const req = { session: { userId: owner }, params: { messageId: id, noteId }, body };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler(req, res, error => { throw error; });
  return res;
};
const add = (id, text, requestId, version = null) => call(id, 'post', { text, requestId, version });

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('private note continuity on disposable PostgreSQL', () => {
  let admin;
  const schema = `private_notes_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    boundary.pool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
    await boundary.pool.query(`CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id));
      CREATE TABLE messages (id uuid PRIMARY KEY, account_id uuid REFERENCES email_accounts(id), message_id text,
        thread_id text, thread_key text GENERATED ALWAYS AS (COALESCE(thread_id,id::text)) STORED,
        in_reply_to text, thread_references text, is_deleted boolean DEFAULT false);
      CREATE TABLE plugin_data (plugin_id varchar(64), key varchar(255), owner_id uuid REFERENCES users(id),
        value jsonb NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT now(), PRIMARY KEY(plugin_id,key));
      INSERT INTO users VALUES ('${user}'), ('${other}');
      INSERT INTO email_accounts VALUES ('${account}','${user}'), ('${otherAccount}','${user}')`);
  });
  beforeEach(async () => {
    await boundary.pool.query('DELETE FROM plugin_data; DELETE FROM messages');
    await boundary.pool.query(`INSERT INTO messages(id,account_id,message_id,thread_id) VALUES ($1,$3,'<a>','<a>'),($2,$3,'<b>','<b>')`, [first, second, account]);
  });
  afterAll(async () => { await boundary.pool?.end(); await admin?.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  it('preserves both provisional roots, repairs links on read, and retains them after physical expunge', async () => {
    expect((await add(first, 'First note', noteA)).statusCode).toBe(201);
    expect((await add(second, 'Second note', noteB)).statusCode).toBe(201);
    await boundary.pool.query("UPDATE messages SET thread_id='<root>',thread_references='<root>'");
    const merged = (await call(second)).body;
    expect(merged.notes.map(note => note.text)).toEqual(['First note', 'Second note']);
    await boundary.pool.query('DELETE FROM messages WHERE id=$1', [first]);
    expect((await call(second)).body.notes).toEqual(merged.notes);
    expect((await add(second, 'First note', noteA)).body.notes).toHaveLength(2);
    const current = (await call(second)).body;
    expect((await call(second, 'delete', { version: current.version }, user, noteA)).body.notes.map(note => note.text)).toEqual(['Second note']);
    expect(JSON.stringify((await boundary.pool.query('SELECT value FROM plugin_data')).rows)).not.toContain('First note');
  });
  it('commits a sibling note and root discovery link together before that sibling is expunged', async () => {
    await boundary.pool.query("UPDATE messages SET thread_id='<root>',thread_references='<root>'");
    await add(first, 'Survives without an intervening read', noteA);
    await boundary.pool.query('DELETE FROM messages WHERE id=$1', [first]);
    expect((await call(second)).body.notes[0].text).toBe('Survives without an intervening read');
  });
  it('serializes concurrent alias growth and preserves both notes after explicit retry', async () => {
    await boundary.pool.query("UPDATE messages SET thread_id='<root>'");
    const results = await Promise.all([add(first, 'First concurrent', noteA), add(second, 'Second concurrent', noteB)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    const current = (await call(first)).body;
    const retry = results[0].statusCode === 409 ? [first, 'First concurrent', noteA] : [second, 'Second concurrent', noteB];
    expect((await add(...retry, current.version)).statusCode).toBe(201);
    await boundary.pool.query('DELETE FROM messages WHERE id=$1', [first]);
    expect((await call(second)).body.notes).toHaveLength(2);
  });
  it('rolls back earlier batch records when a later alias write fails', async () => {
    await boundary.pool.query("ALTER TABLE plugin_data ADD CONSTRAINT reject_alias CHECK (key <> 'reject-alias')");
    try {
      await expect(storage.putOwnedBatch('test', user, [
        { key: 'note', value: { text: 'Must roll back' }, expectedRevision: null },
        { key: 'reject-alias', value: { anchors: ['note'] }, expectedRevision: null },
      ], { guards: [{ key: 'note', revision: null }, { key: 'reject-alias', revision: null }] })).rejects.toMatchObject({ code: '23514' });
      expect(await storage.getOwned('test', user, 'note')).toBeNull();
    } finally { await boundary.pool.query('ALTER TABLE plugin_data DROP CONSTRAINT reject_alias'); }
  });
  it('rejects foreign-owner alias targets and keeps equal RFC IDs in separate accounts', async () => {
    const foreign = await storage.putOwned('test', other, 'foreign', {}, { expectedRevision: null });
    expect(await storage.putOwnedBatch('test', user, [{ key: 'own', value: {}, expectedRevision: null }], {
      guards: [{ key: 'foreign', revision: foreign.revision }],
    })).toBeNull();
    expect(await storage.getOwned('test', user, 'own')).toBeNull();
    await add(first, 'Account A only', noteA);
    expect((await call(first, 'get', {}, other)).statusCode).toBe(404);
    const separate = randomUUID();
    await boundary.pool.query("INSERT INTO messages(id,account_id,message_id,thread_id) VALUES ($1,$2,'<a>','<a>')", [separate, otherAccount]);
    expect((await call(separate)).body.notes).toEqual([]);
    expect(await getOwnedThreadIdentities(other, first)).toEqual([]);
  });
  it('erases duplicate plaintext at all pre-merge anchors and retains idempotency tombstones', async () => {
    await add(first, 'Repeated submission', noteA); await add(second, 'Repeated submission', noteA);
    await boundary.pool.query("UPDATE messages SET thread_id='<root>'");
    const merged = (await call(first)).body;
    expect(merged.notes).toHaveLength(1);
    expect((await call(second, 'delete', { version: merged.version }, user, noteA)).body.notes).toEqual([]);
    expect(JSON.stringify((await boundary.pool.query('SELECT value FROM plugin_data')).rows)).not.toContain('Repeated submission');
    expect((await add(second, 'Repeated submission', noteA)).body.notes).toEqual([]);
  });
  it('refuses oversized identities rather than omitting private data', async () => {
    await boundary.pool.query("UPDATE messages SET thread_id='<root>'");
    await boundary.pool.query("INSERT INTO messages(id,account_id,message_id,thread_id) SELECT gen_random_uuid(),$1,'<' || i || '>','<root>' FROM generate_series(1,100) i", [account]);
    expect((await call(first)).statusCode).toBe(413);
    await expect(storage.putOwnedBatch('test', user, Array.from({ length: 21 }, (_, i) => ({ key: String(i), value: {}, expectedRevision: null })), { guards: [{ key: 'x', revision: null }] })).rejects.toThrow();
  });
});
