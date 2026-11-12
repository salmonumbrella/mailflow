import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })) }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import routes from './invitations.js';
import { query } from '../services/db.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const fixture = readFileSync(new URL('../services/fixtures/invitation.ics', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
const source = text => Buffer.from(`Message-ID: <invite@example.test>\r\nFrom: lead@example.test\r\nTo: me@example.test\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\n${text || fixture}`);
let account, message, ledger, sent, engine, failLedgerAfterAcceptance, sequence;
const flat = sql => sql.replace(/\s+/g, ' ').trim();
async function fakeQuery(sql, params = []) {
  sql = flat(sql);
  if (sql === 'SELECT id FROM users WHERE id = $1') return { rows: [USER, STRANGER].includes(params[0]) ? [{ id: params[0] }] : [] };
  if (sql.includes('FROM messages m JOIN email_accounts')) return { rows: params[0] === MESSAGE && params[1] === USER && !message.is_deleted && account.enabled ? [message] : [] };
  if (sql.includes('FROM email_accounts WHERE')) return { rows: params[0] === ACCOUNT && params[1] === USER && (!sql.includes('enabled = true') || account.enabled) ? [account] : [] };
  if (sql.startsWith('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
  if (sql.startsWith('SELECT value FROM invitation_response_state')) return { rows: ledger.has(params[0]) ? [{ value: ledger.get(params[0]) }] : [] };
  if (sql.startsWith('INSERT INTO invitation_response_state') && sql.includes('GREATEST')) {
    const value = String(Math.max(Number(ledger.get(params[0]) || 0), params[1])); ledger.set(params[0], value); return { rows: [{ value }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO invitation_response_state') && sql.includes("VALUES ($1, '-1'")) {
    if (!ledger.has(params[0])) ledger.set(params[0], '-1');
    return { rows: [{ value: ledger.get(params[0]) }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO invitation_response_state')) {
    if (ledger.has(params[0])) return { rows: [], rowCount: 0 };
    ledger.set(params[0], params[1]); return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE invitation_response_state')) {
    if (failLedgerAfterAcceptance && JSON.parse(params[2]).status === 'sent') throw new Error('database unavailable');
    if (ledger.get(params[0]) !== params[1]) return { rows: [], rowCount: 0 };
    if (sql.includes('cardinality($4::text[])') && params[3].some(key => !ledger.has(key) || Number(ledger.get(key)) > params[4])) return { rows: [], rowCount: 0 };
    ledger.set(params[0], params[2]); return { rows: [], rowCount: 1 };
  }
  return { rows: [{ id: 'contacts', address_book_id: 'contacts' }], rowCount: 1 };
}
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: req.headers['test-user'] || undefined }; next(); });
  app.set('imapManager', { fetchRawMessage: (...args) => engine.fetchRawMessage(...args) });
  app.use('/api/mail', routes);
  app.use((err, _req, res, next) => { void next; res.status(500).json({ error: err.message }); });
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail/messages/${MESSAGE}/invitation`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  ledger = new Map(); failLedgerAfterAcceptance = false; sequence = 3;
  account = { id: ACCOUNT, user_id: USER, email_address: 'me@example.test', name: 'Me', enabled: true, oauth_provider: 'google' };
  message = { id: MESSAGE, account_id: ACCOUNT, uid: 9, folder: 'INBOX', message_id: '<invite@example.test>', is_deleted: false };
  engine = { fetchRawMessage: vi.fn(async () => source(fixture.replace('SEQUENCE:3', `SEQUENCE:${sequence}`))) };
  sent = vi.fn(async () => ({ accepted: ['lead@example.test'], rejected: [] }));
  query.mockReset().mockImplementation(fakeQuery);
  createAccountSmtpTransport.mockReset().mockImplementation(async () => ({ account, transport: { sendMail: sent, close: vi.fn() } }));
  resolveSentFolder.mockReset().mockResolvedValue(null);
});
async function call(method = 'GET', body, user = USER) {
  const res = await fetch(base, { method, headers: { ...(user ? { 'test-user': user } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
const proposal = async (extra = {}) => ({ response: 'ACCEPTED', revision: (await call()).data.invitation.revision, requestId: randomUUID(), expectedAttemptId: null, ...extra });

describe('independent invitation regression review', () => {
  it('negative control: a newer sequence observed before submission blocks stale SMTP', async () => {
    const input = await proposal();
    sequence = 4;
    await call();
    sequence = 3;
    expect((await call('POST', input)).status).toBe(409);
    expect(sent).not.toHaveBeenCalled();
  });
  it('must block an older invitation if a newer one is opened during SMTP preparation', async () => {
    const input = await proposal();
    let release, started;
    const preparing = new Promise(resolve => { started = resolve; });
    createAccountSmtpTransport.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ account, transport: { sendMail: sent, close: vi.fn() } });
      started();
    }));
    const pending = call('POST', input);
    await preparing;
    sequence = 4;
    expect((await call()).status).toBe(200);
    release();
    const result = await pending;
    expect(sent).not.toHaveBeenCalled();
    expect(result.data.response?.status).not.toBe('sent');
  });
  it('must reject an old revision when the organizer changes the duration without a new sequence', async () => {
    const input = await proposal();
    engine.fetchRawMessage.mockResolvedValue(source(fixture.replace('DTEND:20261112T143000Z', 'DTEND:20261112T180000Z')));
    const result = await call('POST', input);
    expect(result.status).toBe(409);
    expect(sent).not.toHaveBeenCalled();
  });
});

it('does not send an occurrence response after the recurring series was cancelled', async () => {
  const occurrence = fixture.replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID:20261112T140000Z');
  engine.fetchRawMessage.mockResolvedValue(source(occurrence));
  const input = await proposal();
  const cancellation = fixture.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('SEQUENCE:3', 'SEQUENCE:4');
  engine.fetchRawMessage.mockResolvedValue(Buffer.from(source(cancellation).toString().replace('method=REQUEST', 'method=CANCEL')));
  expect((await call()).data.code).toBe('cancelled_invitation');
  engine.fetchRawMessage.mockResolvedValue(source(occurrence));
  const result = await call('POST', input);
  expect(sent.mock.calls).toHaveLength(0);
  expect(result.status).toBe(409);
});


it.each([null, 2, 3])('allows an occurrence when master sequence %s does not supersede it', async masterSequence => {
  if (masterSequence !== null) {
    engine.fetchRawMessage.mockResolvedValue(source(fixture.replace('SEQUENCE:3', `SEQUENCE:${masterSequence}`)));
    expect((await call()).status).toBe(200);
  }
  engine.fetchRawMessage.mockResolvedValue(source(fixture.replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID:20261112T140000Z')));
  const result = await call('POST', await proposal());
  expect(result.data.response.status).toBe('sent');
  expect(sent).toHaveBeenCalledTimes(1);
});

it('blocks a master cancellation that arrives while an occurrence response is preparing', async () => {
  const occurrence = fixture.replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID:20261112T140000Z');
  engine.fetchRawMessage.mockResolvedValue(source(occurrence));
  const input = await proposal();
  let release, started;
  const preparing = new Promise(resolve => { started = resolve; });
  createAccountSmtpTransport.mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ account, transport: { sendMail: sent, close: vi.fn() } });
    started();
  }));
  const pending = call('POST', input);
  await preparing;
  const cancellation = fixture.replace('METHOD:REQUEST', 'METHOD:CANCEL');
  engine.fetchRawMessage.mockResolvedValue(Buffer.from(source(cancellation).toString().replace('method=REQUEST', 'method=CANCEL')));
  expect((await call()).data.code).toBe('cancelled_invitation');
  release();
  const result = await pending;
  expect(sent.mock.calls).toHaveLength(0);
  expect(result.data.response).toMatchObject({ status: 'failed', code: 'outdated_invitation' });
});

it('keeps another occurrence cancellation isolated from this occurrence', async () => {
  const other = fixture.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('SEQUENCE:3', 'SEQUENCE:4\r\nRECURRENCE-ID:20261119T140000Z');
  engine.fetchRawMessage.mockResolvedValue(Buffer.from(source(other).toString().replace('method=REQUEST', 'method=CANCEL')));
  expect((await call()).data.code).toBe('cancelled_invitation');
  engine.fetchRawMessage.mockResolvedValue(source(fixture.replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID:20261112T140000Z')));
  const result = await call('POST', await proposal());
  expect(result.data.response.status).toBe('sent');
  expect(sent).toHaveBeenCalledTimes(1);
});
