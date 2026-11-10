// Native labels are durable local metadata. No provider commands or cache writes.
import { createHash } from 'crypto';
import { withTransaction } from './db.js';
import { LabelError } from './nativeLabelDefinitions.js';
import { resolveCanonicalEntity } from './messageIdentity.js';

const fail = (status, code, message) => { throw new LabelError(status, code, message); };
const invalid = message => fail(400, 'invalid_membership_request', message);
const uuid = (value, field) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
};
const version = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) invalid('expectedMetadataVersion must be a nonnegative decimal string');
  return value;
};
const object = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Invalid request fields');
};
export function validateMembershipRequest(raw, mutation = false) {
  object(raw, ['accountId', 'storageGeneration', 'targets', ...(mutation ? ['mutationId', 'addLabelIds', 'removeLabelIds'] : [])]);
  const input = { accountId: uuid(raw.accountId, 'accountId'), storageGeneration: uuid(raw.storageGeneration, 'storageGeneration') };
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 200) invalid('Provide between 1 and 200 targets');
  input.targets = raw.targets.map(target => {
    object(target, ['entityId', ...(mutation ? ['expectedMetadataVersion'] : [])]);
    return { entityId: uuid(target.entityId, 'entityId'), ...(mutation ? { expectedMetadataVersion: version(target.expectedMetadataVersion) } : {}) };
  });
  if (new Set(input.targets.map(t => t.entityId)).size !== input.targets.length) invalid('Duplicate targets');
  if (mutation) {
    input.mutationId = uuid(raw.mutationId, 'mutationId');
    for (const key of ['addLabelIds', 'removeLabelIds']) {
      if (!Array.isArray(raw[key]) || raw[key].length > 100) invalid(`${key} must contain at most 100 labels`);
      input[key] = [...new Set(raw[key].map(id => uuid(id, key)))].sort();
    }
    if (!input.addLabelIds.length && !input.removeLabelIds.length) invalid('Provide at least one label decision');
    if (input.addLabelIds.some(id => input.removeLabelIds.includes(id))) invalid('Cannot add and remove the same label');
  }
  return input;
}
async function lockOwnedAccount(client, userId, input) {
  const { rows: [account] } = await client.query('SELECT storage_generation FROM email_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [input.accountId, userId]);
  if (!account) fail(404, 'not_found', 'Account not found');
  return account;
}
function currentGeneration(account, input) {
  if (account.storage_generation !== input.storageGeneration) fail(409, 'stale_generation', 'The mailbox changed. Refresh before assigning labels');
}
async function resolveTargets(client, input, mutation) {
  const targets = [], unique = new Map();
  for (const target of input.targets) {
    let id;
    try { id = await resolveCanonicalEntity(client, input, target.entityId); }
    catch (error) { if (error.status) fail(error.status, error.code, error.message); throw error; }
    let row = unique.get(id);
    if (!row) {
      row = (await client.query(`SELECT e.metadata_version::text,
        EXISTS (SELECT 1 FROM messages m JOIN entity_locations l ON
          l.account_id=m.account_id AND l.storage_generation=m.storage_generation AND l.entity_id=m.entity_id
          AND l.folder_path=m.folder AND l.uid_validity=m.uid_validity AND l.uid=m.uid
          JOIN mailbox_identity_epochs ep ON ep.account_id=l.account_id AND ep.storage_generation=l.storage_generation
            AND ep.folder_path=l.folder_path AND ep.uid_validity=l.uid_validity
          WHERE m.account_id=e.account_id AND m.storage_generation=e.storage_generation AND m.entity_id=e.id
            AND l.status='present' AND NOT m.is_deleted) AS available
        FROM message_entities e WHERE e.account_id=$1 AND e.storage_generation=$2 AND e.id=$3 FOR UPDATE`,
      [input.accountId, input.storageGeneration, id])).rows[0];
      row.entityId = id; unique.set(id, row);
    }
    if (mutation && !row.available) fail(409, 'identity_unavailable', 'This message has no current verified cached location. Refresh before assigning labels');
    if (mutation && target.expectedMetadataVersion !== row.metadata_version) fail(409, 'stale_metadata_version', 'Message metadata changed. Refresh before assigning labels');
    targets.push({ requestedEntityId: target.entityId, entityId: id });
  }
  return { targets, unique };
}
async function resultFor(client, input, resolved) {
  const { rows } = await client.query(`SELECT entity_id,label_id FROM native_label_memberships
    WHERE account_id=$1 AND storage_generation=$2 AND entity_id=ANY($3::uuid[]) ORDER BY label_id`,
  [input.accountId, input.storageGeneration, [...resolved.unique.keys()]]);
  return { accountId: input.accountId, storageGeneration: input.storageGeneration,
    targets: resolved.targets.map(target => ({ ...target,
      metadataVersion: resolved.unique.get(target.entityId).metadata_version,
      available: resolved.unique.get(target.entityId).available,
      labelIds: rows.filter(row => row.entity_id === target.entityId).map(row => row.label_id) })) };
}
export async function queryMemberships(userId, raw) {
  const input = validateMembershipRequest(raw);
  return withTransaction(async client => {
    currentGeneration(await lockOwnedAccount(client, userId, input), input);
    return resultFor(client, input, await resolveTargets(client, input, false));
  });
}
export async function mutateMemberships(userId, raw) {
  const input = validateMembershipRequest(raw, true);
  // Preserve target order because it is part of the exact response contract.
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return applyMembershipMutation(userId, input, hash);
}

// HTTP and internal rule decisions use one membership writer and one durable journal.
async function applyMembershipMutation(userId, input, hash, verify = null, decision = null, prepare = null) {
  return withTransaction(async client => {
    const account = await lockOwnedAccount(client, userId, input);
    const replay = await replayMutation(client, input, hash);
    if (replay) return replay;
    currentGeneration(account, input);
    if (prepare) await prepare(client);
    const labelIds = [...input.addLabelIds, ...input.removeLabelIds];
    const resolved = await resolveTargets(client, input, true);
    const entityIds = [...resolved.unique.keys()];
    const before = await resultFor(client, input, resolved);
    const verified = verify ? await verify(client, { resolved, before }) : null;
    await lockLabels(client, input, labelIds);
    await advanceVersions(client, input, resolved);
    await client.query(`DELETE FROM native_label_memberships WHERE account_id=$1 AND storage_generation=$2
      AND entity_id=ANY($3::uuid[]) AND label_id=ANY($4::uuid[])`, [input.accountId, input.storageGeneration, entityIds, input.removeLabelIds]);
    await client.query(`INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id)
      SELECT $1,$2,e,l FROM unnest($3::uuid[]) e CROSS JOIN unnest($4::uuid[]) l ON CONFLICT DO NOTHING`,
    [input.accountId, input.storageGeneration, entityIds, input.addLabelIds]);
    const result = { ...await resultFor(client, input, resolved), mutationId: input.mutationId, undoSupported: !decision?.empty };
    if (decision) result.receipt = decision.receipt({ verified, before, result });
    const undoState = { labelIds, targets: before.targets.map(target => ({ ...target,
      metadataVersion: resolved.unique.get(target.entityId).metadata_version })) };
    await recordMutation(client, input, hash, result, decision?.empty ? null : undoState, decision?.empty ? 'rule_decision' : 'apply');
    return { result, changed: true };
  });
}

// The original cache UUID is part of the proof. A newly cached row at the same UID
// must never inherit a delayed rule decision, even when its entity happens to match.
function sourceTuple(raw, captured = false) {
  object(raw, ['id', 'account_id', 'entity_id', 'storage_generation', 'folder', 'uid_validity', 'uid', ...(captured ? ['canonicalEntityId'] : [])]);
  const source = Object.fromEntries(['id', 'account_id', 'entity_id', 'storage_generation'].map(key => [key, uuid(raw[key], key)]));
  if (typeof raw.folder !== 'string' || !raw.folder.length || raw.folder.length > 4096) invalid('Invalid source folder');
  source.folder = raw.folder;
  for (const key of ['uid_validity', 'uid']) {
    const value = raw[key];
    if (!(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
      || !/^[1-9][0-9]{0,9}$/.test(String(value)) || BigInt(value) > 4294967295n) invalid(`Invalid source ${key}`);
    source[key] = String(value);
  }
  if (captured) source.canonicalEntityId = uuid(raw.canonicalEntityId, 'canonicalEntityId');
  return source;
}
async function verifySource(client, input, source) {
  if (source.account_id !== input.accountId || source.storage_generation !== input.storageGeneration) invalid('Source scope does not match request');
  // Hold the cache row against even non-identity cache deletion until our commit.
  const { rows: [row] } = await client.query(`SELECT m.id FROM messages m
    JOIN entity_locations l ON l.account_id=m.account_id AND l.storage_generation=m.storage_generation
      AND l.entity_id=m.entity_id AND l.folder_path=m.folder AND l.uid_validity=m.uid_validity AND l.uid=m.uid
    JOIN mailbox_identity_epochs ep ON ep.account_id=l.account_id AND ep.storage_generation=l.storage_generation
      AND ep.folder_path=l.folder_path AND ep.uid_validity=l.uid_validity
    WHERE m.id=$1 AND m.account_id=$2 AND m.storage_generation=$3 AND m.entity_id=$4
      AND m.folder=$5 AND m.uid_validity=$6 AND m.uid=$7 AND NOT m.is_deleted AND l.status='present'
    FOR SHARE OF m`, [source.id, input.accountId, input.storageGeneration, source.entity_id, source.folder, source.uid_validity, source.uid]);
  if (!row) fail(409, 'rule_source_changed', 'The captured message location is no longer available');
  const canonical = await resolveCanonicalEntity(client, input, source.entity_id);
  if (source.canonicalEntityId && canonical !== source.canonicalEntityId) fail(409, 'rule_source_changed', 'Message identity changed since this rule was captured');
  return canonical;
}

// Call before queueing or waiting for bodies. The caller must supply the persisted
// tuple, never a UID-only lookup at execution time. No existing version is refreshed.
export async function captureRuleMembershipSourceInTransaction(client, userId, raw) {
  const source = sourceTuple(raw);
  const input = { accountId: source.account_id, storageGeneration: source.storage_generation };
  currentGeneration(await lockOwnedAccount(client, userId, input), input);
  source.canonicalEntityId = await verifySource(client, input, source);
  const resolved = await resolveTargets(client, { ...input, targets: [{ entityId: source.entity_id }] }, false);
  const result = (await resultFor(client, input, resolved)).targets[0];
  if (!result.available) fail(409, 'identity_unavailable', 'A complete current identity is required');
  const { rows: [rawFields] } = await client.query('SELECT from_email,from_name,subject,is_read,has_attachments FROM messages WHERE id=$1', [source.id]);
  return { source, expectedMetadataVersion: result.metadataVersion, labelIds: result.labelIds, availability: 'known', rawFields };
}
export async function captureRuleMembershipSource(userId, raw) {
  return withTransaction(client => captureRuleMembershipSourceInTransaction(client, userId, raw));
}

export async function mutateRuleMemberships(userId, raw, { verifyRule, broadcast } = {}) {
  object(raw, ['accountId', 'storageGeneration', 'ruleId', 'ruleRevision', 'mutationId', 'source', 'expectedMetadataVersion', 'addLabelIds', 'removeLabelIds']);
  if (typeof verifyRule !== 'function') invalid('Rule transaction verifier is required');
  const source = sourceTuple(raw.source, true);
  const ruleId = uuid(raw.ruleId, 'ruleId');
  if (typeof raw.ruleRevision !== 'string' || !raw.ruleRevision.length || raw.ruleRevision.length > 128) invalid('A captured rule revision is required');
  const input = validateMembershipRequest({ accountId: raw.accountId, storageGeneration: raw.storageGeneration,
    mutationId: raw.mutationId, targets: [{ entityId: source.entity_id, expectedMetadataVersion: raw.expectedMetadataVersion }],
    addLabelIds: raw.addLabelIds, removeLabelIds: raw.removeLabelIds }, true);
  if (source.account_id !== input.accountId || source.storage_generation !== input.storageGeneration) invalid('Source scope does not match request');
  const context = { ...input, ruleId, ruleRevision: raw.ruleRevision, source, expectedMetadataVersion: input.targets[0].expectedMetadataVersion };
  const hash = createHash('sha256').update(JSON.stringify({ operation: 'rule', ...context })).digest('hex');
  const outcome = await applyMembershipMutation(userId, input, hash, async (client, { resolved, before }) => {
    await verifyRule(client, { userId, input: context, source, resolved, before });
  }, null, client => verifySource(client, input, source));
  // A failed push is not a failed mutation. Replaying the durable request cannot
  // apply it again or duplicate notifications. No provider or legacy-label writes.
  if (outcome.changed && broadcast) {
    try {
      await broadcast({ type: 'label_memberships_changed', accountId: outcome.result.accountId,
        storageGeneration: outcome.result.storageGeneration,
        entityIds: [...new Set(outcome.result.targets.map(target => target.entityId))] }, userId);
    } catch { console.warn('Rule label membership notification failed'); }
  }
  return outcome;
}

// Replays are historical results, checked before generation, labels and current versions.
async function replayMutation(client, input, hash) {
  const { rows: [replay] } = await client.query(`SELECT request_hash,response,created_at < NOW()-INTERVAL '30 days' AS expired
    FROM native_label_mutations WHERE account_id=$1 AND mutation_id=$2`, [input.accountId, input.mutationId]);
  if (!replay) return null;
  if (replay.request_hash !== hash) fail(409, 'mutation_conflict', 'This mutationId was already used for a different request');
  if (replay.expired || !replay.response) fail(409, 'mutation_expired', 'This request has expired. Refresh before making a new request');
  return { result: replay.response, changed: false };
}
async function lockLabels(client, input, labelIds, undo = false) {
  await client.query('INSERT INTO mail_label_state(account_id) VALUES ($1) ON CONFLICT DO NOTHING', [input.accountId]);
  await client.query('SELECT account_id FROM mail_label_state WHERE account_id=$1 FOR UPDATE', [input.accountId]);
  const labels = await client.query('SELECT id FROM mail_labels WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [input.accountId, labelIds]);
  if (labels.rows.length !== labelIds.length) {
    if (undo) fail(409, 'undo_unavailable', 'A label involved in this change no longer exists');
    fail(404, 'label_not_found', 'A selected label no longer exists in this account');
  }
}
async function advanceVersions(client, input, resolved) {
  // Explicit no-op decisions also protect provisional entities from later alias merges.
  if ([...resolved.unique.values()].some(row => row.metadata_version === '9223372036854775807')) fail(409, 'metadata_version_exhausted', 'Message metadata needs recovery');
  const updated = await client.query(`UPDATE message_entities SET metadata_version=metadata_version+1,updated_at=NOW()
    WHERE account_id=$1 AND storage_generation=$2 AND id=ANY($3::uuid[]) RETURNING id,metadata_version::text`,
  [input.accountId, input.storageGeneration, [...resolved.unique.keys()]]);
  for (const row of updated.rows) resolved.unique.get(row.id).metadata_version = row.metadata_version;
}
async function recordMutation(client, input, hash, result, undoState = null, operationKind = 'apply') {
  await client.query(`UPDATE native_label_mutations SET response=NULL,undo_state=NULL
    WHERE account_id=$1 AND response IS NOT NULL AND created_at<NOW()-INTERVAL '30 days'`, [input.accountId]);
  await client.query(`INSERT INTO native_label_mutations(account_id,mutation_id,storage_generation,request_hash,response,undo_state,operation_kind)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
  [input.accountId, input.mutationId, input.storageGeneration, hash, JSON.stringify(result), undoState === null ? null : JSON.stringify(undoState), operationKind]);
}
export function validateUndoRequest(raw) {
  object(raw, ['accountId', 'storageGeneration', 'mutationId', 'originalMutationId']);
  return Object.fromEntries(['accountId', 'storageGeneration', 'mutationId', 'originalMutationId'].map(key => [key, uuid(raw[key], key)]));
}
export async function undoMemberships(userId, raw) {
  const input = validateUndoRequest(raw);
  const hash = createHash('sha256').update(JSON.stringify({ operation: 'undo', ...input })).digest('hex');
  return withTransaction(async client => {
    const account = await lockOwnedAccount(client, userId, input);
    const replay = await replayMutation(client, input, hash);
    if (replay) return replay;
    currentGeneration(account, input);
    const { rows: [original] } = await client.query(`SELECT storage_generation,response,undo_state,operation_kind,
      created_at<NOW()-INTERVAL '30 days' AS expired FROM native_label_mutations
      WHERE account_id=$1 AND mutation_id=$2`, [input.accountId, input.originalMutationId]);
    if (!original || original.storage_generation !== input.storageGeneration) fail(409, 'undo_unavailable', 'The original label change is not available to undo');
    if (original.expired || !original.response) fail(409, 'mutation_expired', 'The original label change has expired');
    if (original.operation_kind !== 'apply' || !original.undo_state || original.response.undoSupported !== true) fail(409, 'undo_unavailable', 'This label change cannot be undone');
    const snapshot = original.undo_state;
    if (!Array.isArray(snapshot.targets) || !snapshot.targets.length || snapshot.targets.length > 200
      || !Array.isArray(snapshot.labelIds) || snapshot.labelIds.length > 200) fail(409, 'undo_unavailable', 'The saved label change needs recovery');
    const labelIds = new Set(snapshot.labelIds.map(id => uuid(id, 'labelId')));
    const targets = snapshot.targets.map(target => {
      uuid(target.entityId, 'entityId');
      if (!Array.isArray(target.labelIds) || target.labelIds.length > 500) fail(409, 'undo_unavailable', 'The saved label change needs recovery');
      for (const labelId of target.labelIds) labelIds.add(uuid(labelId, 'labelId'));
      return { entityId: uuid(target.requestedEntityId, 'requestedEntityId'), expectedMetadataVersion: version(target.metadataVersion) };
    });
    await lockLabels(client, input, [...labelIds].sort(), true);
    const resolved = await resolveTargets(client, { ...input, targets }, true);
    if (resolved.targets.some((target, i) => target.entityId !== snapshot.targets[i].entityId)) {
      fail(409, 'undo_identity_changed', 'Message identity changed since this label decision');
    }
    await advanceVersions(client, input, resolved);
    const beforeByEntity = new Map(snapshot.targets.map(target => [target.entityId, target.labelIds]));
    const memberships = [...beforeByEntity].flatMap(([entityId, labels]) => labels.map(labelId => ({ entity_id: entityId, label_id: labelId })));
    // Exact preimages, not one shared inverse delta: originally mixed targets stay mixed.
    await client.query(`DELETE FROM native_label_memberships m WHERE account_id=$1 AND storage_generation=$2
      AND entity_id=ANY($3::uuid[]) AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS r(entity_id uuid,label_id uuid)
        WHERE r.entity_id=m.entity_id AND r.label_id=m.label_id)`,
    [input.accountId, input.storageGeneration, [...resolved.unique.keys()], JSON.stringify(memberships)]);
    await client.query(`INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id)
      SELECT $1,$2,r.entity_id,r.label_id FROM jsonb_to_recordset($3::jsonb) AS r(entity_id uuid,label_id uuid)
      ON CONFLICT DO NOTHING`, [input.accountId, input.storageGeneration, JSON.stringify(memberships)]);
    const result = { ...await resultFor(client, input, resolved), mutationId: input.mutationId,
      originalMutationId: input.originalMutationId, undoSupported: false };
    await recordMutation(client, input, hash, result, null, 'undo');
    return { result, changed: true };
  });
}

// Internal decision entry point. It deliberately does not widen the public validator.
export async function reserveRuleMembershipDecision(userId, raw, { verifyDecision, receipt } = {}) {
  const source = sourceTuple(raw.source, true);
  uuid(raw.ruleId, 'ruleId');
  if (typeof raw.ruleRevision !== 'string' || !raw.ruleRevision.length || raw.ruleRevision.length > 128) invalid('A captured rule revision is required');
  if (!Array.isArray(raw.addLabelIds) || !Array.isArray(raw.removeLabelIds)) invalid('Label decisions must be arrays');
  const empty = !raw.addLabelIds.length && !raw.removeLabelIds.length;
  // Validate every public field, with a sentinel only for the internal empty delta.
  const input = validateMembershipRequest({ accountId: raw.accountId, storageGeneration: raw.storageGeneration,
    mutationId: raw.mutationId, targets: [{ entityId: source.entity_id, expectedMetadataVersion: raw.expectedMetadataVersion }],
    addLabelIds: empty ? [source.entity_id] : raw.addLabelIds, removeLabelIds: raw.removeLabelIds }, true);
  if (empty) input.addLabelIds = [];
  if (typeof verifyDecision !== 'function' || typeof receipt !== 'function') invalid('Decision transaction verifier required');
  const hash = createHash('sha256').update(JSON.stringify({ operation: 'rule_decision', ...raw })).digest('hex');
  return applyMembershipMutation(userId, input, hash, async (client, { resolved, before }) => {
    if (raw.availability !== 'known' || !Array.isArray(raw.labelIds)) fail(409, 'identity_unavailable', 'A complete membership snapshot is required');
    if (JSON.stringify([...new Set(raw.labelIds)].sort()) !== JSON.stringify(before.targets[0].labelIds)) fail(409, 'rule_evidence_changed', 'Captured membership evidence changed');
    return verifyDecision(client, { userId, input: raw, source, resolved, before });
  }, { empty, receipt }, client => verifySource(client, input, source));
}

// Revalidates a held proof under account/entity/cache locks, without advancing it.
// The callback is database-only. Provider/resource work MUST happen after return.
export async function guardRuleMembershipSource(userId, proof, callback) {
  return withTransaction(async client => {
    const source = sourceTuple(proof.source, true);
    const input = { accountId: source.account_id, storageGeneration: source.storage_generation,
      targets: [{ entityId: source.entity_id, expectedMetadataVersion: version(proof.expectedMetadataVersion) }] };
    currentGeneration(await lockOwnedAccount(client, userId, input), input);
    await verifySource(client, input, source);
    const resolved = await resolveTargets(client, input, true);
    const before = await resultFor(client, input, resolved);
    if (proof.availability !== 'known' || !Array.isArray(proof.labelIds) || JSON.stringify([...proof.labelIds].sort()) !== JSON.stringify(before.targets[0].labelIds)) {
      fail(409, 'rule_evidence_changed', 'Captured membership evidence changed');
    }
    return callback(client, { source, input, resolved, before });
  });
}

// Account locks serialize sanctioned identity and metadata writers. Cache rows are
// held too because disposable cache deletion need not take an identity lock.
export async function captureRuleMembershipBatchInTransaction(client, userId, tuples) {
  if (!Array.isArray(tuples) || tuples.length > 200) invalid('At most 200 snapshots may be captured');
  if (new Set(tuples.map(row => row.id)).size !== tuples.length) invalid('Duplicate captured cache rows');
  const accounts = [...new Set(tuples.map(row => uuid(row.account_id, 'account_id')))].sort();
  for (const accountId of accounts) await lockOwnedAccount(client, userId, { accountId });
  const sources = tuples.map(row => ['entity_id','storage_generation','uid_validity'].some(key => row[key] == null) ? null : sourceTuple(row));
  const valid = sources.filter(Boolean);
  const cached = await client.query('SELECT id,from_email,from_name,subject,is_read,has_attachments FROM messages WHERE account_id=ANY($1::uuid[]) AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
    [accounts, tuples.map(row => uuid(row.id, 'id'))]);
  const { rows } = await client.query(`WITH RECURSIVE requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,account_id uuid,entity_id uuid,storage_generation uuid,folder text,uid_validity bigint,uid bigint)
  ), verified AS (
    SELECT m.* FROM requested r JOIN messages m ON m.id=r.id AND m.account_id=r.account_id
      AND m.entity_id=r.entity_id AND m.storage_generation=r.storage_generation AND m.folder=r.folder
      AND m.uid_validity=r.uid_validity AND m.uid=r.uid
    JOIN email_accounts a ON a.id=m.account_id AND a.storage_generation=m.storage_generation
    JOIN entity_locations l ON l.account_id=m.account_id AND l.storage_generation=m.storage_generation
      AND l.entity_id=m.entity_id AND l.folder_path=m.folder AND l.uid_validity=m.uid_validity AND l.uid=m.uid
    JOIN mailbox_identity_epochs ep ON ep.account_id=l.account_id AND ep.storage_generation=l.storage_generation
      AND ep.folder_path=l.folder_path AND ep.uid_validity=l.uid_validity
    WHERE NOT m.is_deleted AND l.status='present'
  ), chain AS (
    SELECT m.id AS message_id,e.id,e.canonical_entity_id,e.account_id,e.storage_generation,e.metadata_version,ARRAY[e.id] AS visited
      FROM verified m JOIN message_entities e ON e.account_id=m.account_id AND e.storage_generation=m.storage_generation AND e.id=m.entity_id
    UNION ALL
    SELECT c.message_id,e.id,e.canonical_entity_id,e.account_id,e.storage_generation,e.metadata_version,c.visited||e.id
      FROM chain c JOIN message_entities e ON e.account_id=c.account_id AND e.storage_generation=c.storage_generation AND e.id=c.canonical_entity_id
      WHERE cardinality(c.visited)<32 AND NOT e.id=ANY(c.visited)
  ) SELECT c.message_id,c.id AS canonical_entity_id,c.metadata_version::text,
      jsonb_build_object('from_email',m.from_email,'from_name',m.from_name,'subject',m.subject,'is_read',m.is_read,'has_attachments',m.has_attachments) AS raw_fields,
      ARRAY(SELECT n.label_id FROM native_label_memberships n WHERE n.account_id=c.account_id AND n.storage_generation=c.storage_generation AND n.entity_id=c.id ORDER BY n.label_id) AS label_ids
    FROM chain c JOIN verified m ON m.id=c.message_id
    WHERE c.canonical_entity_id IS NULL AND EXISTS (
      SELECT 1 FROM messages live JOIN entity_locations l ON l.account_id=live.account_id AND l.storage_generation=live.storage_generation
        AND l.entity_id=live.entity_id AND l.folder_path=live.folder AND l.uid_validity=live.uid_validity AND l.uid=live.uid
      JOIN mailbox_identity_epochs ep ON ep.account_id=l.account_id AND ep.storage_generation=l.storage_generation
        AND ep.folder_path=l.folder_path AND ep.uid_validity=l.uid_validity
      WHERE live.account_id=c.account_id AND live.storage_generation=c.storage_generation AND live.entity_id=c.id AND NOT live.is_deleted AND l.status='present'
    )`, [JSON.stringify(valid)]);
  return sources.map((source, i) => {
    const row = source && rows.find(result => result.message_id === source.id);
    if (!row) {
      const cachedRow = cached.rows.find(item => item.id === tuples[i].id);
      const rawFields = cachedRow ? Object.fromEntries(Object.entries(cachedRow).filter(([key]) => key !== 'id')) : null;
      return { availability: 'unknown', source: structuredClone(tuples[i]), expectedMetadataVersion: null, labelIds: null, rawFields };
    }
    return { availability: 'known', source: { ...source, canonicalEntityId: row.canonical_entity_id },
      expectedMetadataVersion: row.metadata_version, labelIds: row.label_ids, rawFields: row.raw_fields };
  });
}
export async function captureRuleMembershipBatch(userId, tuples) {
  return withTransaction(client => captureRuleMembershipBatchInTransaction(client, userId, tuples));
}
