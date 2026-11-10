import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../services/db.js', () => ({
  query: (...args) => h.client.query(...args),
  withTransaction: async fn => {
    await h.client.query('BEGIN');
    try { const result = await fn(h.client); await h.client.query('COMMIT'); return result; }
    catch (err) { await h.client.query('ROLLBACK'); throw err; }
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: '22222222-2222-4222-8222-222222222222' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowNonstandardPorts: true }) }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: async () => null }));
import 'express-async-errors';
import express from 'express';
import accountRoutes from './accounts.js';

const ID = '44444444-4444-4444-4444-444444444444';
const GENERATION = '55555555-5555-4555-8555-555555555555';
// Only connection-local temporary tables in an explicitly supplied test database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('atomic account identity edit on PostgreSQL', () => {
  let server, base;
  beforeAll(async () => {
    h.client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await h.client.connect();
    await h.client.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid, storage_generation uuid NOT NULL,
        oauth_provider text, protocol text DEFAULT 'imap', enabled boolean DEFAULT false, email_address text,
        imap_host text, imap_port integer, auth_user text, name text CHECK(name <> 'reject-write'));
      CREATE TEMP TABLE messages (id uuid DEFAULT gen_random_uuid(), account_id uuid);
      CREATE TEMP TABLE folders (account_id uuid);
      CREATE TEMP TABLE scheduled_messages(account_id uuid,status text);
      CREATE TEMP TABLE inbox_rules(account_id uuid,enabled boolean);
      CREATE TEMP TABLE unfetchable_uids (account_id uuid);
      CREATE TEMP TABLE message_entities (id uuid DEFAULT gen_random_uuid(), account_id uuid, storage_generation uuid);
      CREATE TEMP TABLE entity_locations (account_id uuid, storage_generation uuid, status text);
      CREATE TEMP TABLE mail_identity_operations (account_id uuid, storage_generation uuid, state text, evidence jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now());
    `);
    const app = express(); app.use(express.json()); app.use('/api/accounts', accountRoutes);
    app.use((err, _req, res, next) => { void next; res.status(500).json({ error: err.message }); });
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts/${ID}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.client?.end();
  });
  beforeEach(async () => {
    await h.client.query('TRUNCATE email_accounts, messages, folders, unfetchable_uids, message_entities, entity_locations, mail_identity_operations');
    await h.client.query(`INSERT INTO email_accounts(id,user_id,storage_generation,email_address,imap_host,imap_port,auth_user,name)
      VALUES($1,'22222222-2222-4222-8222-222222222222',$2,'me@example.com','imap.example.com',993,'me','Before')`, [ID, GENERATION]);
    for (const table of ['messages', 'folders', 'unfetchable_uids']) await h.client.query(`INSERT INTO ${table}(account_id) VALUES($1)`, [ID]);
    await h.client.query('INSERT INTO message_entities(account_id,storage_generation) VALUES($1,$2)', [ID, GENERATION]);
    await h.client.query("INSERT INTO entity_locations(account_id,storage_generation,status) VALUES($1,$2,'verified')", [ID, GENERATION]);
    await h.client.query("INSERT INTO mail_identity_operations(account_id,storage_generation,state) VALUES($1,$2,'prepared')", [ID, GENERATION]);
  });
  const put = body => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedStorageGeneration: GENERATION, auth_user: 'other', ...body }) });
  const current = async () => (await h.client.query('SELECT * FROM email_accounts')).rows[0];
  const count = async table => Number((await h.client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  it('keeps generation and metadata together on preserve without recertifying locations', async () => {
    const res = await put({ storageIdentityDecision: 'preserve' });
    expect(res.status).toBe(200);
    expect(await current()).toMatchObject({ storage_generation: GENERATION, auth_user: 'other' });
    expect(await count('messages')).toBe(1);
    expect((await h.client.query('SELECT state FROM mail_identity_operations')).rows[0].state).toBe('prepared');
  });
  it('replaces generation/cache atomically while retaining old durable metadata', async () => {
    const res = await put({ storageIdentityDecision: 'replace' });
    expect(res.status).toBe(200);
    const account = await current();
    expect(account.storage_generation).not.toBe(GENERATION);
    expect(account.auth_user).toBe('other');
    for (const table of ['messages', 'folders', 'unfetchable_uids']) expect(await count(table)).toBe(0);
    expect(await count('message_entities')).toBe(1);
    expect((await h.client.query('SELECT storage_generation FROM message_entities')).rows[0].storage_generation).toBe(GENERATION);
    expect((await h.client.query('SELECT state FROM mail_identity_operations')).rows[0].state).toBe('unresolved');
  });
  it('rolls back cache deletion and generation rotation when the account update fails', async () => {
    const res = await put({ storageIdentityDecision: 'replace', name: 'reject-write' });
    expect(res.status).toBe(500);
    expect(await current()).toMatchObject({ storage_generation: GENERATION, auth_user: 'me', name: 'Before' });
    for (const table of ['messages', 'folders', 'unfetchable_uids', 'message_entities']) expect(await count(table)).toBe(1);
    expect((await h.client.query('SELECT status FROM entity_locations')).rows[0].status).toBe('verified');
    expect((await h.client.query('SELECT state FROM mail_identity_operations')).rows[0].state).toBe('prepared');
  });
});
