import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, owner: null, beforeHydrate: null,
  providerRead: vi.fn(async () => { throw new Error('Unexpected provider read'); }),
  prefetchPolicy: vi.fn(async () => {}) }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: async (...args) => {
    if (h.beforeHydrate && args[0].includes('SELECT r.request_index,m.attachments')) {
      const hook = h.beforeHydrate; h.beforeHydrate = null; await hook();
    }
    return h.pool.query(...args);
  },
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: h.owner }; if (req.get('x-test-token')) req.apiToken = { id: 'read-token' }; next();
} }));
vi.mock('../index.js', () => ({ imapManager: {
  fetchMessageBody: h.providerRead, fetchAttachment: h.providerRead, fetchMultipleAttachments: h.providerRead,
  prefetchFolderBodies: h.prefetchPolicy,
} }));
import { runMigrations } from './migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { hydrateCachedAttachmentMetadata } from './messageAttachmentReadModel.js';
import { listMessages } from './messageService.js';
import { listNativeLabelMessages } from './nativeLabelReadModel.js';
import { matchApiTokenRoute } from './apiTokenAllowlist.js';
import searchRoutes from '../routes/search.js';
import mailRoutes from '../routes/mail.js';
import labelRoutes from '../routes/labels.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL)('cached attachment metadata on PostgreSQL and read endpoints', () => {
  const dbName = `mailflow_attachment_metadata_${randomBytes(5).toString('hex')}`;
  let admin, account, second, foreign, label, server, base;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new globalThis.URL(URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 }); await runMigrations();
    const app = express(); app.use('/api/mail', mailRoutes); app.use('/api/search', searchRoutes); app.use('/api/labels', labelRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); }); base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
  });
  const makeAccount = async (owner, name) => (await h.pool.query(
    'INSERT INTO email_accounts(user_id,name,email_address,imap_host) VALUES ($1,$2,$3,\'imap.gmail.com\') RETURNING *', [owner, name, `${name}@example.test`])).rows[0];
  beforeEach(async () => {
    h.beforeHydrate = null; h.providerRead.mockClear(); h.prefetchPolicy.mockClear();
    await h.pool.query('TRUNCATE users CASCADE');
    h.owner = (await h.pool.query("INSERT INTO users(username) VALUES ('attachments-owner') RETURNING id")).rows[0].id;
    const stranger = (await h.pool.query("INSERT INTO users(username) VALUES ('attachments-stranger') RETURNING id")).rows[0].id;
    account = await makeAccount(h.owner, 'one'); second = await makeAccount(h.owner, 'two'); foreign = await makeAccount(stranger, 'foreign');
    label = (await h.pool.query("INSERT INTO mail_labels(account_id,name,normalized_name,full_path) VALUES ($1,'Work','work','Work') RETURNING *", [account.id])).rows[0];
  });
  const part = (filename, number = '2') => ({ filename, part: number, type: 'application/pdf', size: 1234, disposition: 'attachment' });
  const write = async (uid, { acct = account, folder = 'INBOX', epoch = '10', providerId, filename = `${uid}.pdf`,
    entries = [part(filename)], date = '2026-11-01T12:00:00Z', subject = 'Original subject', header = '<same@example.test>',
    thread = '<thread@example.test>', hasAttachments = true } = {}) => {
    const context = await observeMailboxIdentity(await readMailboxIdentity(acct, folder),
      { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set(['OBJECTID']) });
    await writeObservedMessage(context, { uid, ...(providerId ? { emailId: providerId } : {}) }, client => client.query(`
      INSERT INTO messages(account_id,uid,folder,message_id,thread_id,subject,from_email,date,has_attachments,attachments,body_html,body_text)
      VALUES ($1,$2,$3,$4,$5,$6,'sender@example.test',$7,$8,$9,'<p>SECRET BODY</p>','SECRET BODY')
      ON CONFLICT(account_id,uid,folder) DO UPDATE SET attachments=EXCLUDED.attachments RETURNING *`,
    [acct.id, uid, folder, header, thread, subject, date, hasAttachments, JSON.stringify(entries)]));
    return (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3', [acct.id, folder, uid])).rows[0];
  };
  const tag = async row => {
    await h.pool.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1', [row.entity_id]);
    return h.pool.query(`INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id)
      VALUES ($1,$2,$3,$4)`, [row.account_id, row.storage_generation, row.entity_id, label.id]);
  };
  const labelInput = () => ({ userId: h.owner, accountId: account.id, storageGeneration: account.storage_generation, labelId: label.id });
  const get = async (path, params = {}, status = 200, token = false) => {
    const response = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { headers: token ? { 'x-test-token': 'yes' } : {} });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(status); return body;
  };
  const assertMetadata = (row, expected, filename) => {
    expect(row.attachmentMetadata).toMatchObject({ state: 'partial', scope: 'message', providerComplete: false,
      inlineClassification: 'partial', source: { messageId: expected.id, accountId: expected.account_id,
        storageGeneration: expected.storage_generation, entityId: expected.entity_id, folder: expected.folder,
        uid: String(expected.uid), uidValidity: String(expected.uid_validity) }, items: [{ filename, part: '2' }] });
    expect(row.attachmentMetadata.items).toHaveLength(1);
    expect(row).not.toHaveProperty('attachments'); expect(row).not.toHaveProperty('body_html'); expect(row).not.toHaveProperty('body_text');
    expect(JSON.stringify(row)).not.toContain('SECRET');
  };

  it('hydrates only the exact selected physical message across same-header accounts, siblings and canonical aliases', async () => {
    const one = await write(1, { filename: 'one.pdf' }), sibling = await write(2, { filename: 'sibling.pdf' });
    const other = await write(1, { acct: second, filename: 'two.pdf' });
    await h.pool.query('UPDATE message_entities SET canonical_entity_id=$1 WHERE id=$2', [one.entity_id, sibling.entity_id]);
    const result = await hydrateCachedAttachmentMetadata(h.owner, [one, sibling, other]);
    [one, sibling, other].forEach((row, i) => assertMetadata(result[i], row, ['one.pdf', 'sibling.pdf', 'two.pdf'][i]));
    expect(h.providerRead).not.toHaveBeenCalled();
  });

  it.each(['owner', 'disabled', 'deleted-account', 'deleted-row', 'soft-deleted', 'moved', 'missing-location', 'epoch', 'generation', 'entity'])('refuses %s without copying any stale or sibling metadata', async scenario => {
    const row = await write(1), sibling = await write(2, { filename: 'wrong.pdf' });
    let user = h.owner;
    if (scenario === 'owner') user = randomUUID();
    if (scenario === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
    if (scenario === 'deleted-account') await h.pool.query('DELETE FROM email_accounts WHERE id=$1', [account.id]);
    if (scenario === 'deleted-row') await h.pool.query('DELETE FROM messages WHERE id=$1', [row.id]);
    if (scenario === 'soft-deleted') await h.pool.query('UPDATE messages SET is_deleted=true WHERE id=$1', [row.id]);
    if (scenario === 'moved') await h.pool.query("UPDATE messages SET folder='Moved',uid=20 WHERE id=$1", [row.id]);
    if (scenario === 'missing-location') await h.pool.query("UPDATE entity_locations SET status='missing' WHERE entity_id=$1", [row.entity_id]);
    if (scenario === 'epoch') await h.pool.query('UPDATE mailbox_identity_epochs SET uid_validity=11 WHERE account_id=$1', [account.id]);
    if (scenario === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [randomUUID(), account.id]);
    if (scenario === 'entity') {
      await h.pool.query('UPDATE messages SET entity_id=NULL,storage_generation=NULL,uid_validity=NULL WHERE id=$1', [row.id]);
      await h.pool.query('UPDATE entity_locations SET entity_id=$1 WHERE uid=1 AND account_id=$2', [sibling.entity_id, account.id]);
      await h.pool.query('UPDATE messages SET entity_id=$1,storage_generation=$2,uid_validity=10 WHERE id=$3', [sibling.entity_id, account.storage_generation, row.id]);
    }
    const result = (await hydrateCachedAttachmentMetadata(user, [row]))[0];
    expect(result).toMatchObject({ has_attachments: true, attachmentMetadata: { state: 'unavailable', items: [], source: null, omittedCount: null } });
    expect(JSON.stringify(result)).not.toContain('.pdf'); expect(h.providerRead).not.toHaveBeenCalled();
  });

  it('does not adopt a same-ID same-UID replacement after a mailbox epoch reset', async () => {
    const old = await write(1, { filename: 'old.pdf' });
    const replacement = await write(1, { epoch: '11', filename: 'replacement.pdf' });
    await h.pool.query('UPDATE messages SET id=$1 WHERE id=$2', [old.id, replacement.id]);
    const current = (await h.pool.query('SELECT * FROM messages WHERE id=$1', [old.id])).rows[0];
    const rows = await hydrateCachedAttachmentMetadata(h.owner, [old, current]);
    expect(rows[0].attachmentMetadata).toMatchObject({ state: 'unavailable', source: null, items: [] });
    assertMetadata(rows[1], current, 'replacement.pdf');
  });

  it('keeps unknown paperclips for empty, malformed and legacy caches', async () => {
    const empty = await write(1, { entries: [] }), malformed = await write(2, { entries: { filename: 'bad.pdf' } });
    const legacy = (await h.pool.query(`INSERT INTO messages(account_id,uid,subject,has_attachments,attachments)
      VALUES ($1,3,'Legacy',true,$2) RETURNING *`, [account.id, JSON.stringify([part('legacy.pdf')])])).rows[0];
    const rows = await hydrateCachedAttachmentMetadata(h.owner, [empty, malformed, legacy]);
    expect(rows.map(row => row.attachmentMetadata.state)).toEqual(['unknown', 'unknown', 'unavailable']);
    expect(rows.every(row => row.has_attachments && !row.attachmentMetadata.items.length)).toBe(true);
    expect(rows[0].attachmentMetadata.omittedCount).toBe(0); expect(rows[1].attachmentMetadata.omittedCount).toBeNull();
  });

  it('whitelists before SQL output, bounds large fields/arrays, and filters malformed, inline and calendar values', async () => {
    const entries = [null, [], 'bad', { ...part('inline.pdf', '1'), shownInline: 'true' }, part('Invite.ICS', '3'),
      { ...part('large.pdf', '4'), filename: 'x'.repeat(300000) }, { ...part('secret.pdf', '5'), contentBase64: 'SECRET'.repeat(10000), url: 'SECRET', size: 1e100 },
      ...Array.from({ length: 1000 }, (_, i) => part(`${i}.pdf`, String(i + 10)))];
    const row = await write(1, { entries });
    const execute = vi.fn(async (...args) => {
      const result = await h.pool.query(...args);
      expect(JSON.stringify(result.rows).length).toBeLessThan(20000);
      expect(JSON.stringify(result.rows)).not.toContain('SECRET');
      return result;
    });
    const result = (await hydrateCachedAttachmentMetadata(h.owner, [row], execute))[0];
    expect(result.attachmentMetadata.items).toHaveLength(20);
    expect(result.attachmentMetadata.items[0]).toMatchObject({ filename: 'secret.pdf', size: null });
    expect(result.attachmentMetadata.omittedCount).toBe(entries.length - 20);
    expect(result.attachmentMetadata.items.some(item => /inline|Invite|large/.test(item.filename))).toBe(false);
  });

  it('uses three bounded cache reads for 401 rows and none for invalid/legacy identities', async () => {
    const row = await write(1), execute = vi.fn((...args) => h.pool.query(...args));
    const result = await hydrateCachedAttachmentMetadata(h.owner, Array.from({ length: 401 }, () => row), execute);
    expect(execute).toHaveBeenCalledTimes(3); expect(result.every(r => r.attachmentMetadata.items.length === 1)).toBe(true);
    execute.mockClear(); await hydrateCachedAttachmentMetadata(h.owner, [{ ...row, uid_validity: null }], execute);
    expect(execute).not.toHaveBeenCalled();
  });

  it('projects folder/unified/threaded rows without changing order or mixing the opener into the representative', async () => {
    const opener = await write(1, { filename: 'opener.pdf', header: '<opener@test>', date: '2026-11-01T10:00Z' });
    const reply = await write(2, { filename: 'reply.pdf', subject: 'Reply subject', header: '<reply@test>', date: '2026-11-02T10:00Z' });
    const other = await write(1, { acct: second, filename: 'other.pdf', thread: '<other-thread@test>' });
    const folder = await listMessages({ userId: h.owner, accountId: account.id, folder: 'INBOX', limit: 1 });
    expect(folder.messages).toHaveLength(1); assertMetadata(folder.messages[0], reply, 'reply.pdf');
    const page = await listMessages({ userId: h.owner, accountId: account.id, offset: 1, limit: 1 });
    assertMetadata(page.messages[0], opener, 'opener.pdf');
    const unified = await listMessages({ userId: h.owner });
    expect(unified.messages).toHaveLength(3); assertMetadata(unified.messages.find(m => m.id === other.id), other, 'other.pdf');
    const threaded = await listMessages({ userId: h.owner, accountId: account.id, threaded: true });
    expect(threaded.messages).toHaveLength(1); expect(threaded.messages[0].subject).toBe('Original subject');
    expect(threaded.messages[0].reply_subject).toBe('Reply subject'); assertMetadata(threaded.messages[0], reply, 'reply.pdf');
    expect(h.providerRead).not.toHaveBeenCalled(); expect(h.prefetchPolicy).not.toHaveBeenCalled();
  });

  it('projects ordinary and label search, native-label chosen location, and snoozed rows from cache only', async () => {
    const row = await write(1, { filename: 'live.pdf', providerId: 'same-source' }); await tag(row);
    await write(20, { folder: 'Archive', filename: 'archive-copy.pdf', providerId: 'same-source' });
    assertMetadata((await get('/api/search', { q: 'subject:Original', accountId: account.id })).messages.find(m => m.id === row.id), row, 'live.pdf');
    assertMetadata((await get('/api/search', { q: 'label:Work' })).messages.find(m => m.id === row.id), row, 'live.pdf');
    const native = await listNativeLabelMessages(labelInput()); expect(native.messages).toHaveLength(1); assertMetadata(native.messages[0], row, 'live.pdf');
    const feed = await get(`/api/labels/${label.id}/messages`, { accountId: account.id, storageGeneration: account.storage_generation });
    assertMetadata(feed.messages[0], row, 'live.pdf');
    const snoozed = await write(3, { folder: 'INBOX.Snoozed', filename: 'snoozed.pdf' });
    await h.pool.query(`INSERT INTO snoozed_messages(account_id,message_id_header,original_folder,snoozed_folder,snooze_until,storage_generation,entity_id,wake_state,user_id)
      VALUES ($1,$2,'INBOX','INBOX.Snoozed',NOW()+INTERVAL '1 hour',$3,$4,'ready',$5)`, [account.id, snoozed.message_id, snoozed.storage_generation, snoozed.entity_id, h.owner]);
    const snooze = await listMessages({ userId: h.owner, folder: 'Snoozed' });
    expect(snooze.total).toBe(1); assertMetadata(snooze.messages[0], snoozed, 'snoozed.pdf');
    expect(h.providerRead).not.toHaveBeenCalled(); expect(h.prefetchPolicy).not.toHaveBeenCalled();
  });

  it('hydrates message detail, resolve and expanded children with each child own source and no extra prefetch', async () => {
    const one = await write(1, { filename: 'one.pdf' }), other = await write(1, { acct: second, filename: 'other.pdf' });
    assertMetadata(await get(`/api/mail/messages/${one.id}`), one, 'one.pdf');
    assertMetadata(await get('/api/mail/resolve-message', { ref: one.message_id, accountId: one.account_id }), one, 'one.pdf');
    const thread = await get('/api/mail/thread', { id: one.thread_id }); expect(thread.messages).toHaveLength(2);
    assertMetadata(thread.messages.find(m => m.id === one.id), one, 'one.pdf');
    assertMetadata(thread.messages.find(m => m.id === other.id), other, 'other.pdf');
    const excluded = await write(1, { acct: foreign, filename: 'foreign.pdf' });
    await get(`/api/mail/messages/${excluded.id}`, {}, 404);
    await get('/api/mail/resolve-message', { ref: excluded.id }, 404);
    expect(h.providerRead).not.toHaveBeenCalled(); expect(h.prefetchPolicy).not.toHaveBeenCalled();
  });

  it('does not change allowed read-token routes or broaden native-label search access', async () => {
    const row = await write(1); await tag(row);
    for (const path of ['/api/mail/messages', `/api/mail/messages/${row.id}`, '/api/mail/thread', '/api/mail/resolve-message', '/api/search'])
      expect(matchApiTokenRoute('GET', path)?.scope).toBe('read');
    expect(matchApiTokenRoute('GET', `/api/labels/${label.id}/messages`)).toBeNull();
    assertMetadata((await get('/api/search', { q: 'subject:Original' }, 200, true)).messages[0], row, '1.pdf');
    expect((await get('/api/search', { q: 'label:Work' }, 403, true)).code).toBe('native_label_scope_required');
  });

  it('refuses metadata when a row changes after list selection and uses body-refined metadata only on the next read', async () => {
    const row = await write(1);
    h.beforeHydrate = () => h.pool.query("UPDATE entity_locations SET status='missing' WHERE entity_id=$1", [row.entity_id]);
    const stale = await listMessages({ userId: h.owner });
    expect(stale.messages[0]).toMatchObject({ id: row.id, has_attachments: true, attachmentMetadata: { state: 'unavailable', source: null, items: [] } });
    await h.pool.query("UPDATE entity_locations SET status='present' WHERE entity_id=$1", [row.entity_id]);
    await h.pool.query('UPDATE messages SET attachments=$1 WHERE id=$2', [JSON.stringify([part('body-refined.pdf')]), row.id]);
    assertMetadata((await listMessages({ userId: h.owner })).messages[0], row, 'body-refined.pdf');
    expect(h.providerRead).not.toHaveBeenCalled();
  });
});
