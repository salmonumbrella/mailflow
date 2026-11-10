import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { gunzipSync, gzipSync } from 'zlib';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null, userId: null }));
vi.mock('../services/db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-user') || h.userId }; next(); } }));
import express from 'express';
import routes from './labels.js';
import { runMigrations } from '../services/migrations.js';
import { restoreBackup, writeBackup } from '../services/backup.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
// CI supplies PostgreSQL 16 and runs this suite as part of npm test. A missing local server
// is an explicit skip, never evidence that the transaction/race/restore invariants passed.
describe.skipIf(!ADMIN_URL)('native label definitions on PostgreSQL', () => {
  const dbName = `mailflow_labels_${randomBytes(4).toString('hex')}`;
  let admin, server, base, account, otherAccount, outsiderAccount, owner, outsider;
  const provider = { broadcast: vi.fn(), moveMessage: vi.fn(), copyMessage: vi.fn(), deleteMessage: vi.fn(), setFlags: vi.fn(), mailboxDelete: vi.fn() };
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '6e'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    owner = (await h.pool.query("INSERT INTO users (username) VALUES ('labels-owner') RETURNING id")).rows[0].id;
    outsider = (await h.pool.query("INSERT INTO users (username) VALUES ('labels-outsider') RETURNING id")).rows[0].id;
    const acct = async (userId, email) => (await h.pool.query(`INSERT INTO email_accounts (user_id,name,email_address,imap_host,smtp_host)
      VALUES ($1,'A',$2,'imap.example.com','smtp.example.com') RETURNING id`, [userId, email])).rows[0].id;
    account = await acct(owner, 'labels@example.com');
    otherAccount = await acct(owner, 'other@example.com');
    outsiderAccount = await acct(outsider, 'outsider@example.com');
    h.userId = owner;
    await h.pool.query(`INSERT INTO messages (account_id,uid,folder,subject,body_text) VALUES ($1,1,'INBOX','Never change me','Payload')`, [account]);
    await h.pool.query(`INSERT INTO folders (account_id,path,name) VALUES ($1,'INBOX','Inbox')`, [account]);
    // Database triggers fail ANY attempted cache write, even if it would otherwise roll back.
    await h.pool.query(`CREATE FUNCTION forbid_label_cache_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Label API attempted a mail cache write'; END $$;
      CREATE TRIGGER no_label_message_write BEFORE INSERT OR UPDATE OR DELETE ON messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_label_cache_write();
      CREATE TRIGGER no_label_folder_write BEFORE INSERT OR UPDATE OR DELETE ON folders FOR EACH STATEMENT EXECUTE FUNCTION forbid_label_cache_write();`);
    const app = express(); app.use(express.json()); app.set('imapManager', provider); app.use('/api/labels', routes);
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/labels`;
  }, 60_000);
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE mail_labels, mail_label_state, mail_label_mutations');
    await h.pool.query('UPDATE email_accounts SET enabled=true');
    vi.clearAllMocks();
  });
  const call = async (method, path = '', body, userId) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(userId ? { 'x-user': userId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, extra = {}, userId) => {
    const response = await call('POST', '', { accountId: account, mutationId: randomUUID(), name, ...extra }, userId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.label;
  };
  const edit = (label, extra) => call('PATCH', `/${label.id}`, { accountId: account, mutationId: randomUUID(), expectedRevision: label.revision, ...extra });
  const list = () => call('GET', `?accountId=${account}`);
  const preview = label => call('POST', `/${label.id}/delete-preview`, { accountId: account });
  const remove = (label, treeRevision, extra = {}) => call('DELETE', `/${label.id}`, { accountId: account, mutationId: randomUUID(), expectedTreeRevision: treeRevision, confirmSubtree: true, ...extra });

  it('persists Unicode names, colors and independent visibility with honest coverage, including disabled accounts', async () => {
    await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account]);
    const parent = await create('  Cafe\u0301 ', { color: '#AABBCC', textColor: '#123456', visibility: 'unread', messageVisible: false });
    await create('Child', { parentId: parent.id });
    const state = await list();
    expect(state.body).toMatchObject({ treeRevision: '2', coverage: 'not_indexed', assignmentSupported: false, counts: null });
    expect(state.body.labels[0]).toMatchObject({ name: 'Café', path: 'Café', color: '#aabbcc', textColor: '#123456', visibility: 'unread', messageVisible: false, counts: null });
    const reset = await edit(parent, { color: null, textColor: null, visibility: 'hide', messageVisible: true });
    expect(reset.body.label).toMatchObject({ color: null, textColor: null, visibility: 'hide', messageVisible: true, revision: '2' });
    const same = await edit(reset.body.label, { color: null });
    expect(same.body.treeRevision).toBe(reset.body.treeRevision);
    expect(provider.broadcast).toHaveBeenCalledTimes(3);
    expect(provider.broadcast).toHaveBeenLastCalledWith({ type: 'labels_changed', accountId: account, treeRevision: '3' }, owner);
  });

  it('enforces normalized root/sibling uniqueness in the service and direct SQL, permitting separate branches', async () => {
    const root = await create('Café');
    const duplicate = await call('POST', '', { accountId: account, name: 'CAFE\u0301', mutationId: randomUUID() });
    expect(duplicate).toMatchObject({ status: 409, body: { code: 'duplicate_name' } });
    const child = await create('Child', { parentId: root.id });
    const other = await create('Other');
    await create('Child', { parentId: other.id });
    const copySql = `INSERT INTO mail_labels(account_id,parent_id,name,normalized_name,full_path) SELECT account_id,parent_id,name,normalized_name,full_path FROM mail_labels WHERE id=$1`;
    await expect(h.pool.query(copySql, [root.id])).rejects.toMatchObject({ code: '23505' });
    await expect(h.pool.query(copySql, [child.id])).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['', '   ', 'a/b', 'a\nb', '\u0000x', 'a\u202eb', 'x'.repeat(101)])('rejects invalid component %j atomically', async name => {
    expect((await call('POST', '', { accountId: account, name, mutationId: randomUUID() })).status).toBe(400);
    expect((await list()).body.labels).toEqual([]);
    expect(provider.broadcast).not.toHaveBeenCalled();
  });

  it('rejects foreign ownership and same-user cross-account parents atomically on all routes', async () => {
    const local = await create('Local');
    const remote = await create('Remote', { accountId: otherAccount });
    const foreign = await create('Foreign', { accountId: outsiderAccount }, outsider);
    for (const parent of [remote, foreign]) {
      expect((await createAttempt({ name: 'Bad', parentId: parent.id })).status).toBe(404);
      expect((await edit(local, { parentId: parent.id })).status).toBe(404);
    }
    for (const [method, path, body] of [
      ['GET', `?accountId=${account}`, undefined],
      ['POST', '', { accountId: account, name: 'Bad', mutationId: randomUUID() }],
      ['PATCH', `/${local.id}`, { accountId: account, name: 'Bad', expectedRevision: '1', mutationId: randomUUID() }],
      ['POST', `/${local.id}/delete-preview`, { accountId: account }],
      ['DELETE', `/${local.id}`, { accountId: account, expectedTreeRevision: '1', confirmSubtree: true, mutationId: randomUUID() }],
    ]) expect((await call(method, path, body, outsider)).status).toBe(404);
    await expect(h.pool.query(`INSERT INTO mail_labels(account_id,parent_id,name,normalized_name,full_path) VALUES ($1,$2,'Bad','bad','Bad')`, [account, remote.id])).rejects.toMatchObject({ code: '23503' });
    expect((await list()).body.labels).toHaveLength(1);
  });
  const createAttempt = extra => call('POST', '', { accountId: account, mutationId: randomUUID(), ...extra });

  it('rejects self/cyclic nesting and subtree move collisions; renaming preserves descendant preferences and IDs', async () => {
    const a = await create('A'), b = await create('B', { parentId: a.id }), c = await create('C', { parentId: b.id, color: '#123456', visibility: 'hide' });
    expect((await edit(a, { parentId: a.id })).status).toBe(400);
    expect((await edit(a, { parentId: c.id })).status).toBe(400);
    const dest = await create('Destination');
    await create('B', { parentId: dest.id });
    expect((await edit(b, { parentId: dest.id })).status).toBe(409);
    const changed = await edit(a, { name: 'Renamed' });
    expect(changed.status).toBe(200);
    expect((await list()).body.labels.find(l => l.id === c.id)).toMatchObject({ path: 'Renamed/B/C', color: '#123456', visibility: 'hide', revision: '2' });
    expect((await edit(c, { color: null })).status).toBe(409);
  });

  it('serializes duplicate creates and reciprocal reparent races', async () => {
    const duplicate = await Promise.all([createAttempt({ name: 'Same' }), createAttempt({ name: 'same' })]);
    expect(duplicate.map(r => r.status).sort()).toEqual([201, 409]);
    const a = await create('A'), b = await create('B');
    const moves = await Promise.all([edit(a, { parentId: b.id }), edit(b, { parentId: a.id })]);
    expect(moves.map(r => r.status).sort()).toEqual([200, 400]);
    expect((await list()).body.labels).toHaveLength(3);
  });

  it('requires fresh subtree confirmation and never removes messages or folders', async () => {
    const beforeMessages = (await h.pool.query('SELECT to_jsonb(m) AS row FROM messages m ORDER BY id')).rows;
    const beforeFolders = (await h.pool.query('SELECT to_jsonb(f) AS row FROM folders f ORDER BY id')).rows;
    const root = await create('Root'), child = await create('Child', { parentId: root.id }), grandchild = await create('Grandchild', { parentId: child.id });
    const unrelated = await create('Keep');
    const first = await preview(root);
    expect(first.body).toMatchObject({ removesMessages: false, counts: null, assignmentSupported: false });
    expect(first.body.descendants.map(l => l.id)).toEqual([child.id, grandchild.id]);
    await create('New child', { parentId: root.id });
    expect((await remove(root, first.body.treeRevision)).status).toBe(409);
    const fresh = await preview(root);
    expect((await remove(root, fresh.body.treeRevision, { confirmSubtree: false })).status).toBe(400);
    const deleted = await remove(root, fresh.body.treeRevision);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedLabelIds).toEqual(fresh.body.deletedLabelIds);
    expect((await list()).body.labels.map(l => l.id)).toEqual([unrelated.id]);
    expect((await h.pool.query('SELECT to_jsonb(m) AS row FROM messages m ORDER BY id')).rows).toEqual(beforeMessages);
    expect((await h.pool.query('SELECT to_jsonb(f) AS row FROM folders f ORDER BY id')).rows).toEqual(beforeFolders);
    for (const [name, spy] of Object.entries(provider)) if (name !== 'broadcast') expect(spy).not.toHaveBeenCalled();
  });

  it('serializes child-create versus subtree-delete without deleting an unconfirmed child', async () => {
    const root = await create('Root'); const snapshot = await preview(root);
    const results = await Promise.all([createAttempt({ name: 'Child', parentId: root.id }), remove(root, snapshot.body.treeRevision)]);
    expect(results.map(r => r.status)).toSatisfy(statuses => JSON.stringify(statuses) === '[201,409]' || JSON.stringify(statuses) === '[404,200]');
    const labels = (await list()).body.labels;
    expect(labels.length === 0 || labels.length === 2).toBe(true);
  });

  it('replays original results after newer edits and deletion, and rejects key reuse or expired keys', async () => {
    const payload = { accountId: account, name: 'Original', mutationId: randomUUID() };
    const first = await call('POST', '', payload);
    await edit(first.body.label, { name: 'Newer' });
    const duplicate = await call('POST', '', payload);
    expect(duplicate).toEqual(first);
    expect((await list()).body.labels[0].name).toBe('Newer');
    expect((await call('POST', '', { ...payload, name: 'Different' })).status).toBe(409);
    const snapshot = await preview(first.body.label);
    const deletion = { accountId: account, expectedTreeRevision: snapshot.body.treeRevision, mutationId: randomUUID(), confirmSubtree: true };
    const deleted = await call('DELETE', `/${first.body.label.id}`, deletion);
    await create('After deletion');
    expect(await call('DELETE', `/${first.body.label.id}`, deletion)).toEqual(deleted);
    expect((await list()).body.labels).toHaveLength(1);
    await h.pool.query("UPDATE mail_label_mutations SET created_at=NOW()-INTERVAL '31 days' WHERE mutation_id=$1", [payload.mutationId]);
    expect(await call('POST', '', payload)).toMatchObject({ status: 409, body: { code: 'mutation_expired' } });
    await create('Prune old response');
    expect((await h.pool.query('SELECT response FROM mail_label_mutations WHERE mutation_id=$1', [payload.mutationId])).rows[0].response).toBeNull();
    expect((await call('POST', '', payload)).status).toBe(409);
  });

  it('serializes concurrent exact retries into one change and protects revision precision', async () => {
    await h.pool.query('INSERT INTO mail_label_state(account_id,tree_revision) VALUES ($1,9007199254740992)', [account]);
    const payload = { accountId: account, name: 'Once', mutationId: randomUUID() };
    const responses = await Promise.all(Array.from({ length: 5 }, () => call('POST', '', payload)));
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0].body.treeRevision).toBe('9007199254740993');
    expect((await list()).body.treeRevision).toBe('9007199254740993');
    expect(provider.broadcast).toHaveBeenCalledTimes(1);
  });

  // Backup uses the real serializer/restore transaction. Split labels into child-first
  // batches to exercise deferred self-FKs, rather than relying on physical heap order.
  it.each(['setup', 'full'])('round-trips nested labels, revision and replay journal in a %s backup', async scope => {
    const root = await create('Root'); await create('Child', { parentId: root.id, color: '#abcdef', messageVisible: false });
    const before = (await list()).body;
    const client = await h.pool.connect();
    try {
      const out = new PassThrough(), chunks = [];
      out.on('data', chunk => chunks.push(chunk));
      await writeBackup(client, { scope, appVersion: 'test', out });
      const lines = gunzipSync(Buffer.concat(chunks)).toString().trim().split('\n').map(JSON.parse);
      const reordered = lines.flatMap(line => line.table === 'mail_labels'
        ? [...line.rows].sort((a, b) => Number(Boolean(b.parent_id)) - Number(Boolean(a.parent_id))).map(row => ({ table: line.table, rows: [row] })) : [line]);
      expect(lines[0].tables).toEqual(expect.arrayContaining(['mail_labels', 'mail_label_state', 'mail_label_mutations']));
      // Full restore intentionally writes cache rows; the definition endpoint tests above
      // leave these guard triggers enabled throughout every API request.
      await client.query('ALTER TABLE messages DISABLE TRIGGER no_label_message_write; ALTER TABLE folders DISABLE TRIGGER no_label_folder_write');
      await restoreBackup(client, Readable.from([gzipSync(reordered.map(JSON.stringify).join('\n') + '\n')]));
      expect((await list()).body).toEqual(before);
      expect((await client.query('SELECT count(*)::int AS n FROM mail_label_mutations')).rows[0].n).toBe(2);
      expect((await client.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(scope === 'full' ? 1 : 0);
      const older = [...reordered]; older[0] = { ...older[0], schemaVersion: '0076_sessions_and_kv_store' };
      await expect(restoreBackup(client, Readable.from([gzipSync(older.map(JSON.stringify).join('\n') + '\n')]))).rejects.toThrow(/older version.*Restore it on that version, then update/);
      expect((await list()).body).toEqual(before);
    } finally {
      // Setup restore removes cache. Re-seed with guards disabled for the next case.
      await client.query('TRUNCATE messages, folders');
      await client.query(`INSERT INTO messages(account_id,uid,folder,subject,body_text) VALUES ($1,1,'INBOX','Never change me','Payload')`, [account]);
      await client.query(`INSERT INTO folders(account_id,path,name) VALUES ($1,'INBOX','Inbox')`, [account]);
      await client.query('ALTER TABLE messages ENABLE TRIGGER no_label_message_write; ALTER TABLE folders ENABLE TRIGGER no_label_folder_write');
      client.release();
    }
  });
});
