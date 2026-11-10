import { randomBytes } from 'crypto';
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
import {
  readMailboxIdentity, observeMailboxIdentity, assertMailboxIdentity, writeObservedMessage,
  prepareIdentityOperations, completeIdentityOperations, prepareAppendIdentityOperation,
  applyStorageIdentityDecision, getIdentityStatus, writeUnverifiedMessage, resolveCanonicalEntity,
} from './messageIdentity.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL)('durable message identity on PostgreSQL', () => {
  const dbName = `mailflow_identity_${randomBytes(5).toString('hex')}`;
  let admin, account, otherAccount;
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
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('identity-owner') RETURNING id")).rows[0].id;
    const add = async name => (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,$2,$3) RETURNING *`, [owner, name, `${name}@example.test`])).rows[0];
    account = await add('one'); otherAccount = await add('two');
  });
  const server = (folder, epoch = '10', capabilities = []) => ({ mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set(capabilities) });
  const context = async (folder = 'INBOX', epoch = '10', capabilities = [], acct = account) => observeMailboxIdentity(await readMailboxIdentity(acct, folder), server(folder, epoch, capabilities));
  const write = (ctx, uid, emailId = undefined, extra = {}) => writeObservedMessage(ctx, { uid, emailId }, client => client.query(`INSERT INTO messages(account_id,uid,folder,message_id,subject)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT(account_id,uid,folder) DO UPDATE SET subject=EXCLUDED.subject RETURNING *`,
  [ctx.accountId, uid, ctx.folderPath, extra.messageId ?? '<duplicate@example.test>', extra.subject ?? 'Same subject']));
  const entityAt = async (folder, uid) => (await h.pool.query('SELECT entity_id FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3', [account.id, folder, uid])).rows[0]?.entity_id;
  const map = (from, to, epoch = '20') => ({ uidMap: new Map([[from, to]]), uidValidity: BigInt(epoch) });

  it('does not merge Message-ID/subject/byte-identical generic deliveries, accounts or namespaces', async () => {
    const inbox = await context(); const archive = await context('Archive', '20');
    await write(inbox, 1); await write(inbox, 2); await write(archive, 1);
    expect(new Set([await entityAt('INBOX', 1), await entityAt('INBOX', 2), await entityAt('Archive', 1)]).size).toBe(3);
    const object = await context('Object', '30', ['OBJECTID']); const gmail = await context('Gmail', '40', ['X-GM-EXT-1']);
    await write(object, 1, '900719925474099312345'); await write(gmail, 1, '900719925474099312345');
    expect(await entityAt('Object', 1)).not.toBe(await entityAt('Gmail', 1));
    const foreign = await context('Object', '30', ['OBJECTID'], otherAccount); await write(foreign, 1, '900719925474099312345');
    expect((await h.pool.query('SELECT provider_id FROM entity_provider_keys')).rows.map(r => r.provider_id)).toEqual(Array(3).fill('900719925474099312345'));
    await expect(h.pool.query(`UPDATE messages SET entity_id=$1,storage_generation=$2,uid_validity=30 WHERE account_id=$3`, [await entityAt('Object', 1), account.storage_generation, otherAccount.id])).rejects.toMatchObject({ code: '23503' });
    await expect(h.pool.query(`INSERT INTO entity_provider_keys(account_id,storage_generation,namespace,provider_id,entity_id) VALUES ($1,$2,'imap-objectid','foreign',$3)`, [otherAccount.id, account.storage_generation, await entityAt('Object', 1)])).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces complete scoped identity even when the cache guard is disabled', async () => {
    const inbox = await context(); await write(inbox, 1); const entityId = await entityAt('INBOX', 1);
    await h.pool.query('ALTER TABLE messages DISABLE TRIGGER messages_identity_guard');
    try {
      await expect(h.pool.query(`INSERT INTO messages(account_id,uid,folder,entity_id,storage_generation,uid_validity)
        VALUES ($1,2,'INBOX',$2,$3,NULL)`, [account.id, entityId, account.storage_generation])).rejects.toMatchObject({ code: '23514' });
      await expect(h.pool.query(`INSERT INTO messages(account_id,uid,folder,entity_id,storage_generation,uid_validity)
        VALUES ($1,2,'INBOX',$2,$3,10)`, [otherAccount.id, entityId, account.storage_generation])).rejects.toMatchObject({ code: '23503' });
    } finally { await h.pool.query('ALTER TABLE messages ENABLE TRIGGER messages_identity_guard'); }
  });

  it('rebinds same-epoch cache deletion without recreating the durable entity', async () => {
    const inbox = await context(); await write(inbox, 1); const before = await entityAt('INBOX', 1);
    await h.pool.query('DELETE FROM messages'); await h.pool.query('DELETE FROM folders');
    const again = await context(); await write(again, 1);
    expect(await entityAt('INBOX', 1)).toBe(before);
    expect((await getIdentityStatus(account.id)).boundEntityCount).toBe('1');
  });

  it('preserves metadata unresolved on generic epoch reset and rebinds verified provider keys only', async () => {
    const old = await context(); await write(old, 1); const genericId = await entityAt('INBOX', 1);
    const replacement = await context('INBOX', '11'); await write(replacement, 1);
    expect(await entityAt('INBOX', 1)).not.toBe(genericId);
    await expect(write(old, 2)).rejects.toMatchObject({ code: 'identity_epoch_changed' });
    const stable = await context('Stable', '30', ['OBJECTID']); await write(stable, 1, 'opaque-id'); const stableId = await entityAt('Stable', 1);
    const reset = await context('Stable', '31', ['OBJECTID']); await write(reset, 9, 'opaque-id');
    expect(await entityAt('Stable', 9)).toBe(stableId);
    expect((await getIdentityStatus(account.id)).unresolvedEntityCount).toBe('1');
  });

  it('serializes concurrent same-provider-key arrivals and rejects stale SELECT snapshots', async () => {
    const a = await context('A', '1', ['OBJECTID']), b = await context('B', '2', ['OBJECTID']);
    await Promise.all([write(a, 1, 'shared'), write(b, 2, 'shared')]);
    expect(await entityAt('A', 1)).toBe(await entityAt('B', 2));
    const before = await readMailboxIdentity(account, 'A'); await context('A', '3');
    await expect(observeMailboxIdentity(before, server('A', '1'))).rejects.toMatchObject({ code: 'identity_epoch_changed' });
    await expect(assertMailboxIdentity(a, server('A', '3'))).rejects.toMatchObject({ code: 'identity_epoch_changed' });
  });

  it('journals contradictory provider evidence without changing either entity', async () => {
    const inbox = await context('INBOX', '10', ['OBJECTID']); await write(inbox, 1, 'one'); await write(inbox, 2, 'two');
    const before = await entityAt('INBOX', 1);
    await expect(write(inbox, 1, 'two')).rejects.toMatchObject({ code: 'identity_provider_conflict' });
    expect(await entityAt('INBOX', 1)).toBe(before);
    expect((await getIdentityStatus(account.id)).unresolvedOperationCount).toBe('1');
  });

  it('converges source-first and destination-sync-first MOVE while retaining cache-independent aliases', async () => {
    const source = await context(); await write(source, 1); const original = await entityAt('INBOX', 1);
    const operations = await prepareIdentityOperations(source, 'Archive', [1]);
    const destination = await context('Archive', '20'); await write(destination, 99); const provisional = await entityAt('Archive', 99);
    const [done] = await completeIdentityOperations(operations, map(1, 99));
    expect(done.state).toBe('bound'); expect(await entityAt('Archive', 99)).toBe(original);
    expect((await h.pool.query('SELECT canonical_entity_id FROM message_entities WHERE id=$1', [provisional])).rows[0].canonical_entity_id).toBe(original);
    await h.pool.query("DELETE FROM messages WHERE folder='INBOX'"); await write(done.destinationContext, 99);
    expect(await entityAt('Archive', 99)).toBe(original);
    await write(source, 2); const second = await entityAt('INBOX', 2);
    const ops = await prepareIdentityOperations(source, 'Other', [2]); const [mapped] = await completeIdentityOperations(ops, map(2, 88, '25'));
    await h.pool.query("UPDATE messages SET folder='Other',uid=88 WHERE folder='INBOX' AND uid=2");
    expect(await entityAt('Other', 88)).toBe(second);
    await write(mapped.destinationContext, 88); expect(await entityAt('Other', 88)).toBe(second);
  });

  it('converges genuinely concurrent destination sync and confirmed MOVE transactions', async () => {
    const source = await context(); const destination = await context('Archive', '20');
    for (let i = 1; i <= 8; i++) {
      await write(source, i); const expected = await entityAt('INBOX', i);
      const operations = await prepareIdentityOperations(source, 'Archive', [i]);
      const actions = [() => write(destination, 100 + i), () => completeIdentityOperations(operations, map(i, 100 + i))];
      if (i % 2) actions.reverse();
      await Promise.all(actions.map(action => action()));
      expect(await entityAt('Archive', 100 + i)).toBe(expected);
    }
  });

  it('keeps a subsequent prepared MOVE on the canonical entity after sync-first reconciliation', async () => {
    const source = await context(); await write(source, 1); const original = await entityAt('INBOX', 1);
    const firstMove = await prepareIdentityOperations(source, 'Archive', [1]);
    const destination = await context('Archive', '20'); await write(destination, 2);
    const historicalEntity = await entityAt('Archive', 2);
    const nextMove = await prepareIdentityOperations(destination, 'Later', [2]);
    await completeIdentityOperations(firstMove, map(1, 2));
    const [second] = await completeIdentityOperations(nextMove, map(2, 3, '30'));
    await write(second.destinationContext, 3);
    expect(await entityAt('Later', 3)).toBe(original);
    const [replayed] = await completeIdentityOperations(nextMove, map(2, 3, '30'));
    expect(replayed.destinationContext).toMatchObject({ folderPath: 'Later', uidValidity: '30' });
    expect(replayed.entityId).toBe(original);
    expect(await withTransaction(client => resolveCanonicalEntity(client, source, historicalEntity))).toBe(original);
    await expect(withTransaction(client => resolveCanonicalEntity(client,
      { accountId: otherAccount.id, storageGeneration: otherAccount.storage_generation }, historicalEntity))).rejects.toMatchObject({ code: 'identity_entity_missing' });
  });

  it('serializes an epoch reset against a pending old-epoch cache writer', async () => {
    const old = await context(); await write(old, 1); const before = await readMailboxIdentity(account, 'INBOX');
    const results = await Promise.allSettled([
      observeMailboxIdentity(before, server('INBOX', '11')),
      write(old, 2),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect((await h.pool.query('SELECT count(*) FROM messages WHERE account_id=$1 AND uid_validity=10', [account.id])).rows[0].count).toBe('0');
    expect((await h.pool.query('SELECT uid_validity FROM mailbox_identity_epochs WHERE account_id=$1', [account.id])).rows[0].uid_validity).toBe('11');
  });

  it('keeps generic COPY independent and accepts provider COPY projections only after fresh stable-key evidence', async () => {
    const source = await context(); await write(source, 1);
    const generic = await prepareIdentityOperations(source, 'Copy', [1], 'copy'); const [copied] = await completeIdentityOperations(generic, map(1, 2));
    await write(copied.destinationContext, 2); expect(await entityAt('Copy', 2)).not.toBe(await entityAt('INBOX', 1));
    const stable = await context('Stable', '30', ['OBJECTID']); await write(stable, 1, 'same-provider-object');
    const ops = await prepareIdentityOperations(stable, 'Projection', [1], 'copy'); const [projection] = await completeIdentityOperations(ops, map(1, 4, '40'));
    await write(projection.destinationContext, 4);
    const fetched = await context('Projection', '40', ['OBJECTID']); await write(fetched, 4, 'same-provider-object');
    expect(await entityAt('Projection', 4)).toBe(await entityAt('Stable', 1));
  });

  it('treats emulated MOVE with retained source as independent generic COPY', async () => {
    const source = await context(); await write(source, 1); const original = await entityAt('INBOX', 1);
    const operations = await prepareIdentityOperations(source, 'Archive', [1]);
    const [done] = await completeIdentityOperations(operations, { ...map(1, 2), sourceRetained: true });
    await write(done.destinationContext, 2);
    expect(done.operation_type).toBe('copy');
    expect(await entityAt('Archive', 2)).not.toBe(original);
    expect((await h.pool.query(`SELECT status FROM entity_locations WHERE account_id=$1 AND folder_path='INBOX' AND uid=1`, [account.id])).rows[0].status).toBe('present');
    const stable = await context('Stable', '30', ['OBJECTID']); await write(stable, 7, 'retained-stable-key');
    const stableOps = await prepareIdentityOperations(stable, 'Projection', [7]);
    const [projection] = await completeIdentityOperations(stableOps, { ...map(7, 8, '40'), sourceRetained: true });
    await write(projection.destinationContext, 8);
    const fetched = await context('Projection', '40', ['OBJECTID']); await write(fetched, 8, 'retained-stable-key');
    expect(await entityAt('Projection', 8)).toBe(await entityAt('Stable', 7));
    expect((await h.pool.query('SELECT operation_type FROM mail_identity_operations WHERE id=$1', [stableOps[0].id])).rows[0].operation_type).toBe('copy');
  });

  it.each(['append', 'move'])('coalesces untouched proved %s destinations on first stable-key FETCH and preserves edited conflicts', async kind => {
    const known = await context('Known', '40', ['OBJECTID']); await write(known, 9, 'existing-object');
    const canonical = await entityAt('Known', 9);
    for (const edited of [false, true]) {
      const folder = edited ? 'Edited' : 'Fresh';
      let operation;
      if (kind === 'append') operation = await prepareAppendIdentityOperation(await readMailboxIdentity(account, folder));
      else {
        const source = await context('GenericSource', '50'); await write(source, edited ? 2 : 1);
        [operation] = await prepareIdentityOperations(source, folder, [edited ? 2 : 1]);
      }
      const result = kind === 'append' ? { uid: 3, uidValidity: 60n } : map(edited ? 2 : 1, 3, '60');
      const [done] = await completeIdentityOperations([operation], result);
      await write(done.destinationContext, 3); const provisional = await entityAt(folder, 3);
      if (edited) await h.pool.query('UPDATE message_entities SET metadata_version=1 WHERE id=$1', [provisional]);
      const fetched = await context(folder, '60', ['OBJECTID']);
      if (edited) {
        await expect(write(fetched, 3, 'existing-object')).rejects.toMatchObject({ code: 'identity_provider_conflict' });
        expect(await entityAt(folder, 3)).toBe(provisional);
      } else {
        await write(fetched, 3, 'existing-object'); expect(await entityAt(folder, 3)).toBe(canonical);
      }
    }
  });

  it('never merges a destination with user metadata and never applies heuristic UID mappings', async () => {
    const source = await context(); await write(source, 1); const ops = await prepareIdentityOperations(source, 'Archive', [1]);
    const destination = await context('Archive', '20'); await write(destination, 9);
    await h.pool.query('UPDATE message_entities SET metadata_version=1 WHERE id=$1', [await entityAt('Archive', 9)]);
    expect((await completeIdentityOperations(ops, map(1, 9)))[0].state).toBe('unresolved');
    const uncertain = await prepareIdentityOperations(source, 'Unknown', [1]);
    expect((await completeIdentityOperations(uncertain, { uidMap: new Map([[1, 99]]) }))[0].state).toBe('unresolved');
    await h.pool.query("UPDATE messages SET folder='Unknown',uid=99 WHERE folder='INBOX' AND uid=1");
    expect(await entityAt('Unknown', 99)).toBeNull();
  });

  it('retains prepared/uncertain outcomes for recovery without replaying provider mutations', async () => {
    const source = await context(); await write(source, 1);
    const prepared = await prepareIdentityOperations(source, 'Archive', [1]);
    expect((await h.pool.query('SELECT state FROM mail_identity_operations WHERE id=$1', [prepared[0].id])).rows[0].state).toBe('prepared');
    expect((await completeIdentityOperations(prepared, null, { outcome: 'unknown' }))[0].state).toBe('outcome_unknown');
    expect((await completeIdentityOperations(prepared, map(1, 3)))[0].state).toBe('bound');
    expect((await completeIdentityOperations(prepared, null, { outcome: 'unknown' }))[0].state).toBe('bound');
  });

  it('captures APPENDUID and blocks delayed unverified callbacks from overwriting verified mail', async () => {
    const snapshot = await readMailboxIdentity(account, 'Sent'); const operation = await prepareAppendIdentityOperation(snapshot);
    const [done] = await completeIdentityOperations([operation], { uid: 1, uidValidity: 55n });
    await write(done.destinationContext, 1); const id = await entityAt('Sent', 1);
    const writeCallback = vi.fn(client => client.query("UPDATE messages SET subject='late callback'"));
    expect(await writeUnverifiedMessage(account, 'Sent', 1, writeCallback)).toMatchObject({ identityUnverified: true });
    expect(writeCallback).not.toHaveBeenCalled(); expect(await entityAt('Sent', 1)).toBe(id);
    await context('Sent', '56'); await expect(write(done.destinationContext, 1)).rejects.toMatchObject({ code: 'identity_epoch_changed' });
  });

  it('preserves generation on explicit same-mailbox choice, isolates replacements and rejects old writers', async () => {
    const original = await context('INBOX', '10', ['OBJECTID']); await write(original, 1, 'same-id');
    const previousEntity = await entityAt('INBOX', 1);
    expect(await withTransaction(client => applyStorageIdentityDecision(client, { accountId: account.id, expectedGeneration: account.storage_generation, decision: 'preserve' }))).toMatchObject({ storageGeneration: account.storage_generation, replaced: false });
    const changed = await withTransaction(client => applyStorageIdentityDecision(client, { accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
    await expect(write(original, 2, 'same-id')).rejects.toMatchObject({ code: 'storage_generation_conflict' });
    account = { ...account, storage_generation: changed.storageGeneration };
    const current = await context('INBOX', '10', ['OBJECTID']); await write(current, 1, 'same-id');
    expect(await entityAt('INBOX', 1)).not.toBe(previousEntity);
    expect((await getIdentityStatus(account.id)).priorGenerationEntityCount).toBe('1');
  });
  const insertSchedule = (client, generation = account.storage_generation, status = 'scheduled') => client.query(`
    INSERT INTO scheduled_messages(user_id,account_id,client_key,send_at,due_at,storage_generation,status)
    VALUES ($1,$2,gen_random_uuid(),NOW(),NOW(),$3,$4) RETURNING id`, [account.user_id,account.id,generation,status]);
  const replaceAccount = client => applyStorageIdentityDecision(client, { accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' });
  const waitBlocked = async pid => {
    for (let i=0;i<100;i++) {
      if ((await h.pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])).rows[0].n > 0) return;
      await new Promise(resolve => setTimeout(resolve,5));
    }
    throw new Error('Expected concurrent operation to wait for the account lock');
  };
  it('serializes pending schedule creation before replacement and refuses every pending state', async () => {
    const creator=await h.pool.connect(), replacer=await h.pool.connect();
    try {
      await creator.query('BEGIN'); await insertSchedule(creator);
      await replacer.query('BEGIN'); const pid=(await replacer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=replaceAccount(replacer).then(value=>({value}),error=>({error}));
      await waitBlocked(pid); await creator.query('COMMIT');
      expect((await pending).error).toMatchObject({code:'storage_identity_pending_sends'}); await replacer.query('ROLLBACK');
      for (const state of ['editing','sending','paused','failed','uncertain']) {
        await h.pool.query('UPDATE scheduled_messages SET status=$1',[state]);
        await expect(withTransaction(replaceAccount)).rejects.toMatchObject({code:'storage_identity_pending_sends'});
      }
    } finally { await creator.query('ROLLBACK'); await replacer.query('ROLLBACK'); creator.release();replacer.release(); }
  });
  it('rejects old prepared schedule creation after replacement wins without adopting provenance', async () => {
    const replacer=await h.pool.connect(), creator=await h.pool.connect();
    try {
      await replacer.query('BEGIN'); await replaceAccount(replacer);
      const pid=(await creator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=insertSchedule(creator).then(value=>({value}),error=>({error}));
      await waitBlocked(pid); await replacer.query('COMMIT');
      expect((await pending).error).toMatchObject({code:'23514'});
      expect((await h.pool.query('SELECT count(*) FROM scheduled_messages')).rows[0].count).toBe('0');
      await expect(insertSchedule(creator,null)).rejects.toMatchObject({code:'23514'});
    } finally { await replacer.query('ROLLBACK');creator.release();replacer.release(); }
  });
  it('serializes account-rule enable and retains disabled old-generation rules without re-enabling', async () => {
    const rule=(await h.pool.query(`INSERT INTO inbox_rules(user_id,account_id,storage_generation,enabled)
      VALUES ($1,$2,$3,false) RETURNING id`,[account.user_id,account.id,account.storage_generation])).rows[0];
    const enabler=await h.pool.connect(), replacer=await h.pool.connect();
    try {
      await enabler.query('BEGIN'); await enabler.query('UPDATE inbox_rules SET enabled=true WHERE id=$1',[rule.id]);
      await replacer.query('BEGIN');const pid=(await replacer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=replaceAccount(replacer).then(value=>({value}),error=>({error}));
      await waitBlocked(pid);await enabler.query('COMMIT');
      expect((await pending).error).toMatchObject({code:'storage_identity_enabled_rules'});await replacer.query('ROLLBACK');
      await h.pool.query('UPDATE inbox_rules SET enabled=false WHERE id=$1',[rule.id]);
      await withTransaction(replaceAccount);
      await expect(h.pool.query('UPDATE inbox_rules SET enabled=true WHERE id=$1',[rule.id])).rejects.toMatchObject({code:'23514'});
      expect((await h.pool.query('SELECT enabled,storage_generation FROM inbox_rules WHERE id=$1',[rule.id])).rows[0]).toEqual({enabled:false,storage_generation:account.storage_generation});
    } finally { await enabler.query('ROLLBACK');await replacer.query('ROLLBACK');enabler.release();replacer.release(); }
  });
  it('blocks replacement alongside a claim and refuses old-generation resume while allowing outcome recording', async () => {
    const job=(await insertSchedule(h.pool)).rows[0];
    const claimer=await h.pool.connect(), replacer=await h.pool.connect();
    try {
      await claimer.query('BEGIN');await claimer.query("UPDATE scheduled_messages SET status='sending' WHERE id=$1",[job.id]);
      await replacer.query('BEGIN');const pid=(await replacer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=replaceAccount(replacer).then(value=>({value}),error=>({error}));
      await waitBlocked(pid);await claimer.query('COMMIT');
      expect((await pending).error).toMatchObject({code:'storage_identity_pending_sends'});await replacer.query('ROLLBACK');
      await h.pool.query("UPDATE scheduled_messages SET status='cancelled' WHERE id=$1",[job.id]);
      await withTransaction(replaceAccount);
      await expect(h.pool.query("UPDATE scheduled_messages SET status='scheduled' WHERE id=$1",[job.id])).rejects.toMatchObject({code:'23514'});
      expect((await h.pool.query('SELECT status,storage_generation FROM scheduled_messages WHERE id=$1',[job.id])).rows[0]).toEqual({status:'cancelled',storage_generation:account.storage_generation});
    } finally { await claimer.query('ROLLBACK');await replacer.query('ROLLBACK');claimer.release();replacer.release(); }
  });

  it('refuses queued automation whose captured source UUID or epoch was replaced', async () => {
    const first=await context();await write(first,1);
    const expectedSource=(await h.pool.query('SELECT * FROM messages WHERE account_id=$1',[account.id])).rows[0];
    await expect(prepareIdentityOperations(first,'Archive',[1],'move',{expectedSource})).resolves.toHaveLength(1);
    const next=await context('INBOX','11');await write(next,1);
    await expect(prepareIdentityOperations(next,'Archive',[1],'move',{expectedSource})).rejects.toMatchObject({code:'identity_source_changed'});
    const current=(await h.pool.query('SELECT * FROM messages WHERE account_id=$1',[account.id])).rows[0];
    await expect(prepareIdentityOperations(next,'Archive',[1],'move',{expectedSource:{...current,id:expectedSource.id}})).rejects.toMatchObject({code:'identity_source_changed'});
    await expect(prepareIdentityOperations(next,'Archive',[1],'move',{expectedSource:{...current,entity_id:null}})).rejects.toMatchObject({code:'identity_source_changed'});
  });

});
