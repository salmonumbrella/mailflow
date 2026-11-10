import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
import { runMigrations } from './migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { hydrateNativeLabels, listNativeLabelMessages, getNativeLabelCounts } from './nativeLabelReadModel.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL)('native label verified cache read model on PostgreSQL', () => {
  const dbName = `mailflow_label_reads_${randomBytes(5).toString('hex')}`;
  let admin, account, owner, label, child;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new globalThis.URL(URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
  });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    owner = (await h.pool.query("INSERT INTO users(username) VALUES ('label-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'one','one@example.test') RETURNING *", [owner])).rows[0];
    label = (await h.pool.query(`INSERT INTO mail_labels(account_id,name,normalized_name,full_path,color,text_color)
      VALUES ($1,'Work','work','Work','#123456','#ffffff') RETURNING *`, [account.id])).rows[0];
    child = (await h.pool.query(`INSERT INTO mail_labels(account_id,parent_id,name,normalized_name,full_path)
      VALUES ($1,$2,'Child','child','Work/Child') RETURNING *`, [account.id, label.id])).rows[0];
  });
  const context = async (folder = 'INBOX', epoch = '10', acct = account) => observeMailboxIdentity(await readMailboxIdentity(acct, folder),
    { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set(['OBJECTID']) });
  const write = async (uid, { folder = 'INBOX', epoch = '10', providerId, read = false, date = '2026-11-01 12:00:00+00', acct = account } = {}) => {
    const ctx = await context(folder, epoch, acct);
    return writeObservedMessage(ctx, { uid, ...(providerId ? { emailId: providerId } : {}) }, client => client.query(`
      INSERT INTO messages(account_id,uid,folder,message_id,subject,is_read,date)
      VALUES ($1,$2,$3,'<identical@example.test>','Same header independent delivery',$4,$5)
      ON CONFLICT(account_id,uid,folder) DO UPDATE SET subject=EXCLUDED.subject RETURNING *`, [acct.id, uid, folder, read, date]));
  };
  const at = async (uid, folder = 'INBOX') => (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND uid=$2 AND folder=$3', [account.id, uid, folder])).rows[0];
  const tag = async (entityId, labelId = label.id) => {
    await h.pool.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1', [entityId]);
    return h.pool.query(`INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [account.id, account.storage_generation, entityId, labelId]);
  };
  const input = extra => ({ userId: owner, accountId: account.id, storageGeneration: account.storage_generation, labelId: label.id, ...extra });

  it('deduplicates verified projections but preserves independent identical-header deliveries and real action locators', async () => {
    await write(1, { providerId: 'same', read: true });
    await write(8, { folder: 'Archive', providerId: 'same' });
    await write(2); await write(3);
    for (const uid of [1, 2, 3]) await tag((await at(uid)).entity_id);
    const feed = await listNativeLabelMessages(input());
    expect(feed.total).toBe(3); expect(feed.unread).toBe(3);
    expect(new Set(feed.messages.map(m => m.entityId)).size).toBe(3);
    const projection = feed.messages.find(m => String(m.uid) === '1');
    expect(projection).toMatchObject({ uid: '1', folder: 'INBOX', is_read: false, locator_is_read: true,
      nativeLabelState: 'available', nativeLabelScope: 'message', metadataVersion: '1' });
    expect(projection.nativeLabels[0]).toMatchObject({ id: label.id, path: 'Work', color: '#123456', textColor: '#ffffff', messageVisible: true });
    expect(projection).not.toHaveProperty('body_html');
    const counts = await getNativeLabelCounts(input());
    expect(counts.counts.find(c => c.labelId === label.id)).toEqual({ labelId: label.id, total: 3, unread: 3, unresolvedMemberships: 0 });
    expect(feed.coverage).toMatchObject({ kind: 'synchronized-cache', providerComplete: false, directMembershipOnly: true });
  });

  it('returns unknown identity as unavailable and never supplies a misleading empty label set', async () => {
    const unknown = (await h.pool.query("INSERT INTO messages(account_id,uid,subject) VALUES ($1,44,'Unknown') RETURNING *", [account.id])).rows[0];
    await write(1); const verified = await at(1);
    const rows = await hydrateNativeLabels(owner, [unknown, verified]);
    expect(rows[0]).toMatchObject({ nativeLabelState: 'unavailable', nativeLabels: null, entityId: null, metadataVersion: null, storageGeneration: account.storage_generation });
    expect(rows[1]).toMatchObject({ nativeLabelState: 'available', nativeLabels: [], entityId: verified.entity_id });
    expect((await listNativeLabelMessages(input())).messages).toEqual([]);
  });

  it('hydrates in bounded batches, preserving exact versions and one set read per batch', async () => {
    await write(1); const message = await at(1); await tag(message.entity_id);
    await h.pool.query('UPDATE message_entities SET metadata_version=9007199254740993 WHERE id=$1', [message.entity_id]);
    const execute = vi.fn((...args) => h.pool.query(...args));
    const rows = await hydrateNativeLabels(owner, Array.from({ length: 401 }, () => message), execute);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(rows.every(r => r.metadataVersion === '9007199254740993')).toBe(true);
    expect((await hydrateNativeLabels(randomUUID(), [message]))[0]).toMatchObject({ entityId: null, nativeLabels: null });
  });

  it('rejects stale coordinates after a cache row moves and never uses the old header as identity', async () => {
    await write(1); const old = await at(1); await tag(old.entity_id);
    await h.pool.query("UPDATE messages SET folder='Moved',uid=9 WHERE id=$1", [old.id]);
    expect((await hydrateNativeLabels(owner, [old]))[0].nativeLabelState).toBe('unavailable');
    expect((await listNativeLabelMessages(input())).coverage.unresolvedMemberships).toBe(1);
  });

  it('never transfers labels to an earlier row snapshot after a same-UUID same-UID epoch rebind', async () => {
    await write(1); const old = await at(1); await tag(old.entity_id);
    await write(1, { epoch: '11' });
    // Cache UUID stability is not an identity guarantee, even when an ingestion path
    // chooses to preserve it during a rebind. Exercise that permitted state explicitly.
    await h.pool.query('UPDATE messages SET id=$1 WHERE account_id=$2 AND uid=1', [old.id, account.id]);
    const replacement = await at(1);
    expect(replacement.id).toBe(old.id);
    expect(replacement.entity_id).not.toBe(old.entity_id);
    await tag(replacement.entity_id, child.id);
    const rows = await hydrateNativeLabels(owner, [old, replacement]);
    expect(rows[0]).toMatchObject({ nativeLabelState: 'unavailable', entityId: null, nativeLabels: null });
    expect(rows[1]).toMatchObject({ nativeLabelState: 'available', entityId: replacement.entity_id });
    expect(rows[1].nativeLabels.map(l => l.id)).toEqual([child.id]);
  });

  it('retains unresolved membership over cache purge and rebinds only a proved same-epoch location', async () => {
    await write(1); const old = await at(1); await tag(old.entity_id);
    await h.pool.query('DELETE FROM messages');
    expect(await listNativeLabelMessages(input())).toMatchObject({ total: 0, coverage: { unresolvedMemberships: 1 } });
    await write(1);
    const rebound = await listNativeLabelMessages(input());
    expect(rebound).toMatchObject({ total: 1, coverage: { unresolvedMemberships: 0 } });
    expect(rebound.messages[0].entityId).toBe(old.entity_id);
  });

  it('keeps prior epochs and generations out of the feed and guards stale-generation requests', async () => {
    await write(1); const old = await at(1); await tag(old.entity_id);
    await context('INBOX', '11');
    expect(await listNativeLabelMessages(input())).toMatchObject({ total: 0, coverage: { unresolvedMemberships: 1 } });
    expect((await hydrateNativeLabels(owner, [old]))[0].nativeLabelState).toBe('unavailable');
    const generation = randomUUID();
    await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [generation, account.id]);
    await expect(listNativeLabelMessages(input())).rejects.toMatchObject({ status: 409, code: 'storage_generation_conflict' });
    expect((await hydrateNativeLabels(owner, [old]))[0]).toMatchObject({ nativeLabelState: 'unavailable', storageGeneration: generation });
    expect(await listNativeLabelMessages(input({ storageGeneration: generation }))).toMatchObject({ total: 0, coverage: { unresolvedMemberships: 0, priorGenerationMemberships: 1 } });
    expect(await getNativeLabelCounts(input({ storageGeneration: generation }))).toMatchObject({ coverage: { priorGenerationMemberships: 1 } });
  });

  it('uses direct memberships and explicit Spam/Trash scope with unread-any-eligible-location semantics', async () => {
    await write(1, { read: true, providerId: 'one' });
    await write(8, { folder: 'Spam', providerId: 'one' });
    await write(2, { folder: 'Trash' });
    await write(3); await tag((await at(3)).entity_id, child.id);
    await tag((await at(1)).entity_id); await tag((await at(2, 'Trash')).entity_id);
    expect(await listNativeLabelMessages(input())).toMatchObject({ total: 1, unread: 0, coverage: { unresolvedMemberships: 0 } });
    expect(await listNativeLabelMessages(input({ includeSpamTrash: true }))).toMatchObject({ total: 2, unread: 2 });
    expect(await listNativeLabelMessages(input({ unreadOnly: true }))).toMatchObject({ total: 0, messages: [] });
    expect(await listNativeLabelMessages(input({ labelId: child.id }))).toMatchObject({ total: 1 });
    const counts = (await getNativeLabelCounts(input())).counts.find(c => c.labelId === label.id);
    expect(counts).toEqual({ labelId: label.id, total: 1, unread: 0, unresolvedMemberships: 0 });
  });

  it('excludes deleted cache and non-present locations, retaining associations as unresolved', async () => {
    await write(1); await write(2); await tag((await at(1)).entity_id); await tag((await at(2)).entity_id);
    await h.pool.query('UPDATE messages SET is_deleted=true WHERE uid=1');
    await h.pool.query("UPDATE entity_locations SET status='missing' WHERE uid=2");
    expect(await listNativeLabelMessages(input())).toMatchObject({ total: 0, coverage: { unresolvedMemberships: 2 } });
  });

  it('paginates by full timestamp precision and canonical entity, including null dates', async () => {
    for (let uid = 1; uid <= 5; uid++) {
      await write(uid, { date: uid < 3 ? '2026-11-01 12:00:00.123456+00' : uid === 5 ? null : '2026-11-01 12:00:00.123455+00' });
      await tag((await at(uid)).entity_id);
    }
    const ids = []; let cursor;
    do {
      const feed = await listNativeLabelMessages(input({ limit: 1, cursor }));
      ids.push(...feed.messages.map(m => m.id)); cursor = feed.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5); expect(ids.at(-1)).toBe((await at(5)).id);
    const first = await listNativeLabelMessages(input({ limit: 1 }));
    await expect(listNativeLabelMessages(input({ labelId: child.id, cursor: first.nextCursor }))).rejects.toMatchObject({ status: 400 });
    await expect(listNativeLabelMessages(input({ unreadOnly: true, cursor: first.nextCursor }))).rejects.toMatchObject({ status: 400 });
    await expect(listNativeLabelMessages(input({ cursor: 'not-json' }))).rejects.toMatchObject({ status: 400 });
  });

  it('resolves flattened aliases for hydration and feed without duplicating a canonical entity', async () => {
    await write(1); await write(2); const canonical = await at(1); const alias = await at(2);
    await h.pool.query('UPDATE message_entities SET canonical_entity_id=$1 WHERE id=$2', [canonical.entity_id, alias.entity_id]);
    await tag(canonical.entity_id);
    const feed = await listNativeLabelMessages(input());
    expect(feed.total).toBe(1); expect(feed.messages[0].entityId).toBe(canonical.entity_id);
    expect(feed.messages[0].nativeLabels.map(l => l.id)).toEqual([label.id]);
    const hydrated = await hydrateNativeLabels(owner, [alias]); expect(hydrated[0].entityId).toBe(canonical.entity_id);
  });

  it('enforces account ownership and label-account scope even with correct generation', async () => {
    await write(1); await tag((await at(1)).entity_id);
    await expect(listNativeLabelMessages(input({ userId: randomUUID() }))).rejects.toMatchObject({ status: 404 });
    await expect(getNativeLabelCounts(input({ userId: randomUUID() }))).rejects.toMatchObject({ status: 404 });
    const other = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'two','two@example.test') RETURNING *", [owner])).rows[0];
    await expect(listNativeLabelMessages(input({ accountId: other.id, storageGeneration: other.storage_generation }))).rejects.toMatchObject({ status: 404 });
    expect(await getNativeLabelCounts(input({ accountId: other.id, storageGeneration: other.storage_generation }))).toMatchObject({ counts: [] });
  });
});
