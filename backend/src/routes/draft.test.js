import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/messageIdentity.js', async original => ({ ...await original(),
  captureMessageSource: vi.fn(async (account, folderPath, uid, expectedSource) => ({
    context: { accountId: account.id, storageGeneration: account.storage_generation, folderPath, uidValidity: '9', revision: '1' }, expectedSource,
  })), assertExpectedSource: vi.fn(async () => {}),
  withMailboxIdentity: vi.fn(async (_context, run) => run({ query })),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  appendToFolder: vi.fn(),
  findUidByMessageId: vi.fn(),
  upsertDraftMessageRecord: vi.fn(),
  permanentDeleteMessage: vi.fn(),
  syncFolderOnDemand: vi.fn(),
  broadcast: vi.fn(),
  scheduleCountRefresh: vi.fn(),
}));
// What the user's other tabs are told: the Inbox re-checks its reply-draft markers on it.
const draftsChanged = () => imapManager.broadcast.mock.calls.filter(([event]) => event.type === 'drafts_changed')
  .map(([event, userId]) => [event.accountId, userId]);
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes, { deleteSentDraft } from './draft.js';
import { query } from '../services/db.js';
import { assertExpectedSource } from '../services/messageIdentity.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'matthias@mailflow.sh', name: 'Matt',
  sender_name: null, signature: null, folder_mappings: {}, user_id: 'user-1', enabled: true,
  storage_generation: '33333333-3333-4333-8333-333333333333',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', draftRoutes);
  return app;
}

