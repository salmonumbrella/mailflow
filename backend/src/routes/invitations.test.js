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
import { readInvitationResponse } from '../services/invitationLedger.js';
import { renderRawMessage } from '../services/outgoingMail.js';

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
  if (sql.startsWith('INSERT INTO invitation_response_state')) {
    if (ledger.has(params[0])) return { rows: [], rowCount: 0 };
    ledger.set(params[0], params[1]); return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE invitation_response_state')) {
    if (failLedgerAfterAcceptance && JSON.parse(params[2]).status === 'sent') throw new Error('database unavailable');
    if (ledger.get(params[0]) !== params[1]) return { rows: [], rowCount: 0 };
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
const responseKey = () => [...ledger.keys()].find(key => key.startsWith('invitation_response:'));

describe('authenticated native invitation response API', () => {
  it('requires authentication and scopes messages/accounts before touching IMAP or SMTP', async () => {
    expect((await call('GET', null, null)).status).toBe(401);
    expect((await call('GET', null, STRANGER)).status).toBe(404);
    message.is_deleted = true; expect((await call()).status).toBe(404);
    message.is_deleted = false; account.enabled = false; expect((await call()).status).toBe(404);
    expect(engine.fetchRawMessage).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  });
  it('loads server-owned invitation metadata without sending or exposing raw ICS', async () => {
    const result = await call();
    expect(result.status).toBe(200); expect(result.data.response).toBeNull();
    expect(result.data.invitation).toMatchObject({ organizer: 'lead@example.test', attendee: 'me@example.test', sequence: 3 });
    expect(JSON.stringify(result.data)).not.toContain('BEGIN:VCALENDAR');
    expect(engine.fetchRawMessage.mock.calls[0][3]).toEqual({ maximumBytes: 2097152 });
    expect(sent).not.toHaveBeenCalled();
  });
  it.each([{ to: ['other@example.test'] }, { accountId: STRANGER }, { ics: 'BEGIN:VCALENDAR' }, { aliasId: STRANGER }, { response: 'BOGUS' }])('rejects browser-controlled send fields %j', async extra => {
    const input = await proposal(extra); engine.fetchRawMessage.mockClear();
    expect((await call('POST', input)).status).toBe(400);
    expect(engine.fetchRawMessage).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  });
  it('uses real outgoingMail MIME/SMTP pipeline, preserves REPLY method, and records durable accepted before bookkeeping', async () => {
    resolveSentFolder.mockImplementation(async () => { expect(JSON.parse(ledger.get(responseKey())).status).toBe('sent'); return null; });
    const result = await call('POST', await proposal());
    expect(result.data.response.status).toBe('sent'); expect(sent).toHaveBeenCalledTimes(1);
    const options = sent.mock.calls[0][0];
    expect(options.to).toBe('lead@example.test'); expect(options.from).toContain('me@example.test');
    expect(options.inReplyTo).toBe('<invite@example.test>');
    expect(options.attachments[0].contentType).toBe('text/calendar; charset=utf-8; method=REPLY');
    const raw = (await renderRawMessage(options)).toString();
    expect(raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/i);
    expect(raw).toContain('reply.ics');
    expect([...ledger.values()].join(' ')).not.toContain('lead@example.test');
    expect([...ledger.values()].join(' ')).not.toContain('BEGIN:VCALENDAR');
  });
  it('does not send twice on retries or racing clicks from different tabs', async () => {
    let release;
    sent.mockImplementation(() => new Promise(resolve => { release = () => resolve({ accepted: ['lead@example.test'] }); }));
    const input = await proposal();
    const first = call('POST', input);
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    const duplicate = await call('POST', { ...input, requestId: randomUUID() });
    expect(duplicate.status).toBe(202); expect(duplicate.data.response.status).toBe('pending');
    expect(sent).toHaveBeenCalledTimes(1);
    release(); expect((await first).data.response.status).toBe('sent');
    expect((await call('POST', input)).data.response.status).toBe('sent'); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('allows a deliberate new choice only against the latest saved attempt', async () => {
    const input = await proposal(); const first = await call('POST', input);
    expect((await call('POST', { ...input, response: 'DECLINED', requestId: randomUUID() })).status).toBe(409);
    const next = await call('POST', { ...input, response: 'DECLINED', requestId: randomUUID(), expectedAttemptId: first.data.response.attemptId });
    expect(next.data.response).toMatchObject({ status: 'sent', response: 'DECLINED' });
    expect(sent).toHaveBeenCalledTimes(2);
    expect((await call('POST', input)).status).toBe(409); expect(sent).toHaveBeenCalledTimes(2);
  });
  it('marks known SMTP refusal failed and allows explicit, versioned retry', async () => {
    sent.mockRejectedValueOnce(Object.assign(new Error('refused'), { responseCode: 550, command: 'RCPT TO' }));
    const input = await proposal(); const failure = await call('POST', input);
    expect(failure.data.response.status).toBe('failed');
    expect((await call('POST', { ...input, requestId: randomUUID() })).status).toBe(409);
    const retry = await call('POST', { ...input, requestId: randomUUID(), expectedAttemptId: failure.data.response.attemptId, retry: true });
    expect(retry.data.response.status).toBe('sent'); expect(sent).toHaveBeenCalledTimes(2);
  });
  it('marks a preparation error failed without SMTP delivery', async () => {
    createAccountSmtpTransport.mockRejectedValueOnce(new Error('offline'));
    expect((await call('POST', await proposal())).data.response.status).toBe('failed'); expect(sent).not.toHaveBeenCalled();
  });
  it('marks timeout after SMTP DATA uncertain and never permits a duplicate or changed response', async () => {
    sent.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', smtpStage: { bodyStarted: true } }));
    const input = await proposal(); const result = await call('POST', input);
    expect(result.data.response.status).toBe('uncertain');
    const retry = await call('POST', { ...input, response: 'DECLINED', expectedAttemptId: result.data.response.attemptId, requestId: randomUUID(), retry: true });
    expect(retry.data.response.status).toBe('uncertain'); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('never reclassifies SMTP acceptance as failure when post-send bookkeeping fails', async () => {
    resolveSentFolder.mockRejectedValueOnce(new Error('database down'));
    const result = await call('POST', await proposal());
    expect(result.data.response).toMatchObject({ status: 'sent', sentCopySaved: false }); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('preserves the reservation when accepted delivery cannot be persisted', async () => {
    failLedgerAfterAcceptance = true;
    const input = await proposal(); const result = await call('POST', input);
    expect(result.status).toBe(503);
    expect((await call('POST', input)).data.response.status).toBe('pending'); expect(sent).toHaveBeenCalledTimes(1);
    expect((await readInvitationResponse(responseKey(), Date.now() + 6 * 60_000, { userId: USER, accountId: ACCOUNT })).status).toBe('uncertain');
  });
  it('rejects stale message identities, alias-only attendees, cancelled and forwarded sources', async () => {
    for (const raw of [source().toString().replace('<invite@example.test>', '<reused@example.test>'), source(fixture.replace('mailto:me@example.test', 'mailto:alias@example.test')), source(fixture.replace('METHOD:REQUEST', 'METHOD:CANCEL')), source().toString().replace('From: lead@example.test', 'From: forwarder@example.test')]) {
      engine.fetchRawMessage.mockResolvedValueOnce(Buffer.from(raw));
      expect([409, 422]).toContain((await call()).status);
    }
    expect(sent).not.toHaveBeenCalled();
  });
  it('allows an updated sequence but refuses an older invitation once the newer one was seen', async () => {
    const initial = await proposal(); await call('POST', initial);
    sequence = 4; const updated = await proposal(); expect(updated.revision).not.toBe(initial.revision);
    expect((await call('POST', updated)).data.response.status).toBe('sent');
    sequence = 3; expect((await call('POST', initial)).status).toBe(409); expect(sent).toHaveBeenCalledTimes(2);
  });
  it('remembers an opened cancellation and blocks the original same-sequence request', async () => {
    const input = await proposal();
    engine.fetchRawMessage.mockResolvedValueOnce(Buffer.from(source().toString().replace('method=REQUEST', 'method=CANCEL').replace('METHOD:REQUEST', 'METHOD:CANCEL')));
    expect((await call()).data.code).toBe('cancelled_invitation');
    expect((await call('POST', input)).data.code).toBe('outdated_invitation');
    expect(sent).not.toHaveBeenCalled();
  });
});
