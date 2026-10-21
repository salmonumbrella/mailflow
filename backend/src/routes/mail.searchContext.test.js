import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import routes from './mail.js';
import { query } from '../services/db.js';
import { trashFolderExclusionCondition } from './search.js';

// Authoring only. Run RED/GREEN on the lead's named identity/context composition,
// never by copying provider SQL into the frozen grouped-search proof closure.
describe('authorized search conversation context', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let server, base, accounts, rows;
  const request = async (extra = {}, expected = 200) => {
    const response = await fetch(`${base}/thread?${new URLSearchParams({
      id: JSON.stringify([a, 'T']), q: 'Nana', matchedMessageId: id(1), ...extra,
    })}`);
    expect(response.status).toBe(expected);
    return response.json();
  };
  const message = (n, extra = {}) => ({ id: id(n), account_id: a, folder: 'INBOX',
    thread_id: 'T', reply_thread_id: 'T', message_id: '<repeated@synthetic.test>',
    from_email: 'actual-author@synthetic.test', provider_msgid: null, ...extra });
  beforeAll(async () => {
    const app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    accounts = [{ id: a, include_in_unified_inbox: true, imap_host: 'imap.gmail.com' }];
    rows = [message(1), message(2, { folder: 'Sent' })];
    query.mockReset().mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts WHERE user_id')) return { rows: accounts };
      if (sql.includes('AS _provider_identity_verified')) return { rows };
      if (sql.includes('FROM folders')) return { rows: [{ path: sql.includes('special_use = \'\\Trash\'') ? 'Trash' : 'Spam' }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
  });
  it('uses the qualified account/key and preserves physical chronology, authors and raw nullable identity', async () => {
    rows[1] = message(2, { folder: 'Sent', thread_id: null, reply_thread_id: null });
    const body = await request();
    expect(body.messages.map(row => row.id)).toEqual([id(1), id(2)]);
    expect(body.messages[1]).toMatchObject({ reply_thread_id: null, from_email: 'actual-author@synthetic.test' });
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes('AS _provider_identity_verified'));
    expect(values).toEqual([a, 'T']);
    expect(sql).toContain(trashFolderExclusionCondition('m'));
    expect(sql).not.toMatch(/\\Junk|resolveAllSpam/);
    expect(sql).toContain('m.account_id=$1 AND m.thread_key=$2');
    expect(sql).toContain('ORDER BY m.date ASC NULLS FIRST, m.account_id ASC, m.id ASC');
    expect(sql).not.toMatch(/DISTINCT|pg_visible_in_snapshot/);
    expect(body).not.toHaveProperty('complete');
    expect(body.messages[0]).not.toHaveProperty('message_count');
  });
  it.each(['foreign', 'disabled', 'opted-out'])('denies a %s group without reading context', async kind => {
    accounts = kind === 'opted-out' ? [{ ...accounts[0], include_in_unified_inbox: false }] : [];
    await request({}, 403);
    expect(query.mock.calls.some(([sql]) => sql.includes('AS _provider_identity_verified'))).toBe(false);
  });
  it('permits explicit enabled owned opt-out and rejects widening/mismatched account', async () => {
    accounts[0].include_in_unified_inbox = false;
    expect((await request({ accountId: a })).messages).toHaveLength(2);
    await request({ accountId: b }, 403);
  });
  it.each(['not-json', JSON.stringify([a]), JSON.stringify([a, 'T', 'extra'])])('rejects malformed qualified identity %s', async group => {
    await request({ id: group }, 400);
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps an all-folder Spam hit reachable under the same search rule', async () => {
    rows = [message(1, { folder: 'Spam' })];
    expect((await request()).messages[0].folder).toBe('Spam');
  });
  it('uses name-based Deleted Items exclusion identical to production search', async () => {
    await request();
    const [sql] = query.mock.calls.find(([sql]) => sql.includes('AS _provider_identity_verified'));
    expect(sql).toContain(trashFolderExclusionCondition('m'));
    expect(sql).toContain("lower(f.name) LIKE '%deleted%'");
  });
  it('exempts only the explicitly selected exact Trash path', async () => {
    await request({ folder: 'Trash' });
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes('AS _provider_identity_verified'));
    expect(sql).toContain('OR m.folder=$3'); expect(values).toEqual([a, 'T', 'Trash']);
  });
  it('uses actual parser precedence and fuzzy in:trash selected-path exceptions', async () => {
    await request({ q: 'Nana in:trash', folder: 'Sent' });
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes('AS _provider_identity_verified'));
    expect(sql).toContain('OR (m.folder ILIKE $3 OR m.folder ILIKE $4)');
    expect(values).toEqual([a, 'T', 'trash', '%/trash']);
  });
  it('retains same-folder repetitions but suppresses verified provider copies across folders', async () => {
    rows = [message(1, { provider_msgid: 'opaque', _provider_identity_verified: true }),
      message(2, { provider_msgid: 'opaque', _provider_identity_verified: true }),
      message(3, { folder: 'All', provider_msgid: 'opaque', _provider_identity_verified: true })];
    expect((await request()).messages.map(row => row.id)).toEqual([id(1), id(2)]);
  });
  it('preserves the selected physical copy and every repetition in its folder', async () => {
    rows = [message(1, { provider_msgid: 'opaque', _provider_identity_verified: true }),
      message(2, { folder: 'All', provider_msgid: 'opaque', _provider_identity_verified: true }),
      message(3, { folder: 'All', provider_msgid: 'opaque', _provider_identity_verified: true })];
    expect((await request({ matchedMessageId: id(2) })).messages.map(row => row.id)).toEqual([id(2), id(3)]);
  });
  it('does not suppress unknown or stale-epoch provider identity', async () => {
    rows = [message(1), message(2, { folder: 'All', provider_msgid: 'opaque', _provider_identity_verified: false })];
    expect((await request()).messages.map(row => row.id)).toEqual([id(1), id(2)]);
  });
  it('does not substitute another message when the selected physical row is unavailable', async () => {
    await request({ matchedMessageId: id(99) }, 404);
  });
});
