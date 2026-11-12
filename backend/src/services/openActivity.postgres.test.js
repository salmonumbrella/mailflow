import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import 'express-async-errors';
const h = vi.hoisted(() => ({ pool: null, sendMail: vi.fn() }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args), query: (...args) => h.pool.query(...args) },
  query: (...args) => h.pool.query(...args),
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
import { prepareOpenActivity, setOpenActivityStatus, recordOpenActivity, listOpenActivity, messageOpenActivity, purgeExpiredOpenActivity } from './openActivity.js';
import { validateSendInput, prepareDelivery, deliverAndRecord, renderRawMessage } from './outgoingMail.js';
import { ScheduledSender } from './scheduledSend.js';
import { flushHeldSends } from './sendHold.js';
import sendRouter from '../routes/send.js';
import scheduledRouter from '../routes/scheduled.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL)('open activity real persistence and mocked delivery', () => {
  const dbName = `mailflow_open_${randomBytes(4).toString('hex')}`;
  let admin, user, other, account, second, foreign, server, base;
  beforeAll(async () => {
    vi.stubEnv('APP_URL', 'https://mail.example'); vi.stubEnv('ENCRYPTION_KEY', 'ad'.repeat(32));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    admin = new pg.Client({ connectionString: URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const target = new globalThis.URL(URL); target.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: target.toString(), max: 8 }); await runMigrations();
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('owner') RETURNING id")).rows[0].id;
    other = (await h.pool.query("INSERT INTO users(username) VALUES ('other') RETURNING id")).rows[0].id;
    const add = async (owner, name) => (await h.pool.query("INSERT INTO email_accounts(user_id, name, email_address, imap_host, smtp_host, enabled) VALUES ($1, $2, $3, 'imap.example', 'smtp.example', true) RETURNING *", [owner, name, `${name}@mail.example`])).rows[0];
    account = await add(user, 'owner'); second = await add(user, 'second'); foreign = await add(other, 'other');
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: req.get('x-test-owner') || user }; next(); });
    app.use('/api/mail', sendRouter); app.use('/api/mail', scheduledRouter);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}/api/mail`;
  });
  afterAll(async () => {
    await flushHeldSends(); if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 50)); await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await h.pool.query('DELETE FROM outgoing_open_activity'); await h.pool.query('DELETE FROM scheduled_messages'); await h.pool.query('DELETE FROM kv_store');
    h.sendMail.mockReset().mockResolvedValue({ accepted: ['recipient@mail.example'], rejected: [] });
    vi.stubEnv('APP_URL', 'https://mail.example');
  });
  const row = async id => (await h.pool.query('SELECT * FROM outgoing_open_activity WHERE id=$1', [id])).rows[0];
  const prepare = (extra = {}) => prepareOpenActivity({ userId: user, accountId: account.id, messageId: `<${randomUUID()}@mail.example>`, ...extra });
  const input = (extra = {}) => validateSendInput({ accountId: account.id, to: ['recipient@mail.example'], cc: [], bcc: [], subject: 'Synthetic subject', body: '<p>Hello</p>', bodyIsHtml: true, ...extra });
  const identity = (extra = {}) => ({ account, fromName: 'Owner', fromEmail: account.email_address, signature: '<b>Signature</b>', plaintextEmail: false, ...extra });
  const send = async (extra = {}, key = randomUUID()) => fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key }, body: JSON.stringify({ ...input(extra), ...extra }) });

  it('scopes preparation and reading to owner/account and exposes no token privately', async () => {
    await expect(prepare({ userId: other })).rejects.toMatchObject({ status: 404 });
    const a = await prepare(); const b = await prepare({ accountId: second.id }); await prepare({ userId: other, accountId: foreign.id });
    expect(await listOpenActivity(user, account.id)).toHaveLength(1); expect(await listOpenActivity(user)).toHaveLength(2);
    await expect(listOpenActivity(user, foreign.id)).rejects.toMatchObject({ status: 404 });
    const record = await row(a.id);
    const message = (await h.pool.query("INSERT INTO messages(account_id, uid, folder, message_id, subject, date) VALUES ($1, 101, 'Sent', $2, 'Synthetic title', NOW()) RETURNING id", [account.id, record.message_id])).rows[0];
    expect(await messageOpenActivity(user, message.id)).toMatchObject({ id: a.id, status: 'prepared' });
    expect(await messageOpenActivity(other, message.id)).toBeNull();
    expect(JSON.stringify(await listOpenActivity(user))).not.toContain(record.token);
    expect((await listOpenActivity(user)).map(item => item.id)).toContain(b.id);
  });
  it('reuses an unpredictable 256-bit token for same-message retries under concurrency', async () => {
    const id = '<same@mail.example>';
    const copies = await Promise.all(Array.from({ length: 6 }, () => prepare({ messageId: id })));
    expect(new Set(copies.map(copy => copy.pixel)).size).toBe(1);
    const a = await row(copies[0].id); expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const b = await row((await prepare()).id); expect(a.token).not.toBe(b.token);
    expect(copies[0].pixel).not.toContain('owner'); expect(copies[0].pixel).not.toContain('@');
    expect((await h.pool.query('SELECT COUNT(*)::int AS n FROM outgoing_open_activity')).rows[0].n).toBe(2);
  });
  it('counts only accepted messages, atomically throttles loads and bounds timestamps/counts', async () => {
    const a = await prepare(); const token = (await row(a.id)).token;
    await recordOpenActivity(token); expect((await row(a.id)).load_count).toBe(0);
    await setOpenActivityStatus(a, 'sending'); await recordOpenActivity(token); expect((await row(a.id)).load_count).toBe(0);
    await setOpenActivityStatus(a, 'sent'); await Promise.all(Array.from({ length: 20 }, () => recordOpenActivity(token)));
    let stored = await row(a.id); expect(stored.load_count).toBe(1); expect(stored.first_loaded_at >= stored.sent_at).toBe(true);
    expect(stored.last_loaded_at <= stored.expires_at).toBe(true);
    await h.pool.query("UPDATE outgoing_open_activity SET created_at=NOW()-INTERVAL '2 minutes', sent_at=NOW()-INTERVAL '2 minutes', first_loaded_at=NOW()-INTERVAL '61 seconds', last_loaded_at=NOW()-INTERVAL '61 seconds', load_count=999 WHERE id=$1", [a.id]);
    await recordOpenActivity(token); await recordOpenActivity(token); stored = await row(a.id); expect(stored.load_count).toBe(1000);
    await expect(h.pool.query('UPDATE outgoing_open_activity SET load_count=1001 WHERE id=$1', [a.id])).rejects.toThrow();
    await setOpenActivityStatus(a, 'failed'); expect((await row(a.id)).status).toBe('sent');
  });
  it('ignores unknown/malformed/expired tokens, prunes expiry, cascades owner/account deletion', async () => {
    await recordOpenActivity('invalid'); await recordOpenActivity('a'.repeat(43));
    const a = await prepare(); const token = (await row(a.id)).token;
    await h.pool.query("UPDATE outgoing_open_activity SET created_at=NOW()-INTERVAL '31 days', expires_at=NOW()-INTERVAL '1 day', status='sent', sent_at=NOW()-INTERVAL '31 days' WHERE id=$1", [a.id]);
    await recordOpenActivity(token); expect((await row(a.id)).load_count).toBe(0); expect(await listOpenActivity(user)).toEqual([]);
    await purgeExpiredOpenActivity(); expect(await row(a.id)).toBeUndefined();
    const tmpUser = (await h.pool.query("INSERT INTO users(username) VALUES ('temporary') RETURNING id")).rows[0].id;
    const tmp = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1, 'temporary', 'temporary@mail.example') RETURNING id", [tmpUser])).rows[0].id;
    const tracked = await prepare({ userId: tmpUser, accountId: tmp }); await h.pool.query('DELETE FROM users WHERE id=$1', [tmpUser]); expect(await row(tracked.id)).toBeUndefined();
  });
  it('preserves MIME, signatures, alias identity, plaintext alternative and attachments only with explicit opt-in', async () => {
    for (const value of ['true', 1, null, {}, []]) expect(() => input({ trackOpens: value })).toThrow('boolean');
    vi.stubEnv('APP_URL', 'http://localhost');
    const plain = await prepareDelivery(input(), identity({ plaintextEmail: true }), { attachments: [], messages: [] });
    expect(plain.mailOptions.html).toBeUndefined(); expect(plain.openActivity).toBeUndefined();
    await expect(prepareDelivery(input({ trackOpens: true }), identity(), { attachments: [], messages: [] })).rejects.toMatchObject({ status: 409 });
    vi.stubEnv('APP_URL', 'https://mail.example');
    await expect(prepareDelivery(input({ trackOpens: true }), identity({ plaintextEmail: true }), { attachments: [], messages: [] })).rejects.toMatchObject({ status: 400 });
    const enabled = input({ trackOpens: true, inReplyTo: '<prior@mail.example>', attachments: [{ filename: 'test.txt', content: Buffer.from('Attachment').toString('base64') }] });
    const id = identity({ fromEmail: 'alias@mail.example', replyTo: 'reply@mail.example' });
    const delivery = await prepareDelivery(enabled, id, { attachments: [], messages: [] });
    expect(delivery.mailOptions.html).toContain('<b>Signature</b>'); expect(delivery.mailOptions.text).toContain('Signature');
    expect(delivery.mailOptions.text).not.toContain('/pixel/'); expect(delivery.mailOptions.from).toContain('alias@mail.example');
    expect(delivery.mailOptions.replyTo).toBe('reply@mail.example'); expect(delivery.mailOptions.inReplyTo).toBe('<prior@mail.example>');
    expect(delivery.mailOptions.attachments[0].content.toString()).toBe('Attachment');
    expect(delivery.rawMessage.toString()).toContain('/api/open-activity/pixel/');
    let accepted;
    const result = await deliverAndRecord({ userId: user, input: enabled, identity: id, delivery }, { onDelivered: () => { accepted = true; } });
    expect(result.ok).toBe(true); expect(accepted).toBe(true); expect((await row(delivery.openActivity.id)).status).toBe('sent');
    const actual = await renderRawMessage(h.sendMail.mock.calls[0][0]); expect(actual.toString()).toContain('/api/open-activity/pixel/');
  });
  it('keeps failed and uncertain SMTP outcomes distinct and ignores their image requests', async () => {
    for (const [error, status] of [[{ responseCode: 550 }, 'failed'], [{ code: 'ECONNRESET', smtpStage: { bodyStarted: true } }, 'uncertain']]) {
      const spec = input({ trackOpens: true }); const id = identity(); const delivery = await prepareDelivery(spec, id, { attachments: [], messages: [] });
      h.sendMail.mockRejectedValueOnce(Object.assign(new Error('Synthetic SMTP failure'), error));
      await expect(deliverAndRecord({ userId: user, input: spec, identity: id, delivery })).rejects.toThrow();
      const stored = await row(delivery.openActivity.id); expect(stored.status).toBe(status); expect(stored.sent_at).toBeNull();
      await recordOpenActivity(stored.token); expect((await row(stored.id)).load_count).toBe(0);
    }
  });
  it('Undo cancels prepared tracking and same-key retries never prepare or send twice', async () => {
    const key = randomUUID(); const held = await send({ trackOpens: true, undoSeconds: 30 }, key); expect(held.status).toBe(202);
    const pending = await held.json(); const retry = await send({ trackOpens: true, undoSeconds: 30 }, key); expect((await retry.json()).pendingId).toBe(pending.pendingId);
    expect(h.sendMail).not.toHaveBeenCalled(); expect((await listOpenActivity(user))).toHaveLength(1);
    const cancelled = await fetch(`${base}/send/${pending.pendingId}/cancel`, { method: 'POST' }); expect((await cancelled.json()).cancelled).toBe(true);
    expect((await listOpenActivity(user))[0].status).toBe('cancelled'); expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('persists opt-in when scheduling, sends real MIME with same token after a safe retry, and preserves it after queue purge', async () => {
    const key = randomUUID();
    const request = await fetch(`${base}/scheduled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input({ trackOpens: true }), clientKey: key, sendAt: new Date(Date.now() + 120_000).toISOString() }) });
    expect(request.status, await request.clone().text()).toBe(201); const created = await request.json();
    expect(await listOpenActivity(user)).toEqual([]); // no image/token until the sender prepares it
    await h.pool.query("UPDATE scheduled_messages SET send_at=NOW()-INTERVAL '1 second', due_at=NOW()-INTERVAL '1 second' WHERE id=$1", [created.id]);
    const sender = new ScheduledSender({ db: h.pool, sleep: async () => {} }); sender.running = true; sender.arm = () => {};
    h.sendMail.mockRejectedValueOnce(Object.assign(new Error('Temporary'), { responseCode: 451, smtpStage: { bodyStarted: false } }));
    const first = await sender.claimOne(); await sender.send(first);
    const tracked = (await h.pool.query('SELECT * FROM outgoing_open_activity')).rows[0]; expect(tracked.status).toBe('failed');
    await h.pool.query('UPDATE scheduled_messages SET due_at=NOW() WHERE id=$1', [created.id]);
    await sender.send(await sender.claimOne());
    expect(h.sendMail).toHaveBeenCalledTimes(2);
    expect(h.sendMail.mock.calls[0][0].html).toBe(h.sendMail.mock.calls[1][0].html);
    expect((await row(tracked.id)).status).toBe('sent');
    expect((await h.pool.query('SELECT status FROM scheduled_messages WHERE id=$1', [created.id])).rows[0].status).toBe('sent');
    await h.pool.query('DELETE FROM scheduled_messages WHERE id=$1', [created.id]); expect((await row(tracked.id)).scheduled_id).toBeNull();
  });
  it('enforces the record cap atomically', async () => {
    await h.pool.query("INSERT INTO outgoing_open_activity(user_id, account_id, message_id, token) SELECT $1, $2, '<'||n||'@mail.example>', lpad(n::text,43,'a') FROM generate_series(1,10000) n", [user, account.id]);
    await expect(prepare()).rejects.toMatchObject({ status: 409 });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM outgoing_open_activity')).rows[0].n).toBe(10000);
  });
});
