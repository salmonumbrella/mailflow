import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  },
}));
import { runMigrations } from './migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { createDefinition, deleteDefinition, previewDeletion, updateDefinition } from './nativeLabelDefinitions.js';
import { mutateMemberships, queryMemberships, validateMembershipRequest, undoMemberships, validateUndoRequest } from './nativeLabelMemberships.js';
const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe('native membership input boundaries', () => {
  it('rejects caller-provided Undo state and malformed identities before database access', () => {
    const input = { accountId: randomUUID(), storageGeneration: randomUUID(), originalMutationId: randomUUID(), mutationId: randomUUID() };
    expect(validateUndoRequest(input)).toEqual(input);
    for (const change of [{ originalMutationId: undefined }, { mutationId: 'bad' }, { targets: [] }, { undo_state: {} }, { labelIds: [] }]) {
      expect(() => validateUndoRequest({ ...input, ...change })).toThrow();
    }
  });
  it('preserves decimal versions and refuses ambiguous/unbounded requests', () => {
    const base = { accountId: randomUUID(), storageGeneration: randomUUID(), targets: [{ entityId: randomUUID(), expectedMetadataVersion: '9007199254740993' }], mutationId: randomUUID(), addLabelIds: [randomUUID()], removeLabelIds: [] };
    expect(validateMembershipRequest(base, true).targets[0].expectedMetadataVersion).toBe('9007199254740993');
    for (const change of [{ targets: [] }, { targets: Array(201).fill(base.targets[0]) }, { targets: [base.targets[0], base.targets[0]] },
      { targets: [{ ...base.targets[0], expectedMetadataVersion: 0 }] }, { targets: [{ ...base.targets[0], expectedMetadataVersion: '9223372036854775808' }] },
      { addLabelIds: [], removeLabelIds: [] }, { removeLabelIds: base.addLabelIds }, { extra: true }, { accountId: 'bad' }]) {
      expect(() => validateMembershipRequest({ ...base, ...change }, true)).toThrow();
    }
  });
});
describe.skipIf(!ADMIN_URL)('native label membership transactions on PostgreSQL', () => {
  const dbName = `mailflow_membership_${randomBytes(5).toString('hex')}`;
  let admin, account, other, user, stranger, message, second, label, otherLabel;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {}); await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); vi.restoreAllMocks(); });
  const observe = async (acct, uid) => {
    const ctx = await observeMailboxIdentity(await readMailboxIdentity(acct, 'INBOX'), { mailbox: { path: 'INBOX', uidValidity: 123n }, capabilities: new Set() });
    return (await writeObservedMessage(ctx, { uid }, client => client.query(`INSERT INTO messages(account_id,folder,uid,message_id,subject)
      VALUES ($1,'INBOX',$2,'<same@test>','Same headers are not identity') RETURNING *`, [acct.id, uid]))).rows[0];
  };
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('owner') RETURNING id")).rows[0].id;
    stranger = (await h.pool.query("INSERT INTO users(username) VALUES ('stranger') RETURNING id")).rows[0].id;
    const add = async (owner, name) => (await h.pool.query('INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,$2,$3) RETURNING *', [owner, name, `${name}@test`])).rows[0];
    account = await add(user, 'one'); other = await add(stranger, 'other');
    message = await observe(account, 1); second = await observe(account, 2);
    label = (await createDefinition(user, { accountId: account.id, mutationId: randomUUID(), name: 'Work' })).result.label;
    otherLabel = (await createDefinition(stranger, { accountId: other.id, mutationId: randomUUID(), name: 'Work' })).result.label;
  });
  const request = (extra = {}) => ({ accountId: account.id, storageGeneration: account.storage_generation, targets: [{ entityId: message.entity_id, expectedMetadataVersion: '0' }], addLabelIds: [label.id], removeLabelIds: [], mutationId: randomUUID(), ...extra });
  const query = (targets = [message.entity_id]) => queryMemberships(user, { accountId: account.id, storageGeneration: account.storage_generation, targets: targets.map(entityId => ({ entityId })) });
  const version = async id => (await h.pool.query('SELECT metadata_version FROM message_entities WHERE id=$1', [id])).rows[0].metadata_version;
  it('assigns only explicit entities and preserves exact large versions', async () => {
    await h.pool.query('UPDATE message_entities SET metadata_version=9007199254740993 WHERE id=$1', [message.entity_id]);
    const result = await mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '9007199254740993' }] }));
    expect(result.result.targets[0]).toMatchObject({ metadataVersion: '9007199254740994', labelIds: [label.id], available: true });
    expect((await query([second.entity_id])).targets[0].labelIds).toEqual([]); expect(await version(second.entity_id)).toBe('0');
  });
  it('rejects inaccessible accounts, foreign labels/entities and stale batches atomically', async () => {
    await expect(mutateMemberships(stranger, request())).rejects.toMatchObject({ status: 404 });
    await expect(mutateMemberships(user, request({ addLabelIds: [otherLabel.id] }))).rejects.toMatchObject({ code: 'label_not_found' });
    const foreign = await observe(other, 1);
    await expect(mutateMemberships(user, request({ targets: [{ entityId: foreign.entity_id, expectedMetadataVersion: '0' }] }))).rejects.toMatchObject({ status: 404 });
    await expect(mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '0' }, { entityId: second.entity_id, expectedMetadataVersion: '1' }] }))).rejects.toMatchObject({ code: 'stale_metadata_version' });
    expect(await version(message.entity_id)).toBe('0'); expect((await query()).targets[0].labelIds).toEqual([]);
    expect((await h.pool.query('SELECT * FROM native_label_mutations')).rows).toHaveLength(0);
  });
  it('replays concurrent requests once and preserves historical response after later removal', async () => {
    const input = request(); const [a, b] = await Promise.all([mutateMemberships(user, input), mutateMemberships(user, input)]);
    expect(a.result).toEqual(b.result); expect([a.changed, b.changed].sort()).toEqual([false, true]); expect(await version(message.entity_id)).toBe('1');
    await mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '1' }], addLabelIds: [], removeLabelIds: [label.id] }));
    expect((await mutateMemberships(user, input)).result).toEqual(a.result);
    expect((await query()).targets[0]).toMatchObject({ metadataVersion: '2', labelIds: [] });
    await expect(mutateMemberships(user, { ...input, addLabelIds: [], removeLabelIds: [label.id] })).rejects.toMatchObject({ code: 'mutation_conflict' });
    await h.pool.query("UPDATE native_label_mutations SET created_at=NOW()-INTERVAL '31 days' WHERE mutation_id=$1", [input.mutationId]);
    await expect(mutateMemberships(user, input)).rejects.toMatchObject({ code: 'mutation_expired' });
    await mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '2' }] }));
    expect((await h.pool.query('SELECT response FROM native_label_mutations WHERE mutation_id=$1', [input.mutationId])).rows[0].response).toBeNull();
    await expect(mutateMemberships(user, input)).rejects.toMatchObject({ code: 'mutation_expired' });
  });
  it('serializes competing metadata decisions', async () => {
    const results = await Promise.allSettled([mutateMemberships(user, request()), mutateMemberships(user, request({ addLabelIds: [], removeLabelIds: [label.id] }))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.code).toBe('stale_metadata_version'); expect(await version(message.entity_id)).toBe('1');
  });
  it('resolves and deduplicates aliases without losing expected-version checks', async () => {
    const alias = (await h.pool.query('INSERT INTO message_entities(account_id,storage_generation,canonical_entity_id) VALUES ($1,$2,$3) RETURNING id', [account.id, account.storage_generation, message.entity_id])).rows[0].id;
    await expect(mutateMemberships(user, request({ targets: [{ entityId: alias, expectedMetadataVersion: '1' }, { entityId: message.entity_id, expectedMetadataVersion: '0' }] }))).rejects.toMatchObject({ code: 'stale_metadata_version' });
    const result = await mutateMemberships(user, request({ targets: [{ entityId: alias, expectedMetadataVersion: '0' }, { entityId: message.entity_id, expectedMetadataVersion: '0' }] }));
    expect(result.result.targets).toHaveLength(2); expect(result.result.targets.every(t => t.entityId === message.entity_id && t.metadataVersion === '1')).toBe(true);
    expect((await h.pool.query('SELECT * FROM native_label_memberships')).rows).toHaveLength(1);
  });
  it('advances explicit no-op decisions and retains metadata across cache purge', async () => {
    await mutateMemberships(user, request({ addLabelIds: [], removeLabelIds: [label.id] })); expect(await version(message.entity_id)).toBe('1');
    await mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '1' }] }));
    await h.pool.query('TRUNCATE messages, folders');
    expect((await query()).targets[0]).toMatchObject({ available: false, labelIds: [label.id], metadataVersion: '2' });
    await expect(mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '2' }] }))).rejects.toMatchObject({ code: 'identity_unavailable' });
    expect((await observe(account, 1)).entity_id).toBe(message.entity_id); expect((await query()).targets[0].available).toBe(true);
  });
  it('checks current epochs and deleted source instead of trusting entity UUIDs', async () => {
    await h.pool.query('UPDATE messages SET is_deleted=true WHERE id=$1', [message.id]);
    await expect(mutateMemberships(user, request())).rejects.toMatchObject({ code: 'identity_unavailable' });
    await h.pool.query('UPDATE messages SET is_deleted=false WHERE id=$1', [message.id]);
    await h.pool.query('UPDATE mailbox_identity_epochs SET uid_validity=124 WHERE account_id=$1', [account.id]);
    await expect(mutateMemberships(user, request())).rejects.toMatchObject({ code: 'identity_unavailable' });
  });
  it('serializes assignment, subtree deletion and an unrelated definition edit without lock upgrades', async () => {
    const separate = (await createDefinition(user, { accountId: account.id, mutationId: randomUUID(), name: 'Separate' })).result.label;
    const preview = await previewDeletion(user, label.id, { accountId: account.id });
    const lock = await h.pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE', [account.id]);
    const pending = [mutateMemberships(user, request()),
      deleteDefinition(user, label.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: preview.treeRevision, confirmSubtree: true }),
      updateDefinition(user, separate.id, { accountId: account.id, mutationId: randomUUID(), expectedRevision: separate.revision, name: 'Renamed' })];
    const resultsPromise = Promise.allSettled(pending);
    try {
      let waiting = 0;
      for (let i = 0; i < 100; i++) {
        waiting = Number((await h.pool.query(`SELECT COUNT(*) FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM email_accounts%'`)).rows[0].count);
        if (waiting === 3) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(3);
    } finally { await lock.query('COMMIT'); lock.release(); }
    const results = await resultsPromise;
    expect(results[2].status).toBe('fulfilled');
    for (const result of results.filter(r => r.status === 'rejected')) expect(['stale_tree_revision', 'label_not_found']).toContain(result.reason.code);
    expect((await h.pool.query('SELECT COUNT(*) FROM messages')).rows[0].count).toBe('2');
  });
  it('refuses exhausted membership and deletion versions without partial edits', async () => {
    await mutateMemberships(user, request());
    await h.pool.query('UPDATE message_entities SET metadata_version=9223372036854775807 WHERE id=$1', [message.entity_id]);
    await expect(mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '9223372036854775807' }], addLabelIds: [], removeLabelIds: [label.id] })))
      .rejects.toMatchObject({ code: 'metadata_version_exhausted', status: 409 });
    const preview = await previewDeletion(user, label.id, { accountId: account.id });
    await expect(deleteDefinition(user, label.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: preview.treeRevision, confirmSubtree: true }))
      .rejects.toMatchObject({ code: 'metadata_version_exhausted', status: 409 });
    expect((await query()).targets[0]).toMatchObject({ metadataVersion: '9223372036854775807', labelIds: [label.id] });
  });
  const undoRequest = originalMutationId => ({ accountId: account.id, storageGeneration: account.storage_generation, originalMutationId, mutationId: randomUUID() });
  it('undo restores mixed preimages per entity with exact replay and no private snapshot disclosure', async () => {
    await mutateMemberships(user, request());
    const input = request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '1' }, { entityId: second.entity_id, expectedMetadataVersion: '0' }] });
    const applied = await mutateMemberships(user, input);
    expect(applied.result.undoSupported).toBe(true); expect(applied.result).not.toHaveProperty('undo_state');
    const undo = undoRequest(input.mutationId);
    const [a, b] = await Promise.all([undoMemberships(user, undo), undoMemberships(user, undo)]);
    expect(a.result).toEqual(b.result); expect([a.changed, b.changed].sort()).toEqual([false, true]);
    expect(a.result.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: message.entity_id, labelIds: [label.id], metadataVersion: '3' }),
      expect.objectContaining({ entityId: second.entity_id, labelIds: [], metadataVersion: '2' }),
    ]));
    expect(a.result.undoSupported).toBe(false);
    await expect(undoMemberships(user, undoRequest(undo.mutationId))).rejects.toMatchObject({ code: 'undo_unavailable' });
    await expect(undoMemberships(user, { ...undo, originalMutationId: randomUUID() })).rejects.toMatchObject({ code: 'mutation_conflict' });
  });
  it('undo rejects an intervening no-op decision on one target without restoring any target', async () => {
    const input = request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '0' }, { entityId: second.entity_id, expectedMetadataVersion: '0' }] });
    await mutateMemberships(user, input);
    await mutateMemberships(user, request({ targets: [{ entityId: second.entity_id, expectedMetadataVersion: '1' }] }));
    await expect(undoMemberships(user, undoRequest(input.mutationId))).rejects.toMatchObject({ code: 'stale_metadata_version' });
    expect((await query([message.entity_id, second.entity_id])).targets.every(t => t.labelIds.includes(label.id))).toBe(true);
    expect(await version(message.entity_id)).toBe('1');
  });
  it('undo accepts historical requested aliases and restores explicit no-op decisions only once per canonical entity', async () => {
    const alias = (await h.pool.query('INSERT INTO message_entities(account_id,storage_generation,canonical_entity_id) VALUES ($1,$2,$3) RETURNING id', [account.id, account.storage_generation, message.entity_id])).rows[0].id;
    const input = request({ targets: [{ entityId: alias, expectedMetadataVersion: '0' }, { entityId: message.entity_id, expectedMetadataVersion: '0' }], addLabelIds: [], removeLabelIds: [label.id] });
    await mutateMemberships(user, input);
    const result = await undoMemberships(user, undoRequest(input.mutationId));
    expect(result.result.targets).toHaveLength(2);
    expect(result.result.targets.every(t => t.entityId === message.entity_id && t.metadataVersion === '2' && t.labelIds.length === 0)).toBe(true);
  });
  it('undo rejects missing, expired and deleted-definition originals without guessing', async () => {
    await expect(undoMemberships(user, undoRequest(randomUUID()))).rejects.toMatchObject({ code: 'undo_unavailable' });
    const input = request({ addLabelIds: [], removeLabelIds: [label.id] });
    await mutateMemberships(user, input);
    await expect(undoMemberships(stranger, undoRequest(input.mutationId))).rejects.toMatchObject({ status: 404 });
    await h.pool.query("UPDATE native_label_mutations SET created_at=NOW()-INTERVAL '31 days' WHERE mutation_id=$1", [input.mutationId]);
    await expect(undoMemberships(user, undoRequest(input.mutationId))).rejects.toMatchObject({ code: 'mutation_expired' });
    await h.pool.query('UPDATE native_label_mutations SET created_at=NOW() WHERE mutation_id=$1', [input.mutationId]);
    const preview = await previewDeletion(user, label.id, { accountId: account.id });
    await deleteDefinition(user, label.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: preview.treeRevision, confirmSubtree: true });
    await expect(undoMemberships(user, undoRequest(input.mutationId))).rejects.toMatchObject({ code: 'undo_unavailable' });
    expect(await version(message.entity_id)).toBe('1');
  });
  it('committed undo replays after later edits/replacement while new undo refuses replacement', async () => {
    const input = request(); await mutateMemberships(user, input);
    const undo = undoRequest(input.mutationId); const result = await undoMemberships(user, undo);
    await mutateMemberships(user, request({ targets: [{ entityId: message.entity_id, expectedMetadataVersion: '2' }] }));
    expect((await undoMemberships(user, undo)).result).toEqual(result.result);
    expect((await query()).targets[0].labelIds).toEqual([label.id]);
    await h.pool.query('UPDATE email_accounts SET storage_generation=$2 WHERE id=$1', [account.id, randomUUID()]);
    expect((await undoMemberships(user, undo)).result).toEqual(result.result);
    await expect(undoMemberships(user, undoRequest(input.mutationId))).rejects.toMatchObject({ code: 'stale_generation' });
    expect(await version(message.entity_id)).toBe('3');
  });
  it('undo requires a live verified source and retains history until recovery', async () => {
    const input = request(); await mutateMemberships(user, input);
    await h.pool.query('TRUNCATE messages, folders');
    const undo = undoRequest(input.mutationId);
    await expect(undoMemberships(user, undo)).rejects.toMatchObject({ code: 'identity_unavailable' });
    await observe(account, 1);
    expect((await undoMemberships(user, undo)).result.targets[0].labelIds).toEqual([]);
  });
  it('serializes definition deletion with assignment without deleting mail', async () => {
    const preview = await previewDeletion(user, label.id, { accountId: account.id });
    const results = await Promise.allSettled([mutateMemberships(user, request()), deleteDefinition(user, label.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: preview.treeRevision, confirmSubtree: true })]);
    expect(results[1].status).toBe('fulfilled'); expect((await h.pool.query('SELECT * FROM native_label_memberships')).rows).toHaveLength(0);
    expect((await h.pool.query('SELECT * FROM messages')).rows).toHaveLength(2);
    if (results[0].status === 'fulfilled') expect(await version(message.entity_id)).toBe('2'); else expect(results[0].reason.code).toBe('label_not_found');
  });
});
