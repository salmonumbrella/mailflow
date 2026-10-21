import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), parseMailboxList: () => [{ email: 'bcc@example.test' }] }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));

import { ImapManager } from './imapManager.js';
import { query, withTransaction } from './db.js';
import { parseMessage } from './messageParser.js';

// An explicit test database is required. Every table is connection-local TEMP;
// the real identity helper uses real row/advisory locks and transaction SQL.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('draft ingestion SQL identity boundaries', () => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const messageId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const providerId = '9007199254740993';
  let database, client, commands;
  const snapshot = async () => ({
    accounts: (await database.query('SELECT * FROM email_accounts ORDER BY id')).rows,
    folders: (await database.query('SELECT * FROM folders ORDER BY account_id,path')).rows,
    messages: (await database.query('SELECT * FROM messages ORDER BY id')).rows,
  });

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, enabled boolean NOT NULL);
      CREATE TEMP TABLE folders (
        account_id uuid REFERENCES email_accounts(id), path text, uid_validity bigint,
        special_use text, no_select boolean NOT NULL DEFAULT false,
        PRIMARY KEY(account_id,path)
      );
      CREATE TEMP TABLE messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES email_accounts(id), uid bigint, folder text,
        message_id text, subject text, from_name text, from_email text,
        to_addresses jsonb, cc_addresses jsonb, bcc_addresses jsonb,
        in_reply_to text, thread_references text, thread_id text,
        date timestamptz, flags jsonb, has_attachments boolean, attachments jsonb,
        provider_msgid text, is_read boolean, is_deleted boolean NOT NULL DEFAULT false,
        is_archive_residue boolean NOT NULL DEFAULT false, body_html text, body_text text,
        UNIQUE(account_id, uid, folder)
      )`);
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts');
    await database.query('INSERT INTO email_accounts VALUES ($1,true)', [accountId]);
    await database.query(`INSERT INTO folders(account_id,path,uid_validity,special_use)
      VALUES ($1,'Sent',9,$2),($1,'Archive',11,$3)`, [accountId, '\\Sent', '\\All']);
    commands = [];
    client = { query: vi.fn((sql, values) => database.query(sql, values)) };
    query.mockReset().mockImplementation((sql, values) => database.query(sql, values));
    withTransaction.mockReset().mockImplementation(async work => {
      try {
        commands.push((await database.query('BEGIN')).command);
        const result = await work(client);
        commands.push((await database.query('COMMIT')).command);
        return result;
      } catch (error) {
        commands.push((await database.query('ROLLBACK')).command);
        throw error;
      }
    });
    parseMessage.mockReset();
  });

  const cases = [
    { name: 'same identity and generation retain a canonical root and cached body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '9', current: 9n, oldRoot: '<retained@example.test>', root: '<retained@example.test>', keep: true, verifyRollback: true },
    { name: 'same identity upgrades a self-rooted provisional thread', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '9', current: 9n, oldRoot: '<draft@example.test>', root: '<computed@example.test>', keep: true },
    { name: 'replacement Message-ID recomputes the root and clears the body', oldId: '<old@example.test>', newId: '<draft@example.test>', stored: '9', current: 9n, root: '<computed@example.test>' },
    { name: 'missing new Message-ID clears the old root and body', oldId: '<old@example.test>', newId: null, stored: '9', current: 9n, root: null },
    { name: 'missing stored identity cannot retain a cached body or root', oldId: null, newId: '<draft@example.test>', stored: '9', current: 9n, root: '<computed@example.test>' },
    { name: 'matching empty identities cannot retain a cached body or root', oldId: '', newId: '', stored: '9', current: 9n, root: null },
    { name: 'changed mailbox generation fails closed without changing identity, root or cached body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '8', current: 9n, reject: true },
    { name: 'unknown stored generation fails closed without changing identity, root or cached body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: null, current: 9n, reject: true },
    { name: 'unknown live generation fails closed without changing identity, root or cached body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '9', current: undefined, reject: true, noTransaction: true },
    { name: 'missing folder generation fails closed without changing identity, root or cached body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: undefined, current: 9n, reject: true },
  ];
  it.each(cases)('$name', async ({ oldId, newId, stored, current, oldRoot = '<old-root@example.test>', root, keep, reject, noTransaction, verifyRollback }) => {
    if (stored !== undefined) await database.query(
      'INSERT INTO folders(account_id,path,uid_validity,special_use) VALUES ($1,$2,$3,$4)',
      [accountId, 'Drafts', stored, '\\Drafts']);
    await database.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,thread_id,subject,bcc_addresses,body_html,body_text)
      VALUES ($1,$2,1,'Drafts',$3,$4,'Prior subject',$5::jsonb,'<p>Cached</p>','Cached'),
        ($6,$2,2,'Sent','<known@example.test>','<computed@example.test>','Ancestor','[]'::jsonb,null,null)`,
    [messageId(1), accountId, oldId, oldRoot, JSON.stringify([{ email: 'old-bcc@example.test' }]), messageId(2)]);
    await database.query(`INSERT INTO messages(id,account_id,uid,folder,provider_msgid,is_archive_residue)
      VALUES ($1,$2,3,'Archive',$3,true),($4,$2,4,'Archive','unrelated-provider',true)`,
    [messageId(3), accountId, providerId, messageId(4)]);
    const before = await snapshot();
    expect(before.accounts).toEqual([{ id: accountId, enabled: true }]);
    expect(before.folders.find(row => row.path === 'Drafts')?.uid_validity).toBe(stored);
    expect(before.messages.filter(row => row.is_archive_residue)).toHaveLength(2);

    if (verifyRollback) {
      // A real SQL error must roll back a preceding write through the same
      // client.query adapter; a no-op transaction mock cannot pass this witness.
      await expect(withTransaction(async tx => {
        await tx.query('UPDATE messages SET subject=$1 WHERE id=$2', ['Must roll back', messageId(1)]);
        await tx.query('SELECT 1/0');
      })).rejects.toMatchObject({ code: '22012' });
      expect(commands).toEqual(['BEGIN', 'ROLLBACK']);
      expect(await snapshot()).toEqual(before);
      withTransaction.mockClear(); client.query.mockClear(); commands.length = 0;
    }

    parseMessage.mockResolvedValueOnce({ messageId: newId, fromEmail: 'me@example.test', subject: 'Fresh subject',
      to: [], cc: [], inReplyTo: '<known@example.test>', references: '<known@example.test>',
      providerMsgid: providerId, parsedHeaders: { bcc: 'bcc@example.test' }, flags: [], hasAttachments: false });
    const manager = Object.create(ImapManager.prototype);
    const fetched = { headers: Buffer.from('headers'), bodyStructure: { type: 'text/plain' } };
    const ingestion = manager._ingestDraftUidWithClient({ id: accountId, imap_host: 'imap.gmail.com', email_address: 'me@example.test' }, 'Drafts', 1,
      { mailbox: { uidValidity: current } }, fetched);
    let metadata;
    if (reject) await expect(ingestion).rejects.toThrow('Draft ingestion did not persist a row');
    else metadata = await ingestion;
    expect(parseMessage).toHaveBeenCalledExactlyOnceWith(fetched);
    expect(withTransaction).toHaveBeenCalledTimes(noTransaction ? 0 : 1);
    expect(commands).toEqual(noTransaction ? [] : ['BEGIN', 'COMMIT']);

    const statements = client.query.mock.calls.map(([sql]) => sql);
    if (noTransaction) expect(statements).toEqual([]);
    else {
      expect(statements[0]).toMatch(/SELECT id FROM email_accounts.*enabled FOR SHARE/);
      expect(client.query.mock.calls[0][1]).toEqual([accountId]);
      expect(statements[1]).toContain('SELECT path,uid_validity,special_use FROM folders');
      expect(statements[1]).toContain('ORDER BY path FOR SHARE');
      expect(client.query.mock.calls[1][1]).toEqual([accountId, ['Drafts']]);
    }
    if (reject) {
      // Missing/current/changed epoch refusals are not successful rewrites.
      // Snapshot equality covers header identity, provider, root, Bcc, body,
      // every normal/residue sibling, account and folder state.
      expect(statements.some(sql => /INSERT INTO messages|DELETE FROM messages/.test(sql))).toBe(false);
      expect(statements.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(false);
      expect(await snapshot()).toEqual(before);
      return;
    }

    expect(statements[2]).toContain('pg_advisory_xact_lock');
    expect(client.query.mock.calls[2][1]).toEqual([JSON.stringify([accountId, providerId])]);
    expect(statements[3]).toContain('INSERT INTO messages');
    expect(statements[3]).toContain('ON CONFLICT (account_id, uid, folder) DO UPDATE');
    expect(statements[4]).toContain('DELETE FROM messages r');
    const after = await snapshot();
    const persisted = after.messages.find(row => row.id === messageId(1));
    expect(metadata).toMatchObject({ id: messageId(1), account_id: accountId, uid: 1, folder: 'Drafts', uid_validity: '9', attachments_complete: true });
    expect(persisted.provider_msgid).toBe(providerId);
    expect(metadata.thread_id).toBe(root);
    expect(persisted.thread_id).toBe(root);
    expect(persisted.body_html).toBe(keep ? '<p>Cached</p>' : null);
    expect(persisted.body_text).toBe(keep ? 'Cached' : null);
    expect(persisted.message_id).toBe(newId);
    expect(persisted.subject).toBe('Fresh subject');
    expect(persisted.bcc_addresses).toEqual([{ email: 'bcc@example.test' }]);
    expect(metadata.bcc_addresses).toEqual(persisted.bcc_addresses);
    expect(after.messages.find(row => row.id === messageId(2))).toEqual(before.messages.find(row => row.id === messageId(2)));
    expect(after.messages.find(row => row.id === messageId(3))).toBeUndefined();
    expect(after.messages.find(row => row.id === messageId(4))).toEqual(before.messages.find(row => row.id === messageId(4)));
    expect(after.accounts).toEqual(before.accounts);
    expect(after.folders).toEqual(before.folders);
    expect((await database.query('SELECT uid_validity FROM folders WHERE path=$1', ['Drafts'])).rows[0]?.uid_validity).toBe(stored);
  });
});
