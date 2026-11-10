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
import { withTransaction } from './db.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage, prepareIdentityOperations,
  completeIdentityOperations, applyStorageIdentityDecision } from './messageIdentity.js';
import { createDefinition, deleteDefinition, previewDeletion } from './nativeLabelDefinitions.js';
import { mutateMemberships, queryMemberships, undoMemberships } from './nativeLabelMemberships.js';
import { matchApiTokenRoute } from './apiTokenAllowlist.js';
const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN_URL)('independent native label safety contracts on PostgreSQL', () => {
  const dbName = `mailflow_label_contract_${randomBytes(5).toString('hex')}`;
  let admin, account, owner, label;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 }); await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    owner = (await h.pool.query("INSERT INTO users(username) VALUES ('label-review') RETURNING id")).rows[0].id;
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'one','one@test') RETURNING *", [owner])).rows[0];
    label = (await createDefinition(owner, { accountId: account.id, mutationId: randomUUID(), name: 'Review' })).result.label;
  });
  const context = async (folder = 'INBOX', epoch = '10') => observeMailboxIdentity(await readMailboxIdentity(account, folder),
    { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set() });
  const write = async (ctx, uid = 1) => (await writeObservedMessage(ctx, { uid }, client => client.query(
    'INSERT INTO messages(account_id,folder,uid) VALUES ($1,$2,$3) RETURNING *', [account.id, ctx.folderPath, uid]))).rows[0];
  const request = (entityId, expectedMetadataVersion = '0', addLabelIds = [label.id], removeLabelIds = []) => ({
    accountId: account.id, storageGeneration: account.storage_generation, targets: [{ entityId, expectedMetadataVersion }],
    addLabelIds, removeLabelIds, mutationId: randomUUID(),
  });
  const directInsert = (entityId, generation = account.storage_generation) => h.pool.query(
    'INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id) VALUES ($1,$2,$3,$4)',
    [account.id, generation, entityId, label.id]);
  const entity = async id => (await h.pool.query('SELECT * FROM message_entities WHERE id=$1', [id])).rows[0];
  it('refuses direct membership writes to untouched provisional entities', async () => {
    const row = await write(await context());
    await expect(directInsert(row.entity_id)).rejects.toBeDefined();
    expect((await entity(row.entity_id)).metadata_version).toBe('0');
  });
  it('refuses direct membership writes to historical alias IDs even with a positive version', async () => {
    const row = await write(await context());
    const alias = (await h.pool.query(`INSERT INTO message_entities(account_id,storage_generation,canonical_entity_id,metadata_version)
      VALUES ($1,$2,$3,1) RETURNING id`, [account.id, account.storage_generation, row.entity_id])).rows[0].id;
    await expect(directInsert(alias)).rejects.toBeDefined();
  });
  it('an explicit no-op removal blocks later MOVE aliasing of the decided provisional entity', async () => {
    const source = await context(); await write(source);
    const operations = await prepareIdentityOperations(source, 'Archive', [1]);
    const destination = await write(await context('Archive', '20'), 99);
    const outcome = await mutateMemberships(owner, request(destination.entity_id, '0', [], [label.id]));
    expect(outcome.result.targets[0]).toMatchObject({ metadataVersion: '1', labelIds: [] });
    const [done] = await completeIdentityOperations(operations, { uidMap: new Map([[1, 99]]), uidValidity: 20n });
    expect(done.state).toBe('unresolved'); expect((await entity(destination.entity_id)).canonical_entity_id).toBeNull();
  });
  it('retained-generation deletion bumps each affected entity once and never deletes mail', async () => {
    const child = (await createDefinition(owner, { accountId: account.id, mutationId: randomUUID(), name: 'Child', parentId: label.id })).result.label;
    const row = await write(await context()); await mutateMemberships(owner, request(row.entity_id, '0', [label.id, child.id]));
    const priorGeneration = randomUUID();
    const prior = (await h.pool.query(`INSERT INTO message_entities(account_id,storage_generation,metadata_version)
      VALUES ($1,$2,9007199254740993) RETURNING id`, [account.id, priorGeneration])).rows[0].id;
    await directInsert(prior, priorGeneration);
    const preview = await previewDeletion(owner, label.id, { accountId: account.id });
    expect(preview.associations).toEqual(expect.arrayContaining([
      expect.objectContaining({ storageGeneration: priorGeneration, currentGeneration: false, entities: 1 }),
      expect.objectContaining({ storageGeneration: account.storage_generation, currentGeneration: true, entities: 1 }),
    ]));
    await deleteDefinition(owner, label.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: preview.treeRevision, confirmSubtree: true });
    expect((await entity(row.entity_id)).metadata_version).toBe('2');
    expect((await entity(prior)).metadata_version).toBe('9007199254740994');
    expect((await h.pool.query('SELECT id FROM messages WHERE id=$1', [row.id])).rowCount).toBe(1);
    expect((await h.pool.query('SELECT * FROM native_label_memberships')).rowCount).toBe(0);
  });
  it('replays exact recorded result after label deletion and replacement without restoring membership', async () => {
    const row = await write(await context()); const input = request(row.entity_id); const first = await mutateMemberships(owner, input);
    const preview = await previewDeletion(owner, label.id, { accountId: account.id });
    await deleteDefinition(owner, label.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: preview.treeRevision, confirmSubtree: true });
    await withTransaction(client => applyStorageIdentityDecision(client, { accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
    expect(await mutateMemberships(owner, input)).toEqual({ result: first.result, changed: false });
    expect((await h.pool.query('SELECT * FROM native_label_memberships')).rowCount).toBe(0);
    await expect(mutateMemberships(owner, { ...input, mutationId: randomUUID() })).rejects.toMatchObject({ code: 'stale_generation' });
  });
  it('deduplicates canonical targets without merging their metadata decisions', async () => {
    const source = await context(); const original = await write(source);
    const operations = await prepareIdentityOperations(source, 'Archive', [1]);
    const provisional = await write(await context('Archive', '20'), 99);
    await completeIdentityOperations(operations, { uidMap: new Map([[1, 99]]), uidValidity: 20n });
    const input = request(original.entity_id); input.targets.push({ entityId: provisional.entity_id, expectedMetadataVersion: '0' });
    const result = (await mutateMemberships(owner, input)).result;
    expect(result.targets).toHaveLength(2);
    for (const target of result.targets) expect(target).toMatchObject({ entityId: original.entity_id, metadataVersion: '1', labelIds: [label.id] });
    expect((await h.pool.query('SELECT * FROM native_label_memberships')).rowCount).toBe(1);
    const query = await queryMemberships(owner, { accountId: account.id, storageGeneration: account.storage_generation, targets: [{ entityId: provisional.entity_id }] });
    expect(query.targets[0]).toMatchObject({ requestedEntityId: provisional.entity_id, entityId: original.entity_id, metadataVersion: '1' });
  });

  it('Undo restores mixed preimages, canonical dedup and untouched membership timestamps', async () => {
    const other = (await createDefinition(owner, { accountId: account.id, mutationId: randomUUID(), name: 'Other' })).result.label;
    const keep = (await createDefinition(owner, { accountId: account.id, mutationId: randomUUID(), name: 'Keep' })).result.label;
    const source = await context(); const a = await write(source, 1); const b = await write(source, 2);
    await mutateMemberships(owner, request(a.entity_id, '0', [label.id, keep.id]));
    await mutateMemberships(owner, request(b.entity_id, '0', [other.id, keep.id]));
    const alias = (await h.pool.query(`INSERT INTO message_entities(account_id,storage_generation,canonical_entity_id)
      VALUES ($1,$2,$3) RETURNING id`, [account.id, account.storage_generation, a.entity_id])).rows[0].id;
    const before = (await h.pool.query('SELECT entity_id,label_id,created_at::text FROM native_label_memberships ORDER BY entity_id,label_id')).rows;
    const forward = request(a.entity_id, '1', [other.id], [label.id]);
    forward.targets.push({ entityId: alias, expectedMetadataVersion: '1' }, { entityId: b.entity_id, expectedMetadataVersion: '1' });
    const saved = await mutateMemberships(owner, forward);
    expect(saved.result.undoSupported).toBe(true); expect(saved.result).not.toHaveProperty('undo_state');
    const undo = { accountId: account.id, storageGeneration: account.storage_generation, originalMutationId: forward.mutationId, mutationId: randomUUID() };
    const restored = await undoMemberships(owner, undo);
    expect(restored.result.undoSupported).toBe(false); expect(restored.result.targets).toHaveLength(3);
    expect(restored.result.targets.every(target => target.metadataVersion === '3')).toBe(true);
    const after = (await h.pool.query('SELECT entity_id,label_id,created_at::text FROM native_label_memberships ORDER BY entity_id,label_id')).rows;
    expect(after.map(({ entity_id, label_id }) => ({ entity_id, label_id }))).toEqual(before.map(({ entity_id, label_id }) => ({ entity_id, label_id })));
    expect(after.filter(row => row.label_id === keep.id)).toEqual(before.filter(row => row.label_id === keep.id));
    expect(await undoMemberships(owner, undo)).toEqual({ result: restored.result, changed: false });
    await expect(undoMemberships(owner, { ...undo, originalMutationId: undo.mutationId, mutationId: randomUUID() })).rejects.toMatchObject({ code: 'undo_unavailable' });
  });

  it('a later no-op decision on one target atomically blocks the entire Undo batch', async () => {
    const ctx = await context(); const a = await write(ctx, 1); const b = await write(ctx, 2);
    const forward = request(a.entity_id); forward.targets.push({ entityId: b.entity_id, expectedMetadataVersion: '0' });
    await mutateMemberships(owner, forward);
    await mutateMemberships(owner, request(b.entity_id, '1'));
    const undo = { accountId: account.id, storageGeneration: account.storage_generation, originalMutationId: forward.mutationId, mutationId: randomUUID() };
    await expect(undoMemberships(owner, undo)).rejects.toMatchObject({ code: 'stale_metadata_version' });
    expect((await entity(a.entity_id)).metadata_version).toBe('1');
    expect((await entity(b.entity_id)).metadata_version).toBe('2');
    expect((await h.pool.query('SELECT * FROM native_label_memberships')).rowCount).toBe(2);
    expect((await h.pool.query('SELECT * FROM native_label_mutations WHERE mutation_id=$1', [undo.mutationId])).rowCount).toBe(0);
  });

  it('Undo of a no-op removal preserves the metadata decision fence and replays after replacement', async () => {
    const row = await write(await context()); const forward = request(row.entity_id, '0', [], [label.id]);
    await mutateMemberships(owner, forward);
    const undo = { accountId: account.id, storageGeneration: account.storage_generation, originalMutationId: forward.mutationId, mutationId: randomUUID() };
    const result = await undoMemberships(owner, undo);
    expect(result.result.targets[0]).toMatchObject({ metadataVersion: '2', labelIds: [] });
    await withTransaction(client => applyStorageIdentityDecision(client, { accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
    expect(await undoMemberships(owner, undo)).toEqual({ result: result.result, changed: false });
    expect((await entity(row.entity_id)).metadata_version).toBe('2');
    await expect(undoMemberships(owner, { ...undo, mutationId: randomUUID() })).rejects.toMatchObject({ code: 'stale_generation' });
  });
});
describe('native label API token boundary' , () => {
  it('keeps new membership and definition endpoints unavailable to API tokens', () => {
    for (const [method, path] of [['POST', '/api/labels/memberships'], ['POST', '/api/labels/memberships/query'], ['POST', '/api/labels/memberships/undo'],
      ['POST', '/api/labels'], ['DELETE', `/api/labels/${randomUUID()}`], ['GET', '/api/labels/counts'], ['GET', `/api/labels/${randomUUID()}/messages`]]) {
      expect(matchApiTokenRoute(method, path)).toBeNull();
    }
  });
});
