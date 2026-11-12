import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import 'express-async-errors';

const h = vi.hoisted(() => ({ pool: null, rejectStatus: null, sendMail: vi.fn() }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args), query: (...args) => h.pool.query(...args) },
  query: (sql, params) => {
    if (h.rejectStatus && sql.includes('UPDATE outgoing_open_activity') && params?.[3] === h.rejectStatus) {
      throw new Error('Synthetic activity bookkeeping failure');
    }
    return h.pool.query(sql, params);
  },
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  },
}));
vi.mock('../index.js', () => ({ imapManager: { broadcast: vi.fn(), pluginFacade: {}, appendToSent: vi.fn(), upsertSentMessageRecord: vi.fn(), syncFolderOnDemand: vi.fn() } }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn(async account => ({ account, transport: { sendMail: opts => h.sendMail(opts) } })) }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('./lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
import { runMigrations } from './migrations.js';
import { ScheduledSender } from './scheduledSend.js';
import sendRouter from '../routes/send.js';
import scheduledRouter from '../routes/scheduled.js';

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('independent open activity delivery review', () => {
  const dbName = `mailflow_open_review_${randomBytes(4).toString('hex')}`;
  let admin, owner, account, second, server, base;
  beforeAll(async () => {
    vi.stubEnv('APP_URL', 'https://mail.example'); vi.stubEnv('ENCRYPTION_KEY', 'ba'.repeat(32));
    for (const level of ['log', 'warn', 'error']) vi.spyOn(console, level).mockImplementation(() => {});
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const target = new URL(databaseUrl); target.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: target.toString(), max: 5 }); await runMigrations();
    owner = (await h.pool.query("INSERT INTO users(username) VALUES ('review-owner') RETURNING id")).rows[0].id;
    const add = async name => (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address,imap_host,smtp_host,enabled) VALUES ($1,$2,$3,'imap.example','smtp.example',true) RETURNING *", [owner, name, `${name}@mail.example`])).rows[0];
    account = await add('review-first'); second = await add('review-second');
    const app = express(); app.use(express.json()); app.use((req, res, next) => { req.session = { userId: owner }; next(); });
    app.use('/api/mail', sendRouter); app.use('/api/mail', scheduledRouter);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/mail`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 50)); await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  beforeEach(async () => {
    h.rejectStatus = null;
    await h.pool.query('DELETE FROM outgoing_open_activity'); await h.pool.query('DELETE FROM scheduled_messages'); await h.pool.query('DELETE FROM kv_store');
    h.sendMail.mockReset().mockResolvedValue({ accepted: ['fictional-recipient@mail.example'], rejected: [] });
  });
  const input = (extra = {}) => ({ accountId: account.id, to: ['fictional-recipient@mail.example'], subject: 'Independent review fixture', body: '<p>Fictional</p>', bodyIsHtml: true, trackOpens: true, ...extra });
  const request = (path, body = {}, method = 'POST', headers = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const records = async () => (await h.pool.query('SELECT * FROM outgoing_open_activity ORDER BY created_at')).rows;
  const makeSchedule = async () => {
    const response = await request('/scheduled', { ...input(), clientKey: randomUUID(), sendAt: new Date(Date.now() + 120_000).toISOString() });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()).id;
  };
  const due = id => h.pool.query("UPDATE scheduled_messages SET send_at=NOW()-INTERVAL '1 second', due_at=NOW()-INTERVAL '1 second' WHERE id=$1", [id]);
  const sender = () => { const result = new ScheduledSender({ db: h.pool, sleep: async () => {} }); result.running = true; result.arm = () => {}; return result; };
  const failAttempt = async id => {
    await due(id);
    h.sendMail.mockRejectedValueOnce(Object.assign(new Error('Synthetic safe refusal'), { responseCode: 451, smtpStage: { bodyStarted: false } }));
    const worker = sender(); await worker.send(await worker.claimOne());
    return worker;
  };
  const edit = async (id, extra) => {
    const hold = await request(`/scheduled/${id}/hold`); expect(hold.status).toBe(200);
    const { editToken, version } = await hold.json();
    const response = await request(`/scheduled/${id}`, { ...input(extra), editToken, version, keepAttachments: [], sendAt: new Date(Date.now() + 120_000).toISOString() }, 'PUT');
    expect(response.status, await response.clone().text()).toBe(200);
  };

  it('accepted SMTP plus failing tracking bookkeeping still succeeds and same-key retry does not send twice', async () => {
    h.rejectStatus = 'sent';
    const key = randomUUID();
    const first = await request('/send', input(), 'POST', { 'X-Idempotency-Key': key });
    expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    const retry = await request('/send', input(), 'POST', { 'X-Idempotency-Key': key });
    expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ ok: true });
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect((await records())[0]).toMatchObject({ status: 'sending', sent_at: null, load_count: 0 });
  });

  it('a tracking failure before SMTP cannot send mail or claim acceptance', async () => {
    h.rejectStatus = 'sending';
    const response = await request('/send', input());
    expect(response.status).toBe(500); expect(h.sendMail).not.toHaveBeenCalled();
    expect((await records())[0]).toMatchObject({ status: 'failed', sent_at: null, load_count: 0 });
  });

  it('default-off mail has identical no-tracking behavior even when every tracking status write fails', async () => {
    h.rejectStatus = 'sending';
    const response = await request('/send', input({ trackOpens: false }));
    expect(response.status).toBe(200); expect((await response.json()).ok).toBe(true);
    expect(h.sendMail).toHaveBeenCalledTimes(1); expect(h.sendMail.mock.calls[0][0].html).not.toContain('/open-activity/');
    expect(await records()).toEqual([]);
  });

  it('a failed tracking-state write before scheduled SMTP stays a safe retry instead of uncertain delivery', async () => {
    const id = await makeSchedule(); await due(id); h.rejectStatus = 'sending';
    const worker = sender(); await worker.send(await worker.claimOne());
    expect(h.sendMail).not.toHaveBeenCalled();
    const row = (await h.pool.query('SELECT status, smtp_started_at FROM scheduled_messages WHERE id=$1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'scheduled', smtp_started_at: null });
  });

  it('changing a failed scheduled send to another owned account does not mark its old unsent pixel as sent', async () => {
    const id = await makeSchedule(); const worker = await failAttempt(id);
    const old = (await records())[0]; expect(old.status).toBe('failed');
    await edit(id, { accountId: second.id }); await due(id); await worker.send(await worker.claimOne());
    const rows = await records();
    expect(rows.find(row => row.account_id === second.id)?.status).toBe('sent');
    expect(rows.find(row => row.id === old.id)?.status).not.toBe('sent');
  });

  it('turning tracking off after a safe scheduled failure does not activate that old unsent pixel', async () => {
    const id = await makeSchedule(); const worker = await failAttempt(id);
    expect((await records())[0].status).toBe('failed');
    await edit(id, { trackOpens: false }); await due(id); await worker.send(await worker.claimOne());
    expect(h.sendMail.mock.calls[1][0].html).not.toContain('/open-activity/');
    expect((await records())[0].status).not.toBe('sent');
  });
});
