import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/messageIdentity.js', async original => ({ ...await original(), ...await import('../services/testSupport/identityTestAdapter.js') }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: vi.fn(), fetchMultipleAttachments: vi.fn() } }));
import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
const id = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const generation = '33333333-3333-4333-8333-333333333333';
const entityId = '44444444-4444-4444-8444-444444444444';
const account = { id: accountId, user_id: 'owner', storage_generation: generation, enabled: true };
const source = () => ({ messageId: id, accountId, storageGeneration: generation, entityId, folder: '受信トレイ', uidValidity: '10', uid: '7' });
const headers = value => ({ 'X-Mailflow-Message-Source': encodeURIComponent(JSON.stringify(value)) });
let server, base, row;
beforeAll(async () => {
  const app = express(); app.use('/api/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail/messages/${id}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  row = { id, account_id: accountId, storage_generation: generation, entity_id: entityId, folder: '受信トレイ', uid: 7, uid_validity: '10', is_deleted: false,
    subject: 'Original', attachments: [{ part: '2', filename: 'original.pdf', type: 'application/pdf', size: 13 }] };
  query.mockReset().mockImplementation(async (sql, params) => {
    if (sql.includes('FROM messages m')) return { rows: params[1] === 'owner' && account.enabled && !row.is_deleted ? [{ ...row }] : [] };
    if (sql.includes('FROM email_accounts')) return { rows: account.enabled ? [{ ...account }] : [] };
    return { rows: [] };
  });
  account.enabled = true;
  imapManager.fetchAttachment.mockReset().mockResolvedValue(Buffer.from('%PDF-original'));
  imapManager.fetchMultipleAttachments.mockReset().mockResolvedValue(new Map([['2', Buffer.from('%PDF-original')]]));
});

describe.each(['/attachments/2', '/attachments.zip'])('attachment response %s', path => {
  const fetchMethod = () => path.endsWith('.zip') ? imapManager.fetchMultipleAttachments : imapManager.fetchAttachment;
  it('accepts an exact Unicode-folder proof and binds the original row into the engine call', async () => {
    const response = await fetch(base + path, { headers: headers(source()) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await response.arrayBuffer();
    expect(fetchMethod().mock.calls[0][4]).toEqual({ expectedSource: row });
  });
  it.each(['messageId', 'accountId', 'storageGeneration', 'entityId', 'folder', 'uidValidity', 'uid'])('refuses a stale clicked %s before the engine fetch', async key => {
    const old = source();
    old[key] = key === 'folder' ? 'Old folder' : ['uid', 'uidValidity'].includes(key) ? '99' : '99999999-9999-4999-8999-999999999999';
    const response = await fetch(base + path, { headers: headers(old) });
    expect(response.status).toBe(409);
    expect(fetchMethod()).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...source(), uid: null }, { ...source(), uid: '0' }, { ...source(), extra: true }])('refuses a malformed or partial proof %j', async value => {
    const response = await fetch(base + path, { headers: headers(value) });
    expect(response.status).toBe(400);
    expect(fetchMethod()).not.toHaveBeenCalled();
  });
  it.each(['%', 'not-json', 'x'.repeat(8193)])('refuses invalid proof encoding or excessive size', async value => {
    const response = await fetch(base + path, { headers: { 'X-Mailflow-Message-Source': value } });
    expect(response.status).toBe(400);
    expect(fetchMethod()).not.toHaveBeenCalled();
  });
  it.each(['entity', 'deleted', 'disabled'])('does not send late bytes after %s replacement', async drift => {
    fetchMethod().mockImplementation(async () => {
      if (drift === 'entity') row.entity_id = '99999999-9999-4999-8999-999999999999';
      if (drift === 'deleted') row.is_deleted = true;
      if (drift === 'disabled') account.enabled = false;
      return path.endsWith('.zip') ? new Map([['2', Buffer.from('wrong bytes')]]) : Buffer.from('wrong bytes');
    });
    const response = await fetch(base + path);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('wrong bytes');
    expect(response.headers.get('content-disposition')).toBeNull();
  });
  it('does not fetch from a disabled account', async () => {
    account.enabled = false;
    expect((await fetch(base + path)).status).toBe(404);
    expect(fetchMethod()).not.toHaveBeenCalled();
  });
  it('keeps declared per-file and total size gates', async () => {
    row.attachments[0].size = 151 * 1024 * 1024;
    expect((await fetch(base + path)).status).toBe(413);
    expect(fetchMethod()).not.toHaveBeenCalled();
  });
  it('checks the actual returned byte length before sending', async () => {
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1);
    fetchMethod().mockResolvedValue(path.endsWith('.zip') ? new Map([['2', oversized]]) : oversized);
    expect((await fetch(base + path)).status).toBe(413);
  });
});
