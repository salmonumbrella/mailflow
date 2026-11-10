import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pool: null, userId: null, afterAccountRead: null }));
vi.mock('../services/db.js', () => ({ pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args) }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: h.userId }; next(); } }));
vi.mock('../services/inboxRules.js', () => ({ applyInboxRules: vi.fn(), isDangerousRegex: () => false, RULE_CATEGORIES: new Set() }));
vi.mock('../services/ownership.js', async original => {
  const actual = await original();
  return { ...actual, findOwnedAccount: async (...args) => {
    const account = await actual.findOwnedAccount(...args);
    if (h.afterAccountRead) await h.afterAccountRead(account);
    return account;
  } };
});

import express from 'express';
import { runMigrations } from '../services/migrations.js';
import routes from './rules.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN_URL)('account rule provenance on PostgreSQL', () => {
  let admin, server, base, account;
  const dbName = `mailflow_rules_gen_${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString() });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    h.userId = (await h.pool.query("INSERT INTO users(username) VALUES ('rules') RETURNING id")).rows[0].id;
    const app = express();
    app.use(express.json());
    app.use('/rules', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/rules`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    h.afterAccountRead = null;
    await h.pool.query('DELETE FROM inbox_rules');
    await h.pool.query('DELETE FROM email_accounts');
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address,imap_host) VALUES($1,'Rules','rules@example.com','imap.example.com') RETURNING *", [h.userId])).rows[0];
  });
  const body = extra => ({ name: 'Keep invoices', accountId: account.id, conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions: [{ type: 'star' }], ...extra });
  const call = async (method, path, data) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  const replace = () => h.pool.query('UPDATE email_accounts SET storage_generation=$2 WHERE id=$1', [account.id, randomUUID()]);

  it('captures account provenance while leaving user-wide rules global', async () => {
    expect(await call('POST', '', body())).toMatchObject({ status: 201, body: { storage_generation: account.storage_generation } });
    expect(await call('POST', '', body({ accountId: null }))).toMatchObject({ status: 201, body: { account_id: null, storage_generation: null } });
  });

  it('rejects create prepared against a replaced mailbox with an explicit conflict', async () => {
    h.afterAccountRead = replace;
    expect(await call('POST', '', body())).toMatchObject({ status: 409, body: { code: 'storage_generation_conflict' } });
    expect((await h.pool.query('SELECT * FROM inbox_rules')).rows).toHaveLength(0);
  });

  it('preserves disabled stale rules and never adopts the replacement when enabled or edited', async () => {
    const created = await call('POST', '', body({ enabled: false }));
    await replace();
    expect(await call('PUT', `/${created.body.id}`, body({ enabled: false, name: 'Held invoice rule' }))).toMatchObject({ status: 200, body: { enabled: false, storage_generation: account.storage_generation } });
    expect(await call('PUT', `/${created.body.id}`, body({ enabled: true }))).toMatchObject({ status: 409, body: { code: 'storage_generation_conflict' } });
    expect((await h.pool.query('SELECT * FROM inbox_rules WHERE id=$1', [created.body.id])).rows[0]).toMatchObject({ enabled: false, name: 'Held invoice rule', storage_generation: account.storage_generation });
  });

  it('captures destination provenance when the user explicitly changes the account', async () => {
    const created = await call('POST', '', body({ accountId: null }));
    expect(await call('PUT', `/${created.body.id}`, body())).toMatchObject({ status: 200, body: { account_id: account.id, storage_generation: account.storage_generation } });
  });
});
