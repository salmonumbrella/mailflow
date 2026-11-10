import { randomBytes, randomUUID } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { gunzipSync, gzipSync } from 'zlib';
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
import { mutateMemberships, undoMemberships } from './nativeLabelMemberships.js';
import { runMigrations } from './migrations.js';
import { restoreBackup, writeBackup, SETUP_TABLES, MAIL_CACHE_TABLES, TRANSIENT_TABLES } from './backup.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
const durable = ['message_entities', 'entity_provider_keys', 'entity_locations', 'mailbox_identity_epochs',
  'native_label_memberships', 'native_label_mutations',
  'mail_identity_operations', 'mail_labels', 'mail_label_state', 'mail_label_mutations',
  'mail_signatures', 'mail_signature_state', 'mail_signature_defaults', 'snoozed_messages'];
const encode = lines => gzipSync(lines.map(JSON.stringify).join('\n') + '\n');
const decode = bytes => gunzipSync(bytes).toString().trim().split('\n').map(JSON.parse);

describe.skipIf(!ADMIN_URL)('durable metadata backup on PostgreSQL', () => {
  const dbName = `mailflow_backup_${randomBytes(5).toString('hex')}`;
  let admin, account, otherAccount, originalEntity, aliasEntity, signature, labelIds;
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '7e'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  const context = async (folder = 'INBOX', epoch = '4294967295', capabilities = ['OBJECTID'], acct = account) =>
    observeMailboxIdentity(await readMailboxIdentity(acct, folder), { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set(capabilities) });
  const write = (ctx, uid = '4294967295', emailId = '900719925474099312345') => writeObservedMessage(ctx, { uid, emailId }, client =>
    client.query(`INSERT INTO messages(account_id,uid,folder,message_id,subject,body_text,provider_msgid)
      VALUES ($1,$2,$3,'<same@test>','Backup payload','Never alter this body',$4)
      ON CONFLICT(account_id,uid,folder) DO UPDATE SET subject=EXCLUDED.subject RETURNING *`, [ctx.accountId, uid, ctx.folderPath, emailId]));
  const backup = async (scope = 'setup') => {
    const client = await h.pool.connect();
    try {
      const out = new PassThrough(), chunks = []; out.on('data', chunk => chunks.push(chunk));
      await writeBackup(client, { scope, appVersion: 'test', out }); return Buffer.concat(chunks);
    } finally { client.release(); }
  };
  const restore = async bytes => {
    const client = await h.pool.connect();
    try { return await restoreBackup(client, Readable.from([bytes])); } finally { client.release(); }
  };
  // JSON text is compared in PostgreSQL, retaining bigint precision and exact timestamps.
  const snapshot = async (tables = durable) => Object.fromEntries(await Promise.all(tables.map(async table =>
    [table, (await h.pool.query(`SELECT row_to_json(t)::text AS value FROM "${table}" t ORDER BY row_to_json(t)::text`)).rows.map(r => r.value)])));
  const count = async table => Number((await h.pool.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);

  beforeEach(async () => {
    await h.pool.query(`TRUNCATE ${[...SETUP_TABLES, ...MAIL_CACHE_TABLES, ...TRANSIENT_TABLES].map(t => `"${t}"`).join(', ')} RESTART IDENTITY`);
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('backup-owner') RETURNING id")).rows[0].id;
    const add = async name => (await h.pool.query('INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,$2,$3) RETURNING *', [owner, name, `${name}@test`])).rows[0];
    account = await add('one'); otherAccount = await add('two');
    const observed = await write(await context()); originalEntity = observed.rows[0].entity_id;
    aliasEntity = (await h.pool.query(`INSERT INTO message_entities(account_id,storage_generation,canonical_entity_id,metadata_version)
      VALUES ($1,$2,$3,9007199254740993) RETURNING id`, [account.id, account.storage_generation, originalEntity])).rows[0].id;
    await h.pool.query(`INSERT INTO snoozed_messages(user_id,account_id,storage_generation,entity_id,message_id_header,original_folder,snooze_until,wake_state)
      VALUES ($1,$2,$3,$4,'<same@test>','INBOX',NOW(),'pending'),
             ($1,$2,$3,NULL,'<same@test>','INBOX',NOW(),'ready')`,
    [owner, account.id, account.storage_generation, originalEntity]);
    // Same provider text in another namespace and generation must survive separately.
    for (const [generation, namespace] of [[account.storage_generation, 'gmail-x-gm-msgid'], [randomUUID(), 'imap-objectid']]) {
      const entity = (await h.pool.query('INSERT INTO message_entities(account_id,storage_generation) VALUES ($1,$2) RETURNING id', [account.id, generation])).rows[0].id;
      await h.pool.query('INSERT INTO entity_provider_keys VALUES ($1,$2,$3,$4,$5,NOW())', [account.id, generation, namespace, '900719925474099312345', entity]);
    }
    for (const state of ['prepared', 'outcome_unknown', 'provider_confirmed', 'unresolved']) {
      await h.pool.query(`INSERT INTO mail_identity_operations(account_id,storage_generation,operation_type,source_entity_id,source_locator,destination_folder,state,evidence)
        VALUES ($1,$2,'move',$3,$4,'Unknown',$5,'{"proof":"pending","opaque":"900719925474099312345"}')`,
      [account.id, account.storage_generation, originalEntity, JSON.stringify({ folder: 'INBOX', uidValidity: '4294967295', uid: '4294967295' }), state]);
    }
    labelIds = []; let parent = null, path = '';
    for (let i = 0; i < 16; i++) {
      path += `${i ? '/' : ''}L${i}`;
      parent = (await h.pool.query(`INSERT INTO mail_labels(account_id,parent_id,name,normalized_name,full_path,color,sidebar_visibility,message_visibility,revision)
        VALUES ($1,$2,$3,$4,$5,'#abcdef','unread',false,9007199254740993) RETURNING id`, [account.id, parent, `L${i}`, `l${i}`, path])).rows[0].id;
      labelIds.push(parent);
    }
    await h.pool.query('UPDATE message_entities SET metadata_version=9007199254740993 WHERE id=$1', [originalEntity]);
    await h.pool.query('INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id) VALUES ($1,$2,$3,$4)', [account.id, account.storage_generation, originalEntity, labelIds[0]]);
    await h.pool.query(`INSERT INTO native_label_mutations(account_id,mutation_id,storage_generation,request_hash,response)
      VALUES ($1,$2,$3,$4,'{"metadataVersion":"9007199254740993"}'),($1,$5,$3,$4,NULL)`, [account.id, randomUUID(), account.storage_generation, 'b'.repeat(64), randomUUID()]);
    await h.pool.query('INSERT INTO mail_label_state VALUES ($1,9007199254740993)', [account.id]);
    await h.pool.query(`INSERT INTO mail_label_mutations(account_id,mutation_id,request_hash,response) VALUES ($1,$2,$3,'{"success":true}')`, [account.id, randomUUID(), 'a'.repeat(64)]);
    const alias = (await h.pool.query("INSERT INTO account_aliases(account_id,name,email) VALUES ($1,'Alias','alias@test') RETURNING id", [account.id])).rows[0].id;
    signature = (await h.pool.query(`INSERT INTO mail_signatures(account_id,name,normalized_name,content) VALUES ($1,'Personal','personal','<p>Signed ✓</p>') RETURNING id`, [account.id])).rows[0].id;
    await h.pool.query(`INSERT INTO mail_signature_state VALUES ($1,9007199254740993,'{"migrated":true}')`, [account.id]);
    await h.pool.query(`INSERT INTO mail_signature_defaults(account_id,sender_key,alias_id,new_signature_id,reply_signature_id)
      VALUES ($1,'main',NULL,$3,$3),($1,$2::uuid::text,$2::uuid,$3,NULL)`, [account.id, alias, signature]);
    await h.pool.query("INSERT INTO auth_events(id,event_type,success) VALUES (9007199254740993,'login',true)");
    await h.pool.query("SELECT setval('folder_status_revision',9007199254740993)");
  });

  it.each(['setup', 'full'])('restores %s metadata, self-FKs, scoped defaults and pending intents with cache guards active', async scope => {
    const before = await snapshot(); const cached = await snapshot(['messages']);
    const lines = decode(await backup(scope));
    expect(lines[0].tables).toEqual(expect.arrayContaining(durable));
    const reversed = lines.flatMap(line => {
      if (line.table === 'mail_labels') return [...line.rows].sort((a, b) => labelIds.indexOf(b.id) - labelIds.indexOf(a.id)).map(row => ({ table: line.table, rows: [row] }));
      if (line.table === 'message_entities') return [...line.rows].sort((a, b) => Number(Boolean(b.canonical_entity_id)) - Number(Boolean(a.canonical_entity_id))).map(row => ({ table: line.table, rows: [row] }));
      return [line];
    });
    await h.pool.query("UPDATE mail_signatures SET content='Later change'");
    await h.pool.query("INSERT INTO sessions VALUES ('revoked-session','{}',NULL,NOW()+interval '1 day')");
    await h.pool.query("INSERT INTO kv_store(key,value) VALUES ('temporary-nonce','discard')");
    await restore(encode(reversed));
    expect(await snapshot()).toEqual(before);
    expect(await count('sessions')).toBe(0); expect(await count('kv_store')).toBe(0);
    expect((await h.pool.query('SELECT storage_generation FROM email_accounts WHERE id=$1', [account.id])).rows[0].storage_generation).toBe(account.storage_generation);
    expect(await count('messages')).toBe(scope === 'full' ? 1 : 0);
    expect(await count('folders')).toBe(scope === 'full' ? 1 : 0);
    if (scope === 'full') expect(await snapshot(['messages'])).toEqual(cached);
    expect((await h.pool.query("SELECT tgenabled FROM pg_trigger WHERE tgname='messages_identity_guard'")).rows[0].tgenabled).toBe('O');
    // Clearing disposable caches cannot cascade into any durable metadata.
    await h.pool.query('TRUNCATE messages, folders');
    expect(await snapshot()).toEqual(before);
    const fetched = await write(await context());
    expect(fetched.rows[0].entity_id).toBe(originalEntity);
    expect(await count('message_entities')).toBe(4);
    await expect(h.pool.query('UPDATE mail_signature_defaults SET account_id=$1', [otherAccount.id])).rejects.toMatchObject({ code: '23503' });
    expect((await h.pool.query("INSERT INTO auth_events(event_type,success) VALUES ('login',true) RETURNING id")).rows[0].id).toBe('9007199254740994');
    expect(BigInt((await h.pool.query("SELECT nextval('folder_status_revision') AS n")).rows[0].n)).toBeGreaterThan(9007199254740993n);
  });

  it.each(['setup', 'full'])('restores %s private Undo preimages and atomically restores the original memberships', async scope => {
    const input = { accountId: account.id, storageGeneration: account.storage_generation, mutationId: randomUUID(),
      targets: [{ entityId: originalEntity, expectedMetadataVersion: '9007199254740993' }], addLabelIds: [], removeLabelIds: [labelIds[0]] };
    await mutateMemberships(account.user_id, input);
    const before = await snapshot(['native_label_mutations']);
    await restore(await backup(scope));
    expect(await snapshot(['native_label_mutations'])).toEqual(before);
    await write(await context());
    const result = await undoMemberships(account.user_id, { accountId: account.id, storageGeneration: account.storage_generation,
      originalMutationId: input.mutationId, mutationId: randomUUID() });
    expect(result.result.targets[0]).toMatchObject({ metadataVersion: '9007199254740995', labelIds: [labelIds[0]] });
    expect(result.result).not.toHaveProperty('undo_state');
  });

  it('never invents provider ownership or continuity from unproved cache fields after setup restore', async () => {
    await restore(await backup());
    const before = await snapshot(['entity_provider_keys']);
    // A cached provider_msgid alone has no negotiated namespace provenance.
    const generic = await write(await context('Generic', '1', []), 1);
    expect(generic.rows[0].entity_id).not.toBe(originalEntity);
    expect(await snapshot(['entity_provider_keys'])).toEqual(before);
    const gmail = await write(await context('Gmail', '2', ['X-GM-EXT-1']), 1);
    expect(gmail.rows[0].entity_id).not.toBe(originalEntity);
    const reset = await write(await context('INBOX', '3', []), 1);
    expect(reset.rows[0].entity_id).not.toBe(originalEntity);
    const stable = await write(await context('INBOX', '4'), 1);
    expect(stable.rows[0].entity_id).toBe(originalEntity);
  });

  it('rejects missing durable tables, account generations and older schemas without losing installed content', async () => {
    const original = decode(await backup()); const before = await snapshot();
    for (const table of durable) {
      const lines = structuredClone(original).filter(line => line.table !== table);
      lines[0].tables = lines[0].tables.filter(t => t !== table); delete lines.at(-1).rowCounts[table];
      await expect(restore(encode(lines))).rejects.toThrow(/missing durable metadata/);
    }
    const missingGeneration = structuredClone(original);
    for (const line of missingGeneration.filter(l => l.table === 'email_accounts')) for (const row of line.rows) delete row.storage_generation;
    await expect(restore(encode(missingGeneration))).rejects.toThrow(/storage generation/);
    const older = structuredClone(original); older[0].schemaVersion = '0078_messages_rfc822_size';
    await expect(restore(encode(older))).rejects.toThrow(/older version.*Restore it on that version/);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['mail_signatures', 'content'],
    ['mail_signatures', 'is_plain_text'],
    ['mail_signature_defaults', 'new_signature_id'],
    ['mail_signature_defaults', 'reply_signature_id'],
    ['mail_signature_state', 'legacy_snapshot'],
    ['mail_identity_operations', 'state'],
    ['mail_identity_operations', 'evidence'],
    ['mail_identity_operations', 'source_locator'],
    ['message_entities', 'metadata_version'],
    ['native_label_mutations', 'response'],
    ['native_label_mutations', 'undo_state'],
    ['native_label_mutations', 'operation_kind'],
    ['native_label_mutations', 'request_hash'],
    ['native_label_memberships', 'entity_id'],
    ['snoozed_messages', 'entity_id'],
    ['snoozed_messages', 'wake_state'],
    ['users', 'preferences'],
  ])('rejects omitted %s.%s fields instead of restoring defaults over saved content', async (table, column) => {
    const lines = decode(await backup()); const before = await snapshot([...durable, 'users']);
    for (const line of lines.filter(line => line.table === table)) for (const row of line.rows) delete row[column];
    await expect(restore(encode(lines))).rejects.toThrow(/missing columns/);
    expect(await snapshot([...durable, 'users'])).toEqual(before);
  });

  it('checks omitted fields on later rows and later batches, not just the first row', async () => {
    const original = decode(await backup()); const before = await snapshot();
    const operationBatch = original.find(line => line.table === 'mail_identity_operations');
    expect(operationBatch.rows.length).toBeGreaterThan(1);
    const mixed = structuredClone(original);
    delete mixed.find(line => line.table === 'mail_identity_operations').rows[1].evidence;
    await expect(restore(encode(mixed))).rejects.toThrow(/malformed rows/);
    const separate = original.flatMap(line => line.table === 'mail_identity_operations'
      ? line.rows.map(row => ({ table: line.table, rows: [row] })) : [line]);
    delete separate.filter(line => line.table === 'mail_identity_operations')[1].rows[0].evidence;
    await expect(restore(encode(separate))).rejects.toThrow(/missing columns/);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps generated columns outside the export/restore row contract', async () => {
    await h.pool.query('ALTER TABLE mail_signatures ADD COLUMN review_content_length integer GENERATED ALWAYS AS (length(content)) STORED');
    try {
      const bytes = await backup();
      const record = decode(bytes).find(line => line.table === 'mail_signatures').rows[0];
      expect(Object.hasOwn(record, 'review_content_length')).toBe(false);
      await restore(bytes);
      const restored = (await h.pool.query('SELECT content,review_content_length FROM mail_signatures WHERE id=$1', [signature])).rows[0];
      expect(restored.review_content_length).toBe(restored.content.length);
    } finally {
      await h.pool.query('ALTER TABLE mail_signatures DROP COLUMN review_content_length');
    }
  });

  it('rolls back a late deferred self-FK failure including sequence restarts', async () => {
    const lines = decode(await backup());
    const invalid = lines.find(line => line.table === 'mail_labels').rows.find(row => row.parent_id);
    invalid.parent_id = randomUUID();
    const before = await snapshot();
    const serialBefore = (await h.pool.query('SELECT last_value,is_called FROM auth_events_id_seq')).rows;
    const sequenceBefore = (await h.pool.query('SELECT last_value,is_called FROM folder_status_revision')).rows;
    await expect(restore(encode(lines))).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
    expect((await h.pool.query('SELECT last_value,is_called FROM auth_events_id_seq')).rows).toEqual(serialBefore);
    expect((await h.pool.query('SELECT last_value,is_called FROM folder_status_revision')).rows).toEqual(sequenceBefore);
  });

  it('refuses cache identities that the real guard cannot prove instead of silently dropping or remapping them', async () => {
    const lines = decode(await backup('full')); const before = await snapshot([...durable, 'messages']);
    const cache = lines.find(line => line.table === 'messages').rows[0];
    cache.uid = '12';
    await expect(restore(encode(lines))).rejects.toThrow(/without a current verified location/);
    expect(await snapshot([...durable, 'messages'])).toEqual(before);
  });

  it('fails closed for unknown FK-dependent tables instead of truncating them through CASCADE', async () => {
    const bytes = await backup();
    await h.pool.query('CREATE TABLE future_user_metadata(account_id uuid REFERENCES email_accounts(id), value text)');
    try {
      await h.pool.query("INSERT INTO future_user_metadata VALUES ($1,'Do not erase')", [account.id]);
      await expect(restore(bytes)).rejects.toThrow(/not classified.*future_user_metadata/);
      expect((await h.pool.query('SELECT value FROM future_user_metadata')).rows).toEqual([{ value: 'Do not erase' }]);
    } finally { await h.pool.query('DROP TABLE future_user_metadata'); }
  });

  it('refuses a new FK dependency appearing after preflight without cascading into its data', async () => {
    const bytes = await backup(); const before = await snapshot();
    const client = await h.pool.connect();
    try {
      await expect(restoreBackup(client, Readable.from([bytes]), { beforeWrite: async () => {
        await h.pool.query('CREATE TABLE future_user_metadata(account_id uuid REFERENCES email_accounts(id), value text)');
        await h.pool.query("INSERT INTO future_user_metadata VALUES ($1,'Created after preflight')", [account.id]);
      } })).rejects.toMatchObject({ code: '0A000' });
      expect((await h.pool.query('SELECT value FROM future_user_metadata')).rows).toEqual([{ value: 'Created after preflight' }]);
      expect(await snapshot()).toEqual(before);
    } finally { client.release(); await h.pool.query('DROP TABLE IF EXISTS future_user_metadata'); }
  });

  it('holds restore locks until the complete file commits, then permits an identity writer to rebind safely', async () => {
    const lines = decode(await backup());
    const client = await h.pool.connect(); const writer = await h.pool.connect();
    const input = new PassThrough(); let locked;
    const reached = new Promise(resolve => { locked = resolve; });
    const restorePending = restoreBackup(client, input, { onProgress: () => locked() });
    // A flush makes all rows visible to the decoder while withholding the final gzip trailer.
    const { createGzip, constants } = await import('zlib');
    const compressor = createGzip(); compressor.pipe(input);
    compressor.write(lines.slice(0, -1).map(JSON.stringify).join('\n') + '\n');
    compressor.flush(constants.Z_SYNC_FLUSH);
    let pendingWrite;
    try {
      await reached;
      pendingWrite = writer.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1 RETURNING metadata_version', [aliasEntity]);
      // Observe the actual lock wait rather than assuming a timeout means serialization.
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        waiting = (await h.pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [writer.processID])).rows[0]?.wait_event_type === 'Lock';
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      compressor.end(JSON.stringify(lines.at(-1)) + '\n');
      await restorePending;
      expect((await pendingWrite).rows[0].metadata_version).toBe('9007199254740994');
      const [a, b] = await Promise.all([write(await context()), write(await context())]);
      expect(a.rows[0].entity_id).toBe(originalEntity); expect(b.rows[0].entity_id).toBe(originalEntity);
    } finally {
      compressor.destroy(); input.destroy();
      await restorePending.catch(() => {}); await pendingWrite?.catch(() => {});
      client.release(); writer.release();
    }
  }, 15_000);
});