describe('POST /api/mail/draft — local row persistence', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.findUidByMessageId.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    // 1) owner check, 2) buildRawDraft account load, 3) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts', draftSource: null });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it('passes verified APPEND proof directly to the draft cache without exposing it in the response', async () => {
    const identityContext = { accountId: ACCOUNT_ID, folderPath: 'Drafts', uidValidity: '9', revision: '2' };
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: 5, identityContext });
    const response = await fetch(`${base}/api/mail/draft`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['friend@example.test'], subject: 'Draft', body: 'Body' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('identityContext');
    expect(imapManager.upsertDraftMessageRecord.mock.calls[0][3].identityContext).toEqual({ ...identityContext, expectedOwnerId: 'user-1' });
  });

  it('persists a Drafts row with parsed recipient, subject and body after append', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID,
        to: ['Mike Scanlan <mike@scanlan.ai>'],
        cc: [],
        subject: 'Re: MailFlow hero',
        body: 'hello mike',
        bodyIsHtml: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts', draftSource: null });

    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledTimes(1);
    const [acct, folder, uid, meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(acct.id).toBe(ACCOUNT_ID);
    expect(folder).toBe('Drafts');
    expect(uid).toBe(5);
    expect(meta.to).toEqual([{ name: 'Mike Scanlan', email: 'mike@scanlan.ai' }]);
    expect(meta.subject).toBe('Re: MailFlow hero');
    expect(meta.fromEmail).toBe('matthias@mailflow.sh');
    expect(meta.bodyHtml).toContain('hello mike');
    expect(meta.bodyText).toContain('hello mike');
    expect(meta.messageId).toMatch(/^<[0-9a-f]+@mailflow\.sh>$/);
  });

  it('stores explicit plain mode as plain-only MIME and a plain-only local row', async () => {
    const signature = 'Me <me@example.com>\nA  & B <b>literal</b>';
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, body: 'Hi <you>', bodyIsHtml: false,
        plaintextEmail: true, editedSignature: signature }),
    });
    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).not.toContain('text/html');
    expect(imapManager.upsertDraftMessageRecord.mock.calls[0][3]).toMatchObject({
      bodyHtml: null, bodyText: 'Hi <you>\n\n-- \n' + signature,
    });
  });

  it('safely converts rich input and quote when saving a plain draft with attachments', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, plaintextEmail: true, bodyIsHtml: true,
        body: '<p>A &amp; B</p><script>unsafe()</script>', editedSignature: '<b>Me</b>',
        quotedBodyHtml: '<p>Earlier</p>', attachments: [{ filename: 'note.txt', contentBase64: 'aGk=' }] }),
    });
    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    expect(raw).toContain('multipart/mixed');
    expect(raw).not.toContain('text/html');
    expect(raw).toContain('A & B');
    expect(raw).toContain('Earlier');
    expect(raw).not.toContain('unsafe()');
  });

  it('rejects non-boolean draft modes without writing a draft', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, body: 'Hi', plaintextEmail: 'false' }),
    });
    expect(res.status).toBe(400);
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
  });

  it("tells the user's other tabs that a Drafts folder changed", async () => {
    imapManager.broadcast.mockReset();
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: [], subject: 'Re: x', body: 'b', bodyIsHtml: false }),
    });
    expect(res.status).toBe(200);
    expect(draftsChanged()).toEqual([[ACCOUNT_ID, 'user-1']]);
    expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['Drafts']); // #643: the Drafts total follows
  });

  it('still returns the saved draft when that notice fails', async () => {
    imapManager.broadcast.mockReset().mockImplementation(() => { throw new Error('socket gone'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/api/mail/draft`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: ACCOUNT_ID, to: [], subject: 'Re: x', body: 'b', bodyIsHtml: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts', draftSource: null });
    } finally {
      imapManager.broadcast.mockReset();
      warn.mockRestore();
    }
  });

  it("writes the draft's text part with its lines and characters", async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: [], subject: 's', bodyIsHtml: true,
        body: '<p>Fish &amp; chips &lt;5&gt;</p><p></p><p>caf&eacute;</p>', editedSignature: '<b>Me</b>&nbsp;| A &amp; B' }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls.at(-1);
    expect(meta.bodyText).toBe('Fish & chips <5>\n\ncafé\n\n-- \nMe | A & B');
  });

  it('removes the scheduled message it was made from, only once it is stored and still held (#543)', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const editToken = '44444444-4444-4444-8444-444444444444';
    query.mockResolvedValueOnce({ rows: [{ id }] });
    imapManager.broadcast.mockReset();
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: [], subject: 's', body: 'b', fromScheduled: { id, editToken } }),
    });
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts', draftSource: null, scheduledRemoved: true });
    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM scheduled_messages'));
    expect(del[0]).toMatch(/WHERE id = \$1 AND user_id = \$2 AND status = 'editing' AND edit_token = \$3/);
    expect(del[1]).toEqual([id, 'user-1', editToken]);
    // After the APPEND: the draft is the copy before the scheduled one goes.
    expect(imapManager.appendToFolder.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder.at(-1));
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'scheduled_changed', id, status: 'deleted' }, 'user-1');
  });

  it('keeps the scheduled message when the draft could not be stored', async () => {
    imapManager.appendToFolder.mockRejectedValue(new Error('NO append'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: [], subject: 's', body: 'b',
        fromScheduled: { id: '33333333-3333-4333-8333-333333333333', editToken: '44444444-4444-4444-8444-444444444444' } }),
    });
    expect(res.status).toBe(500);
    expect(query.mock.calls.some(([sql]) => sql.includes('scheduled_messages'))).toBe(false);
  });

  it('returns the newly appended RFC identity when requested', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['recipient@example.test'], body: 'Reply', includeIdentity: true }),
    });
    const result = await res.json();
    expect(result.messageId).toBe(imapManager.upsertDraftMessageRecord.mock.calls[0][3].messageId);
  });

  it('keeps reply headers in MIME and the local draft row, including References-only drafts', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['recipient@example.test'],
        subject: 'Reply', body: 'Reply text', references: '<root@example.test> <parent@example.test>' }),
    });
    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    expect(raw).toMatch(/^References: <root@example.test> <parent@example.test>$/m);
    expect(imapManager.upsertDraftMessageRecord.mock.calls[0][3].references)
      .toBe('<root@example.test> <parent@example.test>');
  });

  it('appends the draft with CRLF line endings (#365)', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['recipient@example.test'],
        subject: 'Hi', body: 'Line one\nLine two', inReplyTo: '<parent@example.test>' }),
    });
    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    expect(raw).toMatch(/\r\nSubject: Hi\r\n/);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('rejects reply-header injection before appending a draft', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, body: 'Reply', inReplyTo: '<parent@example.test>\r\nBcc: attacker@example.test' }),
    });
    expect(res.status).toBe(400);
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
  });

  it('records the Bcc on the local row, the same recipients the server copy carries', async () => {
    // The composer reopens a draft from this row. Without the Bcc here a reopened draft started
    // with none, and its next save replaced the only copy that still had it.
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['alice@example.com'], cc: [],
        bcc: ['Hidden Person <hidden@example.com>', 'plain@example.org'],
        subject: 's', body: 'hello', bodyIsHtml: false,
      }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bcc).toEqual([
      { name: 'Hidden Person', email: 'hidden@example.com' },
      { name: '', email: 'plain@example.org' },
    ]);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    expect(raw).toMatch(/^Bcc: Hidden Person <hidden@example\.com>, plain@example\.org$/m);
  });

  it('records a draft saved without Bcc as an empty list, not as unknown', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['alice@example.com'], subject: 's', body: 'hello' }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bcc).toEqual([]);
  });

  it('marks the signature block so reopening can lift it back out (#432)', async () => {
    // Without the marker the signature stays in the body on reopen and compose renders a second
    // one, so every save/reopen cycle added another copy.
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['mike@scanlan.ai'], cc: [], subject: 's',
        body: 'hello mike', bodyIsHtml: false, editedSignature: '<b>Matt</b>',
      }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bodyHtml).toContain('data-mailflow-signature="1"');
    expect(meta.bodyHtml).toContain('<b>Matt</b>');
    // Exactly one marked block: the splitter refuses to lift an ambiguous draft.
    expect(meta.bodyHtml.match(/data-mailflow-signature/g)).toHaveLength(1);
  });

  it('preserves an explicitly disabled signature with an empty marker', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, signature: '<b>Account signature</b>' }] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['mike@scanlan.ai'], cc: [], subject: 's',
        body: 'hello mike', bodyIsHtml: false, editedSignature: '',
      }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bodyHtml).toContain('<div data-mailflow-signature="1" style="margin-top:16px;color:#555;font-size:13px"></div>');
    expect(meta.bodyHtml).not.toContain('Account signature');
    expect(meta.bodyText).not.toContain('Account signature');
  });

  it('does not mark a missing signature when no override was provided', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['mike@scanlan.ai'], subject: 's', body: 'hello' }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bodyHtml).not.toContain('data-mailflow-signature');
  });

  it('still returns success if the local row persistence throws (append already stored it)', async () => {
    imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('db down'));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts', draftSource: null });
  });

  it('does not persist a row when the append returns no uid and none can be found (no reliable key)', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    imapManager.findUidByMessageId.mockResolvedValueOnce(null);
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });

  // Header searches cannot prove which physical copy an unresolved APPEND created.
  it('retains an unresolved APPEND without adopting a Message-ID search result', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    imapManager.findUidByMessageId.mockResolvedValueOnce(77);
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y', includeIdentity: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ uid: null, folder: 'Drafts', draftSource: null });
    const raw = imapManager.appendToFolder.mock.calls.at(-1)[2].toString();
    expect(raw).toContain(`Message-ID: ${body.messageId}`);
    expect(imapManager.findUidByMessageId).not.toHaveBeenCalled();
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });

  it('still reports an acknowledged save without performing a header lookup', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    imapManager.findUidByMessageId.mockRejectedValueOnce(new Error('connection lost'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: null, folder: 'Drafts', draftSource: null });
  });
});

const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const OLD_ID = '44444444-4444-4444-8444-444444444444';
const NEW_ID = '55555555-5555-4555-8555-555555555555';
const ENTITY_ID = '66666666-6666-4666-8666-666666666666';
const oldDraft = (overrides = {}) => ({ id: OLD_ID, account_id: ACCOUNT_ID, folder: 'Drafts', uid: 4,
  storage_generation: ACCOUNT_ROW.storage_generation, entity_id: ENTITY_ID, uid_validity: '9',
  message_id: '<old-draft@mailflow.sh>', date: '2026-10-21T09:00:00.000Z', from_email: 'matthias@mailflow.sh', subject: 'Hello', ...overrides });
const sourceOf = row => ({ messageId: row.id, accountId: row.account_id, storageGeneration: row.storage_generation,
  entityId: row.entity_id, folder: row.folder, uidValidity: String(row.uid_validity), uid: String(row.uid) });
const deletedRows = () => query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM messages')).map(([, params]) => params);
const expectedDelete = row => ({ expectRow: row, expectedSource: row, expectedOwnerId: 'user-1' });
const deleteParams = row => [row.id, row.account_id, row.folder, Number(row.uid), row.storage_generation, row.uid_validity, row.entity_id];

function sourceFixture({ row = oldDraft(), accounts = [ACCOUNT_ROW], paths = ['Drafts', 'INBOX.Drafts'], special = ['Drafts'] } = {}) {
  const state = { row, accounts, paths, special };
  query.mockReset().mockImplementation(async (sql, params = []) => {
    if (sql.includes('FROM messages m JOIN email_accounts')) return { rows: state.row?.id === params[0] ? [state.row] : [] };
    if (sql.includes('FROM email_accounts')) return { rows: state.accounts.filter(account => account.id === params[0]) };
    if (sql.includes('SELECT path FROM folders') && sql.includes('LIMIT 1')) return { rows: state.special.slice(0, 1).map(path => ({ path })) };
    if (sql.includes('SELECT path FROM folders')) return { rows: state.paths.map(path => ({ path })) };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: (sql.includes('special_use') ? state.special : state.paths).includes(params[1]) ? [{}] : [] };
    return { rows: [], rowCount: 1 };
  });
  assertExpectedSource.mockReset().mockResolvedValue(undefined);
  imapManager.permanentDeleteMessage.mockReset().mockResolvedValue(true);
  imapManager.broadcast.mockReset(); imapManager.scheduleCountRefresh.mockClear();
  imapManager.appendToFolder.mockReset().mockImplementation(async (account, folder) => ({ uid: 5, folder,
    identityContext: { accountId: account.id, storageGeneration: account.storage_generation, folderPath: folder, uidValidity: '9', revision: '1' } }));
  imapManager.upsertDraftMessageRecord.mockReset().mockImplementation(async (account, folder, uid) => oldDraft({ id: NEW_ID, account_id: account.id, folder, uid }));
  return state;
}

describe('POST /api/mail/draft — replacing the previous copy', () => {
  let server, base, state;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => { state = sourceFixture(); });
  const saveDraft = extra => fetch(`${base}/api/mail/draft`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y',
      existingUid: state.row?.uid ?? 4, existingFolder: state.row?.folder ?? 'Drafts',
      existingAccountId: state.row?.account_id ?? ACCOUNT_ID, existingSource: sourceOf(state.row ?? oldDraft()), ...extra }) });
  const expectSaved = async (res, status = 'deleted', folder = 'Drafts') => {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder, draftSource: sourceOf(oldDraft({ id: NEW_ID, uid: 5, folder })),
      cleanup: status === 'deleted' ? { status } : { status, code: 'draft_source_changed' } });
  };

  it('replaces the previous copy when it is in the Drafts folder it just saved to', async () => {
    await expectSaved(await saveDraft());
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 4, 'Drafts', expectedDelete(state.row));
    expect(deletedRows()).toEqual([deleteParams(state.row)]);
  });
  it('accepts a reopened draft (string BIGINT uid) from another canonical Drafts path', async () => {
    state.row = oldDraft({ uid: '12', folder: 'INBOX.Drafts' });
    await expectSaved(await saveDraft());
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 12, 'INBOX.Drafts', expectedDelete(state.row));
  });
  it('replaces its own previous copy even when the drafts mapping is not a synced folder', async () => {
    state.accounts = [{ ...ACCOUNT_ROW, folder_mappings: { drafts: 'Custom' } }]; state.row = oldDraft({ folder: 'Custom' });
    await expectSaved(await saveDraft(), 'deleted', 'Custom');
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Custom', expectedDelete(state.row));
  });
  it('deletes through the previous account when From switches to another owned account', async () => {
    state.accounts.push({ ...ACCOUNT_ROW, id: OTHER_ID }); state.row = oldDraft({ uid: 7, account_id: OTHER_ID });
    await expectSaved(await saveDraft());
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM email_accounts WHERE id = $1 AND user_id = $2'), [OTHER_ID, 'user-1']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE m.id = $1 AND a.user_id = $2'), [OLD_ID, 'user-1']);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: OTHER_ID }), 7, 'Drafts', expectedDelete(state.row));
    expect(deletedRows()).toEqual([deleteParams(state.row)]);
  });
  it('saves the new draft but retains an original in an account the user does not own', async () => {
    state.row = oldDraft({ account_id: OTHER_ID });
    await expectSaved(await saveDraft(), 'retained');
    expect(imapManager.appendToFolder).toHaveBeenCalledOnce(); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(deletedRows()).toEqual([]);
  });
  it('keeps the local row when the server copy is not the draft being replaced', async () => {
    imapManager.permanentDeleteMessage.mockResolvedValue(false);
    await expectSaved(await saveDraft(), 'retained');
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Drafts', expectedDelete(state.row));
    expect(deletedRows()).toEqual([]);
  });
  it('deletes nothing when the exact old physical row is missing', async () => {
    state.row = null; await expectSaved(await saveDraft(), 'retained');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled(); expect(deletedRows()).toEqual([]);
  });
  it('never upgrades a locator-only legacy composer to the current row', async () => {
    await expectSaved(await saveDraft({ existingSource: undefined }), 'retained');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled(); expect(deletedRows()).toEqual([]);
  });
  it('retains the old proof when APPEND cache work replaces its locator', async () => {
    const original = state.row;
    imapManager.upsertDraftMessageRecord.mockImplementation(async (account, folder, uid) => {
      state.row = oldDraft({ id: NEW_ID, uid });
      assertExpectedSource.mockRejectedValueOnce(Object.assign(new Error('Old source changed'), { status: 409 }));
      return state.row;
    });
    await expectSaved(await saveDraft(), 'retained');
    expect(assertExpectedSource).toHaveBeenCalledWith(expect.anything(), original);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled(); expect(deletedRows()).toEqual([]);
  });
  it('saves the draft but never expunges from a non-Drafts folder', async () => {
    state.row = oldDraft({ folder: 'INBOX' }); await expectSaved(await saveDraft(), 'retained');
    expect(imapManager.appendToFolder).toHaveBeenCalledOnce(); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(deletedRows()).toEqual([]);
  });
  it.each([['1:*'], ['1,2,3'], [[1, 2, 3]], ['4abc'], [-1], [1.5]])('never expunges a uid range or non-integer uid %j', async existingUid => {
    await expectSaved(await saveDraft({ existingUid }), 'retained'); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/mail/draft/:uid — Drafts folders only', () => {
  let server, base, state;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => { state = sourceFixture({ row: oldDraft({ uid: 9 }) }); imapManager.syncFolderOnDemand.mockReset(); });
  const del = (folder = 'Drafts', proof = sourceOf(state.row ?? oldDraft({ uid: 9 })), uid = '9') =>
    fetch(`${base}/api/mail/draft/${uid}?accountId=${ACCOUNT_ID}&folder=${encodeURIComponent(folder)}`, { method: 'DELETE',
      headers: proof ? { 'X-Mailflow-Message-Source': encodeURIComponent(JSON.stringify(proof)) } : {} });
  it('deletes the original verified draft and refreshes its counts', async () => {
    const res = await del(); expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true, cleanup: { status: 'deleted' } });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 9, 'Drafts', expectedDelete(state.row));
    expect(deletedRows()).toEqual([deleteParams(state.row)]); expect(draftsChanged()).toEqual([[ACCOUNT_ID, 'user-1']]);
    expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['Drafts']);
  });
  it('requires the original physical row, even when the composer has a saved UID', async () => {
    state.row = null; expect((await del()).status).toBe(409);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled(); expect(deletedRows()).toEqual([]);
  });
  it('retains a legacy discard without proof', async () => {
    expect((await del('Drafts', null)).status).toBe(409); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it('checks the envelope from the original owned physical row', async () => {
    expect((await del()).status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE m.id = $1 AND a.user_id = $2'), [OLD_ID, 'user-1']);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'Drafts', expectedDelete(state.row));
    expect(imapManager.syncFolderOnDemand).not.toHaveBeenCalled();
  });
  it('expunges nothing and preserves cached mail when the provider copy changed', async () => {
    imapManager.permanentDeleteMessage.mockResolvedValue(false);
    const res = await del(); expect(res.status).toBe(409); expect((await res.json()).cleanup.status).toBe('retained');
    expect(deletedRows()).toEqual([]); expect(imapManager.syncFolderOnDemand).not.toHaveBeenCalled(); expect(draftsChanged()).toEqual([]);
  });
  it('deletes from another canonical Drafts path', async () => {
    state.row = oldDraft({ uid: 9, folder: 'INBOX.Drafts' }); expect((await del('INBOX.Drafts')).status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'INBOX.Drafts', expectedDelete(state.row));
  });
  it('refuses a non-Drafts folder', async () => {
    state.row = oldDraft({ uid: 9, folder: 'INBOX' }); const res = await del('INBOX'); expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Folder is not a Drafts folder' }); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it('refuses a repeated folder param without touching IMAP', async () => {
    const res = await fetch(`${base}/api/mail/draft/9?accountId=${ACCOUNT_ID}&folder=Drafts&folder=INBOX`, { method: 'DELETE' });
    expect(res.status).toBe(400); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it('deletes from server Drafts when the raw mapping points elsewhere', async () => {
    state.accounts = [{ ...ACCOUNT_ROW, folder_mappings: { drafts: 'INBOX.Drafts' } }];
    expect((await del()).status).toBe(200); expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'Drafts', expectedDelete(state.row));
  });
  it('refuses a folder that is neither mapped nor server Drafts', async () => {
    state.accounts = [{ ...ACCOUNT_ROW, folder_mappings: { drafts: 'INBOX.Drafts' } }]; state.row = oldDraft({ uid: 9, folder: 'Sent' });
    expect((await del('Sent')).status).toBe(400); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it.each(['9garbage', '09', '1:*', '4294967296'])('refuses a noncanonical UID path %s', async uid => {
    expect((await del('Drafts', sourceOf(state.row), uid)).status).toBe(400); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});

describe('deleteSentDraft — the draft of a delivered message', () => {
  let state;
  beforeEach(() => { state = sourceFixture(); });
  const sentDraft = extra => ({ uid: 4, folder: 'Drafts', accountId: ACCOUNT_ID, source: sourceOf(state.row), ...extra });
  it('deletes the verified original and notifies its other tabs', async () => {
    expect(await deleteSentDraft('user-1', ACCOUNT_ROW, sentDraft())).toBe(true);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 4, 'Drafts', expectedDelete(state.row));
    expect(deletedRows()).toEqual([deleteParams(state.row)]); expect(draftsChanged()).toEqual([[ACCOUNT_ID, 'user-1']]);
    expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['Drafts']);
  });
  it('touches nothing outside Drafts', async () => {
    state.row = oldDraft({ folder: 'INBOX' }); expect(await deleteSentDraft('user-1', ACCOUNT_ROW, sentDraft({ folder: 'INBOX' }))).toBe(false);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled(); expect(deletedRows()).toEqual([]);
  });
  it('refuses a UID set', async () => {
    expect(await deleteSentDraft('user-1', ACCOUNT_ROW, sentDraft({ uid: '1:*' }))).toBe(false);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it('refuses a draft in an unowned account', async () => {
    state.row = oldDraft({ account_id: OTHER_ID }); expect(await deleteSentDraft('user-1', ACCOUNT_ROW, sentDraft({ accountId: OTHER_ID }))).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM email_accounts WHERE id = $1 AND user_id = $2'), [OTHER_ID, 'user-1']);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it('retains both provider and cache on a changed envelope', async () => {
    imapManager.permanentDeleteMessage.mockResolvedValue(false); expect(await deleteSentDraft('user-1', ACCOUNT_ROW, sentDraft())).toBe(false);
    expect(deletedRows()).toEqual([]); expect(draftsChanged()).toEqual([]);
  });
  it('never turns failed cleanup into failed delivery', async () => {
    imapManager.permanentDeleteMessage.mockRejectedValue(new Error('IMAP down'));
    expect(await deleteSentDraft('user-1', ACCOUNT_ROW, sentDraft())).toBe(false);
  });
});

describe('POST /api/mail/draft — attachments', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.findUidByMessageId.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 9, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it('appends a base64 attachment to the raw MIME', async () => {
    const content = Buffer.from('%PDF-1.4\n% test\n');
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['repam@repam.fr'], subject: 'Avec PJ', body: 'Bonjour',
        attachments: [{ filename: 'decompte.pdf', contentType: 'application/pdf', contentBase64: content.toString('base64') }],
      }),
    });
    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2];
    expect(Buffer.isBuffer(raw)).toBe(true);
    const text = raw.toString('latin1');
    expect(text).toContain('decompte.pdf');
    expect(text).toContain('application/pdf');
    // The payload is base64-encoded in the MIME, and the row is flagged for the paperclip.
    expect(text.replace(/\r?\n/g, '')).toContain(content.toString('base64'));
    const meta = imapManager.upsertDraftMessageRecord.mock.calls[0][3];
    expect(meta.hasAttachments).toBe(true);
    // No stored body: opening the draft reads it from the server, so its attachments are listed.
    expect(meta.bodyHtml).toBeNull();
    expect(meta.bodyText).toBeNull();
  });

  it('rejects path-like filenames and more than five attachments', async () => {
    for (const attachments of [
      [{ filename: '../evil.pdf', contentBase64: Buffer.from('x').toString('base64') }],
      [{ filename: 'bad\u0000name.pdf', contentBase64: Buffer.from('x').toString('base64') }],
      new Array(6).fill({ filename: 'a.pdf', contentBase64: Buffer.from('x').toString('base64') }),
    ]) {
      const res = await fetch(`${base}/api/mail/draft`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['repam@repam.fr'], subject: 'S', body: 'B', attachments }),
      });
      expect(res.status).toBe(400);
    }
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
  });
});
