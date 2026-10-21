import { afterEach, describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    moveMessage: vi.fn(),
    broadcast: vi.fn(), syncFolderOnDemand: vi.fn(),
  },
}));
vi.mock('../services/spamTokenizer.js', () => ({
  tokenize: vi.fn(),
  extractFlagFeatures: vi.fn(),
}));
vi.mock('../services/spamModelStore.js', () => ({
  updateIncrementalForUser: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { tokenize, extractFlagFeatures } from '../services/spamTokenizer.js';
import { updateIncrementalForUser } from '../services/spamModelStore.js';

const USER_ID = 'user-1';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

function startServer() {
  return new Promise(resolve => {
    const server = buildApp().listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Full message row as returned by the moveForSpamLabel SELECT (m.*).
function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    uid: 42,
    folder: 'Junk',
    message_id: '<abc123@example.com>',
    subject: 'Cheap Viagra',
    body_text: 'Click here to buy now',
    body_html: '<p>Click here</p>',
    from_name: 'Spammer',
    from_email: 'spammer@spoof.net',
    attachments: [{ filename: 'invoice.pdf.exe' }],
    is_read: false, provider_msgid: null, source_uid_validity: null, is_archive_residue: false, is_deleted: false,
    ...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  tokenize.mockReset();
  extractFlagFeatures.mockReset();
  updateIncrementalForUser.mockReset();
  imapManager._guardMoveUid.mockReset();
  imapManager._unguardMoveUid.mockReset();
  imapManager.moveMessage.mockReset();
  imapManager.broadcast.mockReset();

  tokenize.mockReturnValue(['cheap', 'viagra', 'buy', 'now']);
  extractFlagFeatures.mockReturnValue({
    dkim_pass: null, spf_pass: null, dmarc_pass: null,
    has_attachment: 1, attachment_is_executable: 1,
    all_caps_subject_ratio: 0, from_equals_reply_to_mismatch: 0,
  });
});

// Match the fenced callback's client.query contract and actual RETURNING source.
// These are non-Gmail NULL-provider fixtures; the PG suite owns identity locks.
function installMessageDb(message) {
  const account = { id: ACCOUNT_ID, folder_mappings: { spam: 'Junk', inbox: 'INBOX' } };
  let stored = { ...message };
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('jsonb_to_recordset')) {
      const captured = JSON.parse(params[0])[0];
      return { rows: captured.id === stored.id && captured.folder === stored.folder ? [{ ...stored }] : [] };
    }
    if (sql.includes('FROM messages m')) return { rows: [{ ...stored, folder_mappings: account.folder_mappings }] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
    if (sql.includes('FROM folders')) return { rows: [{ path: 'Junk' }] };
    if (sql.includes('WITH source AS')) {
      const source = { ...stored }; stored = { ...stored, folder: params[1], uid: params[5][0] ?? stored.uid };
      return { rows: [{ ...source, source_id: source.id, destination_id: stored.id }], rowCount: 1 };
    }
    if (sql.includes('spam_training_log') || sql.includes('UPDATE folders') || sql.includes('UPDATE email_accounts')) return { rows: [] };
    throw new Error(`Unmodelled spam fixture SQL: ${sql}`);
  });
  withTransaction.mockImplementation(async work => {
    const before = { ...stored };
    try { return await work({ query }); } catch (error) { stored = before; throw error; }
  });
}

function getSpamInserts() {
  return query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO spam_training_log'));
}

describe('POST /api/mail/messages/:id/spam — no-op path (already in spam folder)', () => {
  let server;
  let base;

  beforeAll(async () => {
    ({ server, base } = await startServer());
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('stores v0.2 features in spam_training_log and trains incrementally', async () => {
    installMessageDb(messageRow());

    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/spam`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyInFolder: true, folder: 'Junk', unconfirmed: [] });

    const inserts = getSpamInserts();
    expect(inserts).toHaveLength(1);
    const [insertSql, insertParams] = inserts[0];
    expect(insertSql).toContain('token_counts');
    expect(insertSql).toContain('flag_features');
    expect(insertSql).toContain('sender_domain');
    expect(insertSql).toContain('attachment_types');
    expect(insertParams[0]).toBe(USER_ID);
    expect(insertParams[1]).toBe(ACCOUNT_ID);
    // subject + serialized features
    expect(insertParams).toContain('Cheap Viagra');
    expect(insertParams.some(p => typeof p === 'string' && p.includes('"cheap"'))).toBe(true);
    expect(insertParams.some(p => typeof p === 'string' && p.includes('"viagra"'))).toBe(true);

    // Incremental training is fed once with the extracted features.
    expect(updateIncrementalForUser).toHaveBeenCalledTimes(1);
    expect(updateIncrementalForUser).toHaveBeenCalledWith(
      USER_ID, expect.objectContaining({ subject: 'Cheap Viagra' }), 'spam'
    );
  });
});

describe('POST /api/mail/messages/:id/ham — move path (message leaves spam)', () => {
  let server;
  let base;
  beforeAll(async () => {
    ({ server, base } = await startServer());
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('moves to the inbox and trains incrementally with label=ham', async () => {
    installMessageDb(messageRow());

    imapManager.moveMessage.mockResolvedValue(100);

    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/ham`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.unconfirmed).toEqual([]);
    expect(body.folder).toBe('INBOX');

    expect(imapManager.moveMessage).toHaveBeenCalled();

    // Training logged exactly once on the move path, with manual source.
    const inserts = getSpamInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toContain('token_counts');
    expect(inserts[0][1]).toContain(USER_ID);

    expect(updateIncrementalForUser).toHaveBeenCalledTimes(1);
    expect(updateIncrementalForUser).toHaveBeenCalledWith(USER_ID, expect.anything(), 'ham');
  });
});
// Unexpected fence/programming failures must fail these positive fixtures.
let fenceWarnings;
beforeEach(() => { fenceWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { try { expect(fenceWarnings).not.toHaveBeenCalled(); } finally { fenceWarnings.mockRestore(); } });
