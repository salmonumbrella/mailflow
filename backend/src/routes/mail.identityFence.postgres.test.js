// Source/test authoring only. Execution requires the lead's focused slot and
// dedicated mailflow_svtw; these fixtures never connect to a mail provider.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/imapManager.js', () => ({ isConnectionRefusal: () => false }));
vi.mock('../services/spamModelStore.js', () => ({ updateIncrementalForUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { hasActiveAsync: vi.fn(async () => false), runHook: vi.fn(async () => {}) } }));
vi.mock('../utils/mailUtils.js', async importOriginal => ({ ...await importOriginal(),
  resolveArchiveFolder: vi.fn(async () => 'Archive'), isAllMailFolder: vi.fn(async (_id, path) => path === 'All'),
  resolveTrashFolder: vi.fn(async () => 'Trash'), resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])), resolveSpamFolder: vi.fn(async () => 'Spam'),
  adjustFolderCounts: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager: Object.fromEntries([
  '_guardMoveUid', '_unguardMoveUid', 'bulkMoveMessages', 'bulkPermanentDelete', 'moveMessage',
  'permanentDeleteMessage', 'broadcast', 'scheduleCountRefresh', 'syncFolderOnDemand', 'ensureFolder',
].map(name => [name, vi.fn()])) }));

