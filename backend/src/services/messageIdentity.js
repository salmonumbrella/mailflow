import { LIVE_SNOOZE_SQL } from './snoozeIdentity.js';
import { randomUUID } from 'crypto';
import { query, withTransaction } from './db.js';

const UINT32_MAX = 4294967295n;
const NAMESPACES = new Set(['imap-objectid', 'gmail-x-gm-msgid']);
const identityError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

export function protocolNumber(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  const number = BigInt(value);
  return number > 0n && number <= UINT32_MAX ? String(number) : null;
}

export function providerIdentityNamespace(client) {
  if (client?.capabilities?.has('OBJECTID')) return 'imap-objectid';
  if (client?.capabilities?.has('X-GM-EXT-1')) return 'gmail-x-gm-msgid';
  return null;
}

function providerKey(context, message) {
  const id = message?.emailId;
  return NAMESPACES.has(context.providerNamespace) && typeof id === 'string'
    && id.length > 0 && id.length <= 1024 && ![...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ? { namespace: context.providerNamespace, id } : null;
}

async function lockAccount(client, accountId, generation) {
  const { rows: [account] } = await client.query('SELECT id, storage_generation FROM email_accounts WHERE id=$1 FOR UPDATE', [accountId]);
  if (!account) throw identityError('identity_account_missing', 'Account no longer exists', 404);
  if (generation && generation !== account.storage_generation) {
    throw identityError('storage_generation_conflict', 'The mailbox account changed. Refresh and try again.');
  }
  return account;
}

async function epochRow(client, context) {
  return (await client.query(`SELECT uid_validity, revision, provider_mailbox_id FROM mailbox_identity_epochs
    WHERE account_id=$1 AND storage_generation=$2 AND folder_path=$3`,
  [context.accountId, context.storageGeneration, context.folderPath])).rows[0];
}

export async function readMailboxIdentity(account, folderPath) {
  if (!account?.id || typeof folderPath !== 'string' || !folderPath.length || folderPath.length > 500) {
    throw identityError('invalid_identity_locator', 'Invalid mailbox identity scope', 400);
  }
  return withTransaction(async client => {
    const current = await lockAccount(client, account.id, account.storage_generation);
    const context = { accountId: account.id, storageGeneration: current.storage_generation, folderPath };
    const epoch = await epochRow(client, context);
    const cached = (await client.query('SELECT uid_validity FROM folders WHERE account_id=$1 AND path=$2', [account.id, folderPath])).rows[0];
    return { ...context, revision: epoch?.revision ?? '0', uidValidity: epoch?.uid_validity ?? null, cachedUidValidity: cached?.uid_validity ?? null };
  });
}

function selectedEpoch(context, imapClient) {
  if (imapClient?.mailflowStorageGeneration && imapClient.mailflowStorageGeneration !== context.storageGeneration) {
    throw identityError('storage_generation_conflict', 'The IMAP session belongs to an earlier mailbox account');
  }
  const mailbox = imapClient?.mailbox;
  if (mailbox?.path && mailbox.path !== context.folderPath) {
    throw identityError('identity_mailbox_changed', 'Selected mailbox changed during identity observation');
  }
  const uidValidity = protocolNumber(mailbox?.uidValidity);
  if (!uidValidity) throw identityError('identity_epoch_unknown', 'The server did not supply a valid mailbox UIDVALIDITY');
  return uidValidity;
}

export async function observeMailboxIdentity(snapshot, imapClient) {
  const uidValidity = selectedEpoch(snapshot, imapClient);
  const providerNamespace = providerIdentityNamespace(imapClient);
  const providerMailboxId = providerNamespace === 'imap-objectid' && typeof imapClient.mailbox?.mailboxId === 'string'
    ? imapClient.mailbox.mailboxId : null;
  return withTransaction(async client => {
    await lockAccount(client, snapshot.accountId, snapshot.storageGeneration);
    const old = await epochRow(client, snapshot);
    if (String(old?.revision ?? '0') !== String(snapshot.revision)) {
      throw identityError('identity_epoch_changed', 'Mailbox epoch changed while selecting it');
    }
    const previousValidity = old?.uid_validity ?? snapshot.cachedUidValidity;
    const epochChanged = Boolean(previousValidity && String(previousValidity) !== uidValidity);
    let purgedCount = 0;
    if (epochChanged) {
      await client.query(`UPDATE entity_locations SET status='invalidated'
        WHERE account_id=$1 AND storage_generation=$2 AND folder_path=$3 AND uid_validity<>$4`,
      [snapshot.accountId, snapshot.storageGeneration, snapshot.folderPath, uidValidity]);
      const purged = await client.query('DELETE FROM messages WHERE account_id=$1 AND folder=$2', [snapshot.accountId, snapshot.folderPath]);
      purgedCount = purged.rowCount;
      await client.query('UPDATE folders SET highest_modseq=NULL WHERE account_id=$1 AND path=$2', [snapshot.accountId, snapshot.folderPath]);
    }
    const { rows: [epoch] } = await client.query(`INSERT INTO mailbox_identity_epochs
      (account_id,storage_generation,folder_path,uid_validity,provider_mailbox_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,storage_generation,folder_path) DO UPDATE SET
      revision=CASE WHEN mailbox_identity_epochs.uid_validity<>EXCLUDED.uid_validity THEN mailbox_identity_epochs.revision+1 ELSE mailbox_identity_epochs.revision END,
      uid_validity=EXCLUDED.uid_validity, provider_mailbox_id=EXCLUDED.provider_mailbox_id, observed_at=NOW()
      RETURNING uid_validity,revision`, [snapshot.accountId, snapshot.storageGeneration, snapshot.folderPath, uidValidity, providerMailboxId]);
    await client.query(`INSERT INTO folders(account_id,path,name,uid_validity) VALUES ($1,$2,$2,$3)
      ON CONFLICT(account_id,path) DO UPDATE SET uid_validity=EXCLUDED.uid_validity`, [snapshot.accountId, snapshot.folderPath, uidValidity]);
    return { ...snapshot, uidValidity: epoch.uid_validity, revision: epoch.revision, providerNamespace, providerMailboxId, epochChanged, purgedCount };
  });
}

async function assertContext(client, context) {
  await lockAccount(client, context.accountId, context.storageGeneration);
  const epoch = await epochRow(client, context);
  if (!epoch || String(epoch.revision) !== String(context.revision) || epoch.uid_validity !== protocolNumber(context.uidValidity)) {
    throw identityError('identity_epoch_changed', 'Mailbox epoch changed during the operation');
  }
  return epoch;
}

export async function withMailboxIdentity(context, write) {
  return withTransaction(async client => {
    await assertContext(client, context);
    return write(client);
  });
}

export async function withAccountIdentity(account, write) {
  const accountId = account.id, generation = account.storage_generation;
  return withTransaction(async client => {
    await lockAccount(client, accountId, generation);
    return write(client);
  });
}

export async function assertMailboxIdentity(context, imapClient) {
  if (selectedEpoch(context, imapClient) !== context.uidValidity) {
    throw identityError('identity_epoch_changed', 'The server mailbox epoch changed during the operation');
  }
  return withTransaction(client => assertContext(client, context));
}
export const validateMailboxIdentity = assertMailboxIdentity;

const locatorOf = (context, uid) => ({ folder: context.folderPath, uidValidity: context.uidValidity, uid });
const scope = context => [context.accountId, context.storageGeneration];

// Caller holds the account row lock and has checked user ownership. Historical IDs remain
// usable after a proved provisional merge, but never cross account/storage boundaries.
export async function resolveCanonicalEntity(client, { accountId, storageGeneration }, entityId) {
  const seen = new Set();
  let current = entityId;
  while (current && seen.size < 32) {
    if (seen.has(current)) throw identityError('identity_alias_conflict', 'Message identity alias cycle requires recovery');
    seen.add(current);
    const entity = (await client.query(`SELECT id,canonical_entity_id FROM message_entities
      WHERE account_id=$1 AND storage_generation=$2 AND id=$3`, [accountId, storageGeneration, current])).rows[0];
    if (!entity) throw identityError('identity_entity_missing', 'Message identity not found in this account', 404);
    if (!entity.canonical_entity_id) return entity.id;
    current = entity.canonical_entity_id;
  }
  throw identityError('identity_alias_conflict', 'Message identity alias chain requires recovery');
}

async function newEntity(client, context) {
  return (await client.query(`INSERT INTO message_entities(account_id,storage_generation) VALUES ($1,$2) RETURNING id`, scope(context))).rows[0].id;
}

async function locationAt(client, context, uid) {
  return (await client.query(`SELECT entity_id,status FROM entity_locations
    WHERE account_id=$1 AND storage_generation=$2 AND folder_path=$3 AND uid_validity=$4 AND uid=$5`,
  [...scope(context), context.folderPath, context.uidValidity, uid])).rows[0];
}

async function putLocation(client, context, uid, entityId) {
  await client.query(`INSERT INTO entity_locations(account_id,storage_generation,folder_path,uid_validity,uid,entity_id,provider_mailbox_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id,storage_generation,folder_path,uid_validity,uid)
    DO UPDATE SET status='present',last_seen_at=NOW(),provider_mailbox_id=COALESCE(EXCLUDED.provider_mailbox_id,entity_locations.provider_mailbox_id)`,
  [...scope(context), context.folderPath, context.uidValidity, uid, entityId, context.providerMailboxId ?? null]);
}

async function recordConflict(client, context, uid, entityId, evidence) {
  await client.query(`INSERT INTO mail_identity_operations(account_id,storage_generation,operation_type,source_entity_id,source_locator,
    destination_folder,destination_revision,state,evidence) VALUES ($1,$2,'reconcile',$3,$4::jsonb,$5,$6,'unresolved',$7::jsonb)`,
  [...scope(context), entityId, JSON.stringify(locatorOf(context, uid)), context.folderPath, context.revision, JSON.stringify(evidence)]);
}

async function resolveObserved(client, context, uid, key) {
  let location = await locationAt(client, context, uid);
  const keyed = key ? (await client.query(`SELECT entity_id FROM entity_provider_keys
    WHERE account_id=$1 AND storage_generation=$2 AND namespace=$3 AND provider_id=$4`,
  [...scope(context), key.namespace, key.id])).rows[0] : null;
  // An exact COPYUID journal plus a fresh stable provider key proves that a provider
  // represents this copy as another location of its source, rather than independent mail.
  if (location && keyed && location.entity_id !== keyed.entity_id) {
    const copy = (await client.query(`SELECT id FROM mail_identity_operations WHERE account_id=$1 AND storage_generation=$2
      AND operation_type IN ('copy','move','append') AND state='bound' AND destination_entity_id=$3
      AND destination_folder=$4 AND destination_locator->>'uidValidity'=$5 AND destination_locator->>'uid'=$6 LIMIT 1`,
    [...scope(context), location.entity_id, context.folderPath, context.uidValidity, uid])).rows[0];
    if (copy && await mergeProvisional(client, context, location.entity_id, keyed.entity_id)) {
      await client.query('UPDATE mail_identity_operations SET destination_entity_id=$2,updated_at=NOW() WHERE id=$1', [copy.id, keyed.entity_id]);
      location = { ...location, entity_id: keyed.entity_id };
    }
  }
  let conflict = location && keyed && location.entity_id !== keyed.entity_id;
  if (location && key && !conflict) {
    const oldKey = (await client.query(`SELECT provider_id FROM entity_provider_keys
      WHERE account_id=$1 AND storage_generation=$2 AND entity_id=$3 AND namespace=$4`,
    [...scope(context), location.entity_id, key.namespace])).rows;
    conflict = oldKey.some(row => row.provider_id !== key.id);
  }
  if (conflict) {
    await recordConflict(client, context, uid, location.entity_id, { reason: 'provider_locator_conflict', namespace: key.namespace, providerId: key.id, keyedEntityId: keyed?.entity_id ?? null });
    return { conflict: true };
  }
  const entityId = location?.entity_id ?? keyed?.entity_id ?? await newEntity(client, context);
  if (key) await client.query(`INSERT INTO entity_provider_keys(account_id,storage_generation,namespace,provider_id,entity_id)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,storage_generation,namespace,provider_id) DO UPDATE SET verified_at=NOW()`,
  [...scope(context), key.namespace, key.id, entityId]);
  await putLocation(client, context, uid, entityId);
  return { entityId };
}

export async function writeObservedMessage(context, message, write) {
  const uid = protocolNumber(message?.uid);
  if (!uid) throw identityError('invalid_identity_uid', 'Invalid message UID', 400);
  const result = await withTransaction(async client => {
    await assertContext(client, context);
    const resolved = await resolveObserved(client, context, uid, providerKey(context, message));
    if (resolved.conflict) return resolved;
    // Historical cache rows lack a captured epoch. Their bodies cannot be certified by a new envelope.
    await client.query(`DELETE FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3
      AND (entity_id IS NULL OR storage_generation IS DISTINCT FROM $4::uuid OR uid_validity IS DISTINCT FROM $5::bigint)`,
    [context.accountId, context.folderPath, uid, context.storageGeneration, context.uidValidity]);
    const saved = await write(client);
    const bound = await client.query(`UPDATE messages SET entity_id=$4,storage_generation=$5,uid_validity=$6
      WHERE account_id=$1 AND folder=$2 AND uid=$3 RETURNING id,entity_id,storage_generation,uid_validity,
        (SELECT e.metadata_version::text FROM message_entities e WHERE e.id=messages.entity_id
          AND e.account_id=messages.account_id AND e.storage_generation=messages.storage_generation
          AND e.canonical_entity_id IS NULL) AS metadata_version`,
    [context.accountId, context.folderPath, uid, resolved.entityId, context.storageGeneration, context.uidValidity]);
    if (saved?.rows) for (const row of saved.rows) Object.assign(row, bound.rows.find(candidate => candidate.id === row.id) || {});
    return saved;
  });
  if (result?.conflict) throw identityError('identity_provider_conflict', 'Provider identity contradicts the existing message location; metadata was retained for recovery');
  return result;
}

export async function writeUnverifiedMessage(account, folder, uid, write) {
  return withTransaction(async client => {
    await lockAccount(client, account.id, account.storage_generation);
    const existing = (await client.query('SELECT entity_id FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3 FOR UPDATE', [account.id, folder, uid])).rows[0];
    // A late APPEND/Sent callback cannot overwrite a newer, verified delivery reusing the UID.
    if (existing?.entity_id) return { rows: [], rowCount: 0, identityUnverified: true };
    return write(client);
  });
}

// Capture before asynchronous queue waits. A UID-only action cannot adopt a later cache row.
export async function captureMessageSource(account, folder, uid, suppliedSource) {
  const expected = suppliedSource ? { ...suppliedSource } : null;
  const context = await readMailboxIdentity(account, folder);
  const source = expected ?? await withMailboxIdentity(context, async client =>
    (await client.query('SELECT id,account_id,entity_id,storage_generation,uid_validity,folder,uid FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3',
      [account.id,folder,uid])).rows[0]);
  if (!source || protocolNumber(source.uid) !== protocolNumber(uid)) {
    throw identityError('identity_source_changed','The flag target no longer has its captured location');
  }
  await assertExpectedSource(context, source);
  return { context, expectedSource: source };
}

function expectedSourceMap(uids, expectedSources) {
  const normalized=[...new Set(uids.map(protocolNumber))];
  if (normalized.includes(null) || !Array.isArray(expectedSources) || expectedSources.length !== normalized.length)
    throw identityError('identity_source_changed','Every batch UID requires its original verified source');
  const sources=new Map(expectedSources.map(row=>[protocolNumber(row?.uid),row]));
  if (sources.size !== normalized.length || normalized.some(uid=>!sources.has(uid)))
    throw identityError('identity_source_changed','Batch source snapshots do not match the requested UIDs');
  return sources;
}

async function assertExpectedSourcesLocked(client,context,uids,expectedSources) {
  const sources=expectedSourceMap(uids,expectedSources);
  for (const [uid,source] of sources) {
    const row=(await client.query(`SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3`,
      [context.accountId,context.folderPath,uid])).rows[0];
    const location=await locationAt(client,context,uid);
    if (!source.id || source.account_id !== context.accountId || !source.entity_id ||
      source.storage_generation !== context.storageGeneration || protocolNumber(source.uid_validity) !== context.uidValidity ||
      source.folder !== context.folderPath || row?.id !== source.id || row?.entity_id !== source.entity_id ||
      row?.storage_generation !== context.storageGeneration || row?.uid_validity !== context.uidValidity ||
      location?.status !== 'present' || location?.entity_id !== source.entity_id)
      throw identityError('identity_source_changed','A batch source no longer has its captured verified location');
  }
  return sources;
}

export async function assertExpectedSources(context,uids,expectedSources) {
  return withMailboxIdentity(context,tx=>assertExpectedSourcesLocked(tx,context,uids,expectedSources));
}

export async function captureMessageSources(account,folder,uids,suppliedSources) {
  if (suppliedSources !== undefined && !Array.isArray(suppliedSources)) throw identityError('identity_source_changed','Batch source snapshots must be an array');
  const expected=suppliedSources === undefined ? null : suppliedSources.map(row=>({...row}));
  const requested=[...uids];
  const context=await readMailboxIdentity({...account},folder);
  return withMailboxIdentity(context,async tx=>{
    const sources=expected ?? (await tx.query('SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND uid=ANY($3::bigint[])',
      [context.accountId,folder,requested])).rows;
    await assertExpectedSourcesLocked(tx,context,requested,sources);
    return {context,expectedSources:sources.map(row=>({...row}))};
  });
}

// For delayed callers that already captured a verified cache row. No header-based fallback.
export async function assertExpectedSource(context, expectedSource) {
  return withMailboxIdentity(context, async client => {
    const row = (await client.query(`SELECT id,entity_id,storage_generation,uid_validity,folder,uid FROM messages
      WHERE account_id=$1 AND id=$2`,[context.accountId,expectedSource.id])).rows[0];
    const location = await locationAt(client, context, protocolNumber(expectedSource.uid));
    if (location?.status !== 'present' || location?.entity_id !== expectedSource.entity_id || !row || !expectedSource.entity_id || !expectedSource.uid_validity ||
      expectedSource.storage_generation !== context.storageGeneration || String(expectedSource.uid_validity) !== context.uidValidity ||
      expectedSource.folder !== context.folderPath || row.folder !== context.folderPath ||
      String(row.uid) !== String(expectedSource.uid) || row.entity_id !== expectedSource.entity_id ||
      row.storage_generation !== context.storageGeneration || row.uid_validity !== context.uidValidity) {
      throw identityError('identity_source_changed','The queued message no longer has its captured verified location');
    }
    return row;
  });
}

export async function prepareIdentityOperations(context, destinationFolder, uids, type = 'move', { expectedSource, expectedSources } = {}) {
  if (expectedSources !== undefined && !Array.isArray(expectedSources)) throw identityError('identity_source_changed','Batch source snapshots must be an array');
  const capturedSources=expectedSources === undefined ? undefined : expectedSources.map(row=>({...row}));
  expectedSource=expectedSource ? {...expectedSource} : undefined;
  if (!['move', 'copy'].includes(type) || !destinationFolder || destinationFolder.length > 500) throw identityError('invalid_identity_operation', 'Invalid identity operation', 400);
  const normalized = [...new Set(uids.map(protocolNumber))];
  if (normalized.includes(null)) throw identityError('invalid_identity_uid', 'Invalid source UID', 400);
  return withTransaction(async client => {
    await assertContext(client, context);
    const batch = capturedSources ? await assertExpectedSourcesLocked(client,context,normalized,capturedSources) : null;
    const destination = await epochRow(client, { ...context, folderPath: destinationFolder });
    const operations = [];
    for (const uid of normalized) {
      const source = batch?.get(uid) ?? expectedSource;
      const location = await locationAt(client, context, uid);
      const cached = (await client.query('SELECT id,entity_id,storage_generation,uid_validity FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3', [context.accountId, context.folderPath, uid])).rows[0];
      if (source && (!source.entity_id || !source.uid_validity ||
        source.storage_generation !== context.storageGeneration || String(source.uid_validity) !== context.uidValidity ||
        source.folder !== context.folderPath || String(source.uid) !== uid ||
        cached?.id !== source.id || cached?.entity_id !== source.entity_id ||
        cached?.storage_generation !== context.storageGeneration || cached?.uid_validity !== context.uidValidity)) {
        throw identityError('identity_source_changed', 'The queued message no longer has its captured verified location');
      }
      if ((location && location.status !== 'present') || (cached?.entity_id &&
        (cached.storage_generation !== context.storageGeneration || cached.uid_validity !== context.uidValidity || cached.entity_id !== location?.entity_id))) {
        throw identityError('identity_source_changed', 'The source message location changed; refresh before moving it');
      }
      const { rows: [operation] } = await client.query(`INSERT INTO mail_identity_operations
        (account_id,storage_generation,operation_type,source_entity_id,source_locator,destination_folder,destination_revision)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
      [...scope(context), type, location?.entity_id ?? null, JSON.stringify(locatorOf(context, uid)), destinationFolder, destination?.revision ?? '0']);
      operations.push(operation);
    }
    return operations;
  });
}

export async function prepareAppendIdentityOperation(snapshot, destinationFolder = snapshot.folderPath) {
  return withTransaction(async client => {
    await lockAccount(client, snapshot.accountId, snapshot.storageGeneration);
    const destination = await epochRow(client, { ...snapshot, folderPath: destinationFolder });
    if (String(destination?.revision ?? '0') !== String(snapshot.revision)) throw identityError('identity_epoch_changed', 'Mailbox changed before APPEND');
    return (await client.query(`INSERT INTO mail_identity_operations(account_id,storage_generation,operation_type,destination_folder,destination_revision)
      VALUES ($1,$2,'append',$3,$4) RETURNING *`, [...scope(snapshot), destinationFolder, destination?.revision ?? '0'])).rows[0];
  });
}

async function mergeProvisional(client, context, fromId, toId) {
  if (fromId === toId) return true;
  const { rows: [from] } = await client.query(`SELECT metadata_version,canonical_entity_id FROM message_entities
    WHERE account_id=$1 AND storage_generation=$2 AND id=$3 FOR UPDATE`, [...scope(context), fromId]);
  if (!from || from.metadata_version !== '0' || from.canonical_entity_id) return false;
  const incompatible = (await client.query(`SELECT 1 FROM entity_provider_keys a JOIN entity_provider_keys b
    ON a.account_id=b.account_id AND a.storage_generation=b.storage_generation AND a.namespace=b.namespace AND a.provider_id<>b.provider_id
    WHERE a.account_id=$1 AND a.storage_generation=$2 AND a.entity_id=$3 AND b.entity_id=$4 LIMIT 1`, [...scope(context), fromId, toId])).rows.length;
  if (incompatible) return false;
  await client.query('UPDATE entity_locations SET entity_id=$4 WHERE account_id=$1 AND storage_generation=$2 AND entity_id=$3', [...scope(context), fromId, toId]);
  await client.query('UPDATE entity_provider_keys SET entity_id=$4 WHERE account_id=$1 AND storage_generation=$2 AND entity_id=$3', [...scope(context), fromId, toId]);
  await client.query(`UPDATE messages m SET entity_id=CASE WHEN EXISTS (
    SELECT 1 FROM entity_locations l JOIN mailbox_identity_epochs e USING(account_id,storage_generation,folder_path,uid_validity)
    WHERE l.account_id=m.account_id AND l.storage_generation=m.storage_generation AND l.folder_path=m.folder
      AND l.uid=m.uid AND l.uid_validity=m.uid_validity AND l.entity_id=$4 AND l.status='present'
    ) THEN $4::uuid ELSE NULL END
    WHERE m.account_id=$1 AND m.storage_generation=$2 AND m.entity_id=$3`, [...scope(context), fromId, toId]);
  await client.query(`UPDATE mail_identity_operations SET source_entity_id=$4
    WHERE account_id=$1 AND storage_generation=$2 AND source_entity_id=$3`, [...scope(context), fromId, toId]);
  await client.query(`UPDATE mail_identity_operations SET destination_entity_id=$4
    WHERE account_id=$1 AND storage_generation=$2 AND destination_entity_id=$3`, [...scope(context), fromId, toId]);
  await client.query(`UPDATE message_entities SET canonical_entity_id=$4,updated_at=NOW()
    WHERE account_id=$1 AND storage_generation=$2 AND (id=$3 OR canonical_entity_id=$3)`, [...scope(context), fromId, toId]);
  return true;
}

async function setOperationState(client, id, state, evidence = {}) {
  return (await client.query(`UPDATE mail_identity_operations SET state=$2,evidence=evidence || $3::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,
  [id, state, JSON.stringify(evidence)])).rows[0];
}

export async function completeIdentityOperations(operations, result, { outcome = 'confirmed' } = {}) {
  if (!['confirmed', 'unknown', 'failed'].includes(outcome)) throw identityError('invalid_identity_operation', 'Invalid operation outcome', 400);
  const completed = [];
  for (const prepared of operations) {
    completed.push(await withTransaction(async client => {
      // The account lock serializes sync-first and command-response-first binding, not the network call.
      const { rows: [account] } = await client.query('SELECT storage_generation FROM email_accounts WHERE id=$1 FOR UPDATE', [prepared.account_id]);
      if (!account) return { ...prepared, state: 'unresolved' };
      const { rows: [operation] } = await client.query('SELECT * FROM mail_identity_operations WHERE id=$1 FOR UPDATE', [prepared.id]);
      if (!operation) throw identityError('identity_operation_missing', 'Identity operation no longer exists');
      if (operation.state === 'bound') {
        const priorContext = { accountId: operation.account_id, storageGeneration: operation.storage_generation,
          folderPath: operation.destination_folder, uidValidity: operation.destination_locator?.uidValidity,
          providerNamespace: null, providerMailboxId: null };
        const currentEpoch = await epochRow(client, priorContext);
        return { ...operation, entityId: operation.destination_entity_id,
          destinationContext: account.storage_generation === operation.storage_generation && currentEpoch?.uid_validity === priorContext.uidValidity
            ? { ...priorContext, revision: currentEpoch.revision } : null };
      }
      if (['failed', 'unresolved'].includes(operation.state)) return operation;
      if (outcome !== 'confirmed') return setOperationState(client, operation.id, outcome === 'unknown' ? 'outcome_unknown' : 'failed', { outcome });
      if (result?.sourceRetained === true && operation.operation_type === 'move') {
        operation.operation_type = 'copy';
        await client.query(`UPDATE mail_identity_operations SET operation_type='copy',evidence=evidence || '{"sourceRetained":true}'::jsonb WHERE id=$1`, [operation.id]);
      }
      const source = operation.source_locator;
      const mapped = operation.operation_type === 'append' ? result?.uid
        : result?.uidMap?.get?.(Number(source?.uid)) ?? result?.uidMap?.get?.(String(source?.uid));
      const uid = protocolNumber(mapped), uidValidity = protocolNumber(result?.uidValidity);
      if (account.storage_generation !== operation.storage_generation || !uid || !uidValidity) {
        return setOperationState(client, operation.id, 'unresolved', { reason: account.storage_generation !== operation.storage_generation ? 'account_replaced' : 'confirmed_without_exact_mapping', providerConfirmed: true });
      }
      const context = { accountId: operation.account_id, storageGeneration: operation.storage_generation, folderPath: operation.destination_folder,
        uidValidity, providerNamespace: null, providerMailboxId: null };
      const epoch = await epochRow(client, context);
      // A destination sync can establish the very epoch returned by COPYUID while the command is in flight.
      if (epoch && epoch.uid_validity !== uidValidity || (!epoch && operation.destination_revision !== '0')) {
        return setOperationState(client, operation.id, 'unresolved', { reason: 'destination_epoch_changed', providerConfirmed: true, uid, uidValidity });
      }
      if (!epoch) {
        context.revision = (await client.query(`INSERT INTO mailbox_identity_epochs(account_id,storage_generation,folder_path,uid_validity)
          VALUES ($1,$2,$3,$4) RETURNING revision`, [...scope(context), context.folderPath, uidValidity])).rows[0].revision;
      } else context.revision = epoch.revision;
      let sourceId = operation.source_entity_id ? await resolveCanonicalEntity(client, context, operation.source_entity_id) : null;
      if (source && !sourceId) {
        // COPYUID proves the source UID existed in the selected epoch, but does not certify old cache content.
        const sourceContext = { ...context, folderPath: source.folder, uidValidity: source.uidValidity };
        sourceId = (await locationAt(client, sourceContext, source.uid))?.entity_id ?? await newEntity(client, sourceContext);
        await putLocation(client, sourceContext, source.uid, sourceId);
        await client.query('UPDATE mail_identity_operations SET source_entity_id=$2 WHERE id=$1', [operation.id, sourceId]);
      }
      const destination = await locationAt(client, context, uid);
      let entityId = operation.operation_type === 'move' ? sourceId : destination?.entity_id;
      entityId ||= await newEntity(client, context);
      if (destination && destination.entity_id !== entityId && !await mergeProvisional(client, context, destination.entity_id, entityId)) {
        return setOperationState(client, operation.id, 'unresolved', { reason: 'destination_identity_conflict', providerConfirmed: true, uid, uidValidity });
      }
      await putLocation(client, context, uid, entityId);
      if (operation.operation_type === 'move' && source) await client.query(`UPDATE entity_locations SET status='missing'
        WHERE account_id=$1 AND storage_generation=$2 AND folder_path=$3 AND uid_validity=$4 AND uid=$5`,
      [...scope(context), source.folder, source.uidValidity, source.uid]);
      await client.query(`UPDATE mail_identity_operations SET destination_entity_id=$2,destination_locator=$3::jsonb,state='bound',
        evidence=evidence || '{"proof":"uidplus"}'::jsonb,updated_at=NOW() WHERE id=$1`,
      [operation.id, entityId, JSON.stringify(locatorOf(context, uid))]);
      // If destination sync won, its cache UUID remains, but its provisional entity is now an alias.
      await client.query(`UPDATE messages SET entity_id=$4,storage_generation=$5,uid_validity=$6
        WHERE account_id=$1 AND folder=$2 AND uid=$3 AND storage_generation=$5 AND uid_validity=$6`,
      [context.accountId, context.folderPath, uid, entityId, context.storageGeneration, uidValidity]);
      return { ...operation, state: 'bound', source_entity_id: sourceId, destination_entity_id: entityId,
        destination_locator: locatorOf(context, uid), entityId, destinationContext: context };
    }));
  }
  return completed;
}

export async function applyStorageIdentityDecision(client, { accountId, expectedGeneration, decision }) {
  if (!['preserve', 'replace'].includes(decision)) throw identityError('invalid_storage_identity_decision', 'Choose whether this is the same mailbox or a replacement', 400);
  if (!expectedGeneration) throw identityError('storage_generation_conflict', 'Refresh the account before changing its mailbox');
  const account = await lockAccount(client, accountId, expectedGeneration);
  if (decision === 'preserve') return { storageGeneration: account.storage_generation, replaced: false };
  const pending = await client.query(`SELECT 1 FROM scheduled_messages WHERE account_id=$1
    AND status IN ('scheduled','editing','sending','paused','failed','uncertain') LIMIT 1`, [accountId]);
  if (pending.rows.length) throw identityError('storage_identity_pending_sends', 'Cancel or resolve pending scheduled mail before replacing this mailbox');
  const rules = await client.query('SELECT 1 FROM inbox_rules WHERE account_id=$1 AND enabled LIMIT 1', [accountId]);
  if (rules.rows.length) throw identityError('storage_identity_enabled_rules', 'Disable account-specific rules before replacing this mailbox');
  const generation = randomUUID();
  await client.query('UPDATE email_accounts SET storage_generation=$2 WHERE id=$1', [accountId, generation]);
  await client.query("UPDATE entity_locations SET status='invalidated' WHERE account_id=$1 AND storage_generation=$2", [accountId, account.storage_generation]);
  await client.query(`UPDATE mail_identity_operations SET state='unresolved',evidence=evidence || '{"reason":"account_replaced"}'::jsonb,updated_at=NOW()
    WHERE account_id=$1 AND storage_generation=$2 AND state IN ('prepared','outcome_unknown','provider_confirmed')`, [accountId, account.storage_generation]);
  await client.query('DELETE FROM messages WHERE account_id=$1', [accountId]);
  await client.query('DELETE FROM unfetchable_uids WHERE account_id=$1', [accountId]);
  await client.query('DELETE FROM folders WHERE account_id=$1', [accountId]);
  return { storageGeneration: generation, replaced: true };
}

export async function getIdentityStatus(accountId) {
  const { rows: [row] } = await query(`SELECT a.storage_generation,
    (SELECT count(DISTINCT m.entity_id) FROM messages m WHERE m.account_id=a.id AND m.storage_generation=a.storage_generation AND m.entity_id IS NOT NULL) AS bound,
    (SELECT count(*) FROM message_entities e WHERE e.account_id=a.id AND e.storage_generation=a.storage_generation AND e.canonical_entity_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id=e.account_id AND m.storage_generation=e.storage_generation AND m.entity_id=e.id)) AS unresolved,
    (SELECT count(*) FROM mail_identity_operations o WHERE o.account_id=a.id AND o.state IN ('prepared','outcome_unknown','provider_confirmed','unresolved')) AS pending,
    (SELECT count(*) FROM messages m WHERE m.account_id=a.id AND m.entity_id IS NULL) AS unverified,
    (SELECT count(*) FROM message_entities e WHERE e.account_id=a.id AND e.storage_generation<>a.storage_generation AND e.canonical_entity_id IS NULL) AS previous,
    (SELECT count(*) FROM snoozed_messages sm WHERE sm.account_id=a.id AND NOT ${LIVE_SNOOZE_SQL}) AS held_snoozes
    FROM email_accounts a WHERE a.id=$1`, [accountId]);
  if (!row) throw identityError('identity_account_missing', 'Account no longer exists', 404);
  return { storageGeneration: row.storage_generation, boundEntityCount: row.bound, unresolvedEntityCount: row.unresolved,
    unresolvedOperationCount: row.pending, unverifiedCacheRows: row.unverified, priorGenerationEntityCount: row.previous, heldSnoozeCount: row.held_snoozes };
}