import routes from './mail.js';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { admitArchiveMetadata } from '../services/archiveCoverage.js';
import { countCompletion } from '../services/countCompletion.js';
import { adjustFolderCounts, resolveArchiveFolder } from '../utils/mailUtils.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const id1 = '22222222-2222-4222-8222-222222222222';
const id2 = '33333333-3333-4333-8333-333333333333';
const p1 = '9007199254740993', p2 = '9007199254740994';
const ctx = new AsyncLocalStorage();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function invoke(path, body = {}, id = id1, method = 'post') {
  const layer = routes.stack.find(item => item.route?.path === path && item.route.methods[method]);
  expect(layer).toBeDefined();
  const replied = deferred();
  const req = { params: { id }, body, query: {}, session: { userId: 'owner' }, get: () => undefined };
  const res = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; replied.resolve(); return this; } };
  const completion = layer.route.stack.at(-1).handle(req, res, error => { throw error; });
  return { res, replied: replied.promise, completion };
}

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('4b-F route writers with two PostgreSQL sessions', () => {
  let db, peer, schema, warnings, expectedWarnings, created = false, transaction = false, txStatements = [];
  const snapshot = async () => (await db.query('SELECT id,account_id,folder,uid::text,provider_msgid,is_archive_residue,is_read,category FROM messages ORDER BY folder,uid')).rows;
  const seed = (id = id1, uid = 11, provider = p1, path = 'INBOX', residue = false) => db.query(
    `INSERT INTO messages(id,account_id,uid,folder,provider_msgid,is_archive_residue,message_id,category,is_read)
     VALUES($1,$2,$3,$4,$5,$6,$7,'primary',false)`, [id, accountId, uid, path, provider, residue, `<${id}@example.test>`]);
  const providerResult = uids => ({ succeeded: uids, failed: [], uidMap: new Map(uids.map(uid => [Number(uid), Number(uid) + 100])) });
  const waitForBlock = async () => {
    const until = Date.now() + 2000;
    let pids;
    do {
      pids = (await peer.query('SELECT pg_blocking_pids($1) AS pids', [db.processID])).rows[0].pids;
      if (pids.includes(peer.processID)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < until);
    expect(pids).toContain(peer.processID);
  };
  const assertNoInternalIds = body => {
    expect(body).not.toHaveProperty('destinationIds');
    expect(body).not.toHaveProperty('destinationRows');
    expect(imapManager.broadcast.mock.calls.every(([event]) => !('destinationIds' in event) && !('destinationRows' in event))).toBe(true);
  };
  beforeAll(async () => {
    if (decodeURIComponent(new URL(process.env.MAILFLOW_TEST_DATABASE_URL).pathname) !== '/mailflow_svtw') {
      throw new Error('4b-F tests require dedicated mailflow_svtw');
    }
    schema = `route_fence_${randomUUID().replaceAll('-', '')}`;
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`); created = true;
    await db.query(`SET search_path TO ${schema}; SET statement_timeout='5s';
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,user_id text,enabled boolean DEFAULT true,
        imap_host text DEFAULT 'imap.gmail.test',folder_mappings jsonb DEFAULT '{}');
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,
        name varchar(255) NOT NULL,uid_validity bigint,special_use text,no_select boolean DEFAULT false,PRIMARY KEY(account_id,path))`);
    const baseline = await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8');
    await db.query(baseline.match(/CREATE TABLE IF NOT EXISTS messages \([\s\S]*?\n\);/)[0]);
    await db.query(`ALTER TABLE messages ADD COLUMN bcc_addresses jsonb,
      ADD COLUMN is_bulk boolean, ADD COLUMN spam_score_sa real, ADD COLUMN spam_score_ml real,
      ADD COLUMN spam_verdict text, ADD COLUMN spam_analyzed_at timestamptz, ADD COLUMN spam_details jsonb,
      ADD COLUMN spam_user_override text, ADD COLUMN category text, ADD COLUMN list_unsubscribe text,
      ADD COLUMN list_unsubscribe_post text, ADD COLUMN unsubscribed_at timestamptz, ADD COLUMN delivery_addresses jsonb,
      ADD COLUMN sender_name text, ADD COLUMN sender_email text, ADD COLUMN forwarded_from_name text,
      ADD COLUMN forwarded_from_email text, ADD COLUMN forwarded_via text, ADD COLUMN plugin_annotations jsonb;
      CREATE TABLE snoozed_messages(id uuid DEFAULT gen_random_uuid(),user_id text,account_id uuid,
        message_id_header text,original_folder text,snooze_until timestamptz,snoozed_folder text);
      CREATE TABLE spam_training_log(user_id text,account_id uuid,message_id_header text,message_uid bigint,
        folder text,label text,source text,subject text,body_text text,body_html text,token_counts jsonb,
        flag_features jsonb,sender_domain text,attachment_types text[])`);
    await db.query(await readFile(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8'));
    const indexes = await readFile(new URL('../../migrations/0070_archive_identity_indexes.sql', import.meta.url), 'utf8');
    for (const sql of indexes.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) await db.query(sql);
    peer = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await peer.connect();
    await peer.query(`SET search_path TO ${schema}; SET statement_timeout='5s'`);
    query.mockImplementation((sql, values) => (ctx.getStore() || db).query(sql, values));
    withTransaction.mockImplementation(async work => {
      transaction = true; await db.query('BEGIN');
      try { const result = await work({ query: (sql, values) => { txStatements.push(sql); return db.query(sql, values); } }); await db.query('COMMIT'); return result; }
      catch (error) { await db.query('ROLLBACK'); throw error; }
      finally { transaction = false; }
    });
  });
  afterAll(async () => {
    if (peer) { await peer.query('ROLLBACK'); await peer.end(); }
    if (db) {
      try { await db.query('ROLLBACK'); if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await db.end(); }
    }
  });
  beforeEach(async () => {
    await peer.query('ROLLBACK'); await db.query('ROLLBACK');
    await db.query('TRUNCATE email_accounts CASCADE; TRUNCATE snoozed_messages,spam_training_log');
    await db.query("INSERT INTO email_accounts(id,user_id) VALUES($1,'owner')", [accountId]);
    await db.query(`INSERT INTO folders(account_id,path,name,uid_validity,special_use) VALUES
      ($1,'INBOX','INBOX',9,NULL),($1,'Sent','Sent',8,'\\Sent'),($1,'All','All',7,'\\All'),($1,'Archive','Archive',10,NULL),
      ($1,'Projects','Projects',10,NULL),($1,'Trash','Trash',12,'\\Trash'),($1,'Spam','Spam',13,'\\Junk'),($1,'Snoozed','Snoozed',14,NULL)`, [accountId]);
    await db.query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete,phase)
      SELECT account_id,path,uid_validity,special_use IS DISTINCT FROM '\\All','scan' FROM folders`);
    await seed(); vi.clearAllMocks();
    query.mockImplementation((sql, values) => (ctx.getStore() || db).query(sql, values));
    transaction = false; txStatements = []; countCompletion.users.clear();
    expectedWarnings = []; warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveArchiveFolder.mockResolvedValue('Archive');
    imapManager.bulkMoveMessages.mockImplementation(async (_account, uids) => { expect(transaction).toBe(false); return providerResult(uids); });
    imapManager.bulkPermanentDelete.mockImplementation(async (_account, uids) => { expect(transaction).toBe(false); return { succeeded: uids, failed: [] }; });
    imapManager.moveMessage.mockImplementation(async () => { expect(transaction).toBe(false); return 111; });
    imapManager.permanentDeleteMessage.mockImplementation(async () => { expect(transaction).toBe(false); });
    imapManager.ensureFolder.mockImplementation(async () => { expect(transaction).toBe(false); return { path: 'Snoozed' }; });
    imapManager.syncFolderOnDemand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    try {
      expect(warnings.mock.calls).toHaveLength(expectedWarnings.length);
      expectedWarnings.forEach((pattern, i) => {
        expect(warnings.mock.calls[i][0]).toBe('Post-provider message write is unconfirmed:');
        expect(warnings.mock.calls[i][1]).toMatch(pattern);
      });
    } finally { warnings.mockRestore(); }
  });

  it('waits for actual admission before the route CTE, removes only residue and preserves normal UID duplicates', async () => {
    await seed(id2, 12); await seed(randomUUID(), 90, p1, 'All', true);
    await peer.query('BEGIN');
    expect((await admitArchiveMetadata(peer, { accountId, folder: 'All', uidValidity: '7',
      profile: { labelStore: true }, normalEpochs: { INBOX: '9', Sent: '8', Archive: '10', Projects: '10', Trash: '12', Spam: '13', Snoozed: '14' },
      records: [{ uid: 90, providerMsgid: p1, normalCopies: [] }] })).counts).toMatchObject({ pending: 1 });
    const request = invoke('/messages/bulk-move', { ids: [id1], folder: 'Projects' });
    try { await waitForBlock(); } finally { await peer.query('COMMIT'); }
    await request.completion;
    expect(request.res.body).toMatchObject({ moved: [id1], unconfirmed: [] });
    const records = await snapshot();
    expect(records.some(row => row.is_archive_residue)).toBe(false);
    expect(records.filter(row => !row.is_archive_residue).map(row => [row.folder, row.uid]))
      .toEqual([['INBOX', '12'], ['Projects', '111']]);
  });

  it.each(['residue', 'epoch', 'disabled', 'vanished', 'identity'])('returns source unconfirmed after provider success and a %s fence refusal', async kind => {
    imapManager.bulkMoveMessages.mockImplementation(async (_account, uids) => {
      expect(transaction).toBe(false);
      if (kind === 'residue') await peer.query("UPDATE messages SET folder='All',uid=90,is_archive_residue=true WHERE id=$1", [id1]);
      if (kind === 'epoch') await peer.query("UPDATE folders SET uid_validity=99 WHERE account_id=$1 AND path='INBOX'", [accountId]);
      if (kind === 'disabled') await peer.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [accountId]);
      if (kind === 'vanished') await peer.query('DELETE FROM messages WHERE id=$1', [id1]);
      if (kind === 'identity') await peer.query('UPDATE messages SET provider_msgid=$2 WHERE id=$1', [id1, p2]);
      return providerResult(uids);
    });
    const request = invoke('/messages/bulk-archive', { ids: [id1] }); await request.completion;
    expect(request.res.body).toMatchObject({ archived: [], countTargets: [], unconfirmed: [id1] });
    if (kind === 'disabled') expect(imapManager.syncFolderOnDemand).not.toHaveBeenCalled();
    else expect(imapManager.syncFolderOnDemand).toHaveBeenCalled();
    expect((await snapshot()).some(row => row.folder === 'Archive')).toBe(false);
    expect(adjustFolderCounts).not.toHaveBeenCalled(); assertNoInternalIds(request.res.body);
  });

  it('never invokes the identity helper with a NULL captured epoch and requests resync', async () => {
    await db.query("UPDATE folders SET uid_validity=NULL WHERE account_id=$1 AND path='INBOX'", [accountId]);
    const request = invoke('/messages/bulk-archive', { ids: [id1] }); await request.completion;
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(request.res.body).toMatchObject({ archived: [], countTargets: [], unconfirmed: [id1] });
    expect(txStatements.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalled();
    expect((await snapshot())[0]).toMatchObject({ id: id1, folder: 'INBOX' });
  });

  it('mixes committed sources and unconfirmed IDs using actual source category/read and separate destination IDs', async () => {
    await seed(id2, 12, p2);
    imapManager.bulkMoveMessages.mockImplementation(async (_account, uids) => {
      await peer.query("UPDATE messages SET folder='All',uid=90,is_archive_residue=true WHERE id=$1", [id2]);
      await peer.query("UPDATE messages SET is_read=true,category='newsletter' WHERE id=$1", [id1]);
      return providerResult(uids);
    });
    const request = invoke('/messages/bulk-archive', { ids: [id1, id2] }); await request.completion;
    expect(request.res.body).toMatchObject({ archived: [id1], unconfirmed: [id2], countTargets: [
      { id: id1, account_id: accountId, folder: 'INBOX', category: 'newsletter', is_read: true, destinationFolder: 'Archive' },
    ] });
    const destination = (await snapshot()).find(row => row.folder === 'Archive');
    expect(destination.id).not.toBe(id1); expect(destination.id).not.toBe(id2);
    expect(request.res.body.countTargets[0].id).not.toBe(destination.id);
    assertNoInternalIds(request.res.body);
  });

  it('locks reverse-ordered multiple identities in sorted order once for their source group', async () => {
    await seed(id2, 12, p2); await peer.query('BEGIN');
    await peer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([accountId, p2])]);
    const request = invoke('/messages/bulk-move', { ids: [id2, id1], folder: 'Projects' });
    try {
      await waitForBlock();
      expect((await peer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
        [JSON.stringify([accountId, p1])])).rows[0].acquired).toBe(false);
    } finally { await peer.query('COMMIT'); }
    await request.completion;
    expect(new Set(request.res.body.moved)).toEqual(new Set([id1, id2]));
    expect(request.res.body.unconfirmed).toEqual([]);
    expect(txStatements.filter(sql => sql.includes('SELECT id FROM email_accounts') && sql.includes('FOR SHARE'))).toHaveLength(1);
  });

  it('keeps the non-Gmail NULL-identity path without advisory locks', async () => {
    await db.query('UPDATE messages SET provider_msgid=NULL WHERE id=$1', [id1]);
    const request = invoke('/messages/bulk-move', { ids: [id1], folder: 'Projects' }); await request.completion;
    expect(request.res.body).toMatchObject({ moved: [id1], unconfirmed: [] });
    expect((await snapshot())[0]).toMatchObject({ folder: 'Projects', uid: '111', provider_msgid: null });
    expect(txStatements.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(false);
  });

  it('holds countMutation and source guards through awaited recovery after res.json', async () => {
    const recovery = deferred(), entered = deferred();
    imapManager.bulkMoveMessages.mockImplementation(async (_account, uids) => {
      await peer.query("UPDATE folders SET uid_validity=99 WHERE account_id=$1 AND path='INBOX'", [accountId]);
      return providerResult(uids);
    });
    imapManager.syncFolderOnDemand.mockImplementation(async () => { entered.resolve(); await recovery.promise; });
    const request = invoke('/messages/bulk-archive', { ids: [id1] });
    try {
      await Promise.race([
        Promise.all([request.replied, entered.promise]),
        request.completion.then(() => { throw new Error('bulk-archive request completed before held recovery'); }),
      ]);
      expect(countCompletion.user('owner').handlers).toBe(1);
      expect(imapManager._unguardMoveUid).not.toHaveBeenCalled();
      expect(request.res.body).toMatchObject({ archived: [], unconfirmed: [id1] });
    } finally { recovery.resolve(); await request.completion; }
    expect(countCompletion.user('owner').handlers).toBe(0);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(accountId, 'INBOX', '11');
  });

  it('reports the SOURCE id for a Trash UPDATE that regenerates its destination id', async () => {
    const request = invoke('/messages/:id', {}, id1, 'delete'); await request.completion;
    expect(request.res.body).toMatchObject({ ok: true, unconfirmed: [] });
    const destination = (await snapshot())[0]; expect(destination.folder).toBe('Trash');
    expect(destination.id).not.toBe(id1); expect(request.res.body.unconfirmed).not.toContain(destination.id);
    assertNoInternalIds(request.res.body);
  });

  it.each([
    ['post', '/messages/bulk-delete', { ids: [id1] }],
    ['delete', '/messages/:id', {}],
    ['post', '/messages/:id/spam', {}],
    ['post', '/messages/:id/snooze', { until: new Date(Date.now() + 86400000).toISOString() }],
  ])('returns post-provider uncertainty without training/count writes but with snooze wake intent at %s %s', async (method, path, body) => {
    const change = async () => { expect(transaction).toBe(false); await peer.query("UPDATE folders SET uid_validity=99 WHERE account_id=$1 AND path='INBOX'", [accountId]); };
    imapManager.moveMessage.mockImplementation(async () => { await change(); return 111; });
    imapManager.bulkMoveMessages.mockImplementation(async (_account, uids) => { await change(); return providerResult(uids); });
    const request = invoke(path, body, id1, method); await request.completion;
    expect(request.res.body).toMatchObject({ unconfirmed: [id1] });
    if (path.includes('bulk-delete')) expect(request.res.body.deleted).toEqual([]);
    expect((await db.query('SELECT * FROM spam_training_log')).rows).toEqual([]);
    const wakes = (await db.query('SELECT * FROM snoozed_messages')).rows;
    if (path.endsWith('/snooze')) expect(wakes).toEqual([expect.objectContaining({
      account_id: accountId, message_id_header: `<${id1}@example.test>`, snoozed_folder: 'Snoozed',
    })]);
    else expect(wakes).toEqual([]);
    expect(adjustFolderCounts).not.toHaveBeenCalled();
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalled();
  });

  it.each(['INBOX', 'Sent'])('keeps Gmail %s-to-All archive DELETE-only with source counts and no forced Inbox charge', async path => {
    await db.query('UPDATE messages SET folder=$2 WHERE id=$1', [id1, path]);
    resolveArchiveFolder.mockResolvedValue('All');
    const request = invoke('/messages/bulk-archive', { ids: [id1] }); await request.completion;
    expect(request.res.body).toMatchObject({ archived: [id1], unconfirmed: [], countTargets: [
      { id: id1, account_id: accountId, folder: path, category: 'primary', is_read: false },
    ] });
    expect(request.res.body.countTargets[0]).not.toHaveProperty('destinationFolder');
    expect(await snapshot()).toEqual([]);
    expect(txStatements.some(sql => sql.includes('INSERT INTO messages'))).toBe(false);
    if (path === 'Sent') {
      expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(accountId, expect.arrayContaining(['INBOX']));
      expect(adjustFolderCounts.mock.calls.some(([id, folder]) => id === accountId && folder === 'INBOX')).toBe(false);
    }
    assertNoInternalIds(request.res.body);
  });

  it.each(['bulk-archive', 'single-trash'])('preserves a destination normal copy and reports uncertainty on %s destination collision', async kind => {
    if (kind === 'single-trash') expectedWarnings.push(/duplicate key/);
    const destinationId = randomUUID(), destination = kind === 'bulk-archive' ? 'Archive' : 'Trash';
    await seed(destinationId, 111, p2, destination);
    const request = kind === 'bulk-archive' ? invoke('/messages/bulk-archive', { ids: [id1] })
      : invoke('/messages/:id', {}, id1, 'delete');
    await request.completion;
    expect(request.res.body.unconfirmed).toEqual([id1]);
    if (kind === 'bulk-archive') expect(request.res.body).toMatchObject({ archived: [], countTargets: [] });
    expect((await snapshot()).find(row => row.id === destinationId)).toMatchObject({ provider_msgid: p2, folder: destination });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalled();
  });

  it('rolls back a real PostgreSQL relocation error without confirming deleted source IDs', async () => {
    expectedWarnings.push(/route_fence_no_archive/);
    await db.query("ALTER TABLE messages ADD CONSTRAINT route_fence_no_archive CHECK(folder<>'Archive')");
    try {
      const request = invoke('/messages/bulk-archive', { ids: [id1] }); await request.completion;
      expect(request.res.body).toMatchObject({ archived: [], countTargets: [], unconfirmed: [id1] });
      expect((await snapshot())[0]).toMatchObject({ id: id1, folder: 'INBOX', uid: '11' });
      expect(adjustFolderCounts).not.toHaveBeenCalled();
    } finally { await db.query('ALTER TABLE messages DROP CONSTRAINT route_fence_no_archive'); }
  });

  it('rejects a residue race during a no-provider spam update as known not applied, with no training', async () => {
    await db.query("UPDATE messages SET folder='Spam' WHERE id=$1", [id1]);
    let changed = false;
    query.mockImplementation(async (sql, values) => {
      const result = await db.query(sql, values);
      if (!changed && sql.includes('SELECT * FROM email_accounts')) {
        changed = true;
        await peer.query("UPDATE messages SET folder='All',uid=90,is_archive_residue=true WHERE id=$1", [id1]);
      }
      return result;
    });
    const request = invoke('/messages/:id/spam'); await request.completion;
    expect(request.res.statusCode).toBe(409);
    expect(request.res.body.unconfirmed ?? []).toEqual([]);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM spam_training_log')).rows).toEqual([]);
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('records only a committed spam move, with the actual source and new provider UID', async () => {
    const request = invoke('/messages/:id/spam'); await request.completion;
    expect(request.res.body).toMatchObject({ ok: true, folder: 'Spam', newUid: 111, unconfirmed: [] });
    expect((await db.query('SELECT message_id_header,message_uid::text,folder,label FROM spam_training_log')).rows)
      .toEqual([{ message_id_header: `<${id1}@example.test>`, message_uid: '111', folder: 'Spam', label: 'spam' }]);
    expect((await snapshot())[0]).toMatchObject({ id: id1, folder: 'Spam', uid: '111' });
  });

  it('commits a snooze and replaces stale wake records before they become live again', async () => {
    await db.query(`INSERT INTO snoozed_messages(user_id,account_id,message_id_header,original_folder,snooze_until,snoozed_folder)
      VALUES('owner',$1,$2,'INBOX','2026-01-01','Snoozed')`, [accountId, `<${id1}@example.test>`]);
    const until = new Date(Date.now() + 86400000).toISOString();
    const request = invoke('/messages/:id/snooze', { until }); await request.completion;
    expect(request.res.body).toMatchObject({ ok: true, unconfirmed: [] });
    const records = (await db.query('SELECT message_id_header,original_folder,snoozed_folder,snooze_until FROM snoozed_messages')).rows;
    expect(records).toEqual([{ message_id_header: `<${id1}@example.test>`, original_folder: 'INBOX', snoozed_folder: 'Snoozed', snooze_until: new Date(until) }]);
    expect((await snapshot())[0]).toMatchObject({ id: id1, folder: 'Snoozed', uid: '111' });
  });

  it.each(['null-epoch', 'collision', 'residue'])('keeps provider-success snooze wake intent across a %s row refusal', async kind => {
    if (kind === 'null-epoch') await db.query("UPDATE folders SET uid_validity=NULL WHERE account_id=$1 AND path='INBOX'", [accountId]);
    if (kind === 'collision') { await seed(id2, 111, p2, 'Snoozed'); expectedWarnings.push(/duplicate key/); }
    imapManager.moveMessage.mockImplementation(async () => {
      expect(transaction).toBe(false);
      if (kind === 'residue') await peer.query("UPDATE messages SET folder='All',uid=90,is_archive_residue=true WHERE id=$1", [id1]);
      return 111;
    });
    const request = invoke('/messages/:id/snooze', { until: new Date(Date.now() + 86400000).toISOString() });
    await request.completion;
    expect(request.res.body).toMatchObject({ ok: true, unconfirmed: [id1] });
    expect((await db.query('SELECT message_id_header,original_folder,snoozed_folder FROM snoozed_messages')).rows)
      .toEqual([{ message_id_header: `<${id1}@example.test>`, original_folder: 'INBOX', snoozed_folder: 'Snoozed' }]);
    expect(adjustFolderCounts).not.toHaveBeenCalled();
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalled();
    if (kind === 'collision') expect((await snapshot()).find(row => row.id === id2)).toMatchObject({ folder: 'Snoozed', uid: '111', provider_msgid: p2 });
  });

  it('does not create wake intent or row/count writes when the primary provider move fails first', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    imapManager.moveMessage.mockRejectedValue(new Error('primary refused'));
    try {
      const request = invoke('/messages/:id/snooze', { until: new Date(Date.now() + 86400000).toISOString() });
      await request.completion;
      expect(request.res.statusCode).toBe(500);
      expect(request.res.body.unconfirmed).toEqual([]);
      expect((await db.query('SELECT * FROM snoozed_messages')).rows).toEqual([]);
      expect((await snapshot())[0]).toMatchObject({ id: id1, folder: 'INBOX' });
      expect(adjustFolderCounts).not.toHaveBeenCalled();
      expect(txStatements).toEqual([]);
    } finally { error.mockRestore(); }
  });

  it.each(['spam', 'ham'])('responds to %s before recovery while retaining the countMutation lifetime and guard', async action => {
    if (action === 'ham') await db.query("UPDATE messages SET folder='Spam' WHERE id=$1", [id1]);
    const source = action === 'ham' ? 'Spam' : 'INBOX';
    const recovery = deferred(), entered = deferred();
    imapManager.moveMessage.mockImplementation(async () => {
      await peer.query('UPDATE folders SET uid_validity=99 WHERE account_id=$1 AND path=$2', [accountId, source]);
      return 111;
    });
    imapManager.syncFolderOnDemand.mockImplementation(async () => { entered.resolve(); await recovery.promise; });
    const request = invoke(`/messages/:id/${action}`);
    try {
      await Promise.race([
        entered.promise,
        request.completion.then(() => { throw new Error(`${action} request completed before held recovery`); }),
      ]);
      // This fails if res.json waits for recovery (A4); no wait-for-response hang.
      expect(request.res.body).toMatchObject({ ok: true, unconfirmed: [id1] });
      expect(countCompletion.user('owner').handlers).toBe(1);
      expect(imapManager._unguardMoveUid).not.toHaveBeenCalled();
      expect((await db.query('SELECT * FROM spam_training_log')).rows).toEqual([]);
    } finally { recovery.resolve(); await request.completion; }
    expect(countCompletion.user('owner').handlers).toBe(0);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(accountId, source, '11');
  });

  it('keeps a NULL-epoch already-in-Spam update as known not applied without provider work or training', async () => {
    await db.query("UPDATE messages SET folder='Spam' WHERE id=$1", [id1]);
    await db.query("UPDATE folders SET uid_validity=NULL WHERE account_id=$1 AND path='Spam'", [accountId]);
    const request = invoke('/messages/:id/spam'); await request.completion;
    expect(request.res.statusCode).toBe(409);
    expect(request.res.body.unconfirmed ?? []).toEqual([]);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM spam_training_log')).rows).toEqual([]);
    expect(txStatements).toEqual([]);
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

});
