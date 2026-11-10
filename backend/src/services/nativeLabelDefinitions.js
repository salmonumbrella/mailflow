// Native, account-owned definitions only. This module must never import the mail engine,
// legacy folder-backed labels, or write to the disposable message/folder cache.
import { createHash, randomUUID } from 'crypto';
import { query, withTransaction } from './db.js';

export const LABEL_CAPABILITIES = Object.freeze({ assignmentSupported: false, counts: null, coverage: 'not_indexed' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFINITION_FIELDS = ['name', 'parentId', 'color', 'textColor', 'visibility', 'messageVisible'];
const MAX_LABELS = 500;
export class LabelError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new LabelError(400, 'invalid_label_request', message); };
const conflict = (code, message) => { throw new LabelError(409, code, message); };
const missing = () => { throw new LabelError(404, 'not_found', 'Account or label not found'); };
const uuid = (value, field) => {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
};
const revision = (value, field) => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) invalid(`${field} must be a nonnegative revision string`);
  return value;
};

// All writes use NFC + trim + locale-independent Unicode lowercasing + NFC. PostgreSQL
// compares this stored key exactly; it must not apply a different database locale policy.
export function normalizeName(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}/]/u.test(value)) invalid('Name must not contain slashes or control characters');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 100) invalid('Name must contain 1 to 100 characters');
  return { name, normalizedName: name.toLowerCase().normalize('NFC') };
}
export function validateDefinition(input) {
  const result = {};
  if (Object.hasOwn(input, 'name')) Object.assign(result, normalizeName(input.name));
  if (Object.hasOwn(input, 'parentId')) result.parentId = input.parentId === null ? null : uuid(input.parentId, 'parentId');
  for (const key of ['color', 'textColor']) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) invalid(`${key} must be #RRGGBB or null`);
    result[key] = value?.toLowerCase() ?? null;
  }
  if (Object.hasOwn(input, 'visibility')) {
    if (!['show', 'hide', 'unread'].includes(input.visibility)) invalid('visibility must be show, hide or unread');
    result.visibility = input.visibility;
  }
  if (Object.hasOwn(input, 'messageVisible')) {
    if (typeof input.messageVisible !== 'boolean') invalid('messageVisible must be boolean');
    result.messageVisible = input.messageVisible;
  }
  return result;
}
export function validateRequest(operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('A request object is required');
  const allowed = operation === 'create' ? ['accountId', 'mutationId', ...DEFINITION_FIELDS]
    : operation === 'patch' ? ['accountId', 'mutationId', 'expectedRevision', ...DEFINITION_FIELDS]
      : operation === 'delete' ? ['accountId', 'mutationId', 'expectedTreeRevision', 'confirmSubtree'] : ['accountId'];
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid('Unknown request field');
  const result = { accountId: uuid(input.accountId, 'accountId') };
  if (['create', 'patch', 'delete'].includes(operation)) result.mutationId = uuid(input.mutationId, 'mutationId');
  if (operation === 'create' || operation === 'patch') Object.assign(result, validateDefinition(input));
  if (operation === 'create' && !result.name) invalid('name is required');
  if (operation === 'patch') {
    result.expectedRevision = revision(input.expectedRevision, 'expectedRevision');
    if (!DEFINITION_FIELDS.some(key => Object.hasOwn(input, key))) invalid('Provide at least one label field');
  }
  if (operation === 'delete') {
    result.expectedTreeRevision = revision(input.expectedTreeRevision, 'expectedTreeRevision');
    if (input.confirmSubtree !== true) invalid('confirmSubtree must be true');
    result.confirmSubtree = true;
  }
  return result;
}

function fromRow(row) {
  return { id: row.id, accountId: row.account_id, parentId: row.parent_id, name: row.name,
    normalizedName: row.normalized_name, path: row.full_path, color: row.color, textColor: row.text_color,
    visibility: row.sidebar_visibility, messageVisible: row.message_visibility, revision: String(row.revision) };
}
const dto = label => {
  const publicFields = { ...label };
  delete publicFields.normalizedName;
  return { ...publicFields, counts: null };
};

export function derivePaths(labels) {
  const byId = new Map(labels.map(label => [label.id, label]));
  const paths = new Map(), siblings = new Set();
  for (const label of labels) {
    const siblingKey = JSON.stringify([label.parentId, label.normalizedName]);
    if (siblings.has(siblingKey)) conflict('duplicate_name', 'A label with this name already exists at this level');
    siblings.add(siblingKey);
  }
  const pathOf = (id, ancestors = new Set()) => {
    if (ancestors.has(id)) invalid('A label cannot be nested inside itself or its descendants');
    const label = byId.get(id);
    if (!label) missing();
    const chain = new Set([...ancestors, id]);
    if (chain.size > 20) invalid('Labels may be nested at most 20 levels');
    // Do not use cached paths here: depth must be checked for every entire chain.
    const path = label.parentId === null ? label.name : `${pathOf(label.parentId, chain)}/${label.name}`;
    if ([...path].length > 1000) invalid('A label path may contain at most 1000 characters');
    return path;
  };
  for (const label of labels) paths.set(label.id, pathOf(label.id));
  return paths;
}

// A single statement gives definitions and their revision one consistent MVCC snapshot.
// Disabled accounts retain editable local definitions; these operations never need IMAP.
export async function listDefinitions(userId, input) {
  const { accountId } = validateRequest('list', input);
  const { rows } = await query(`SELECT COALESCE(s.tree_revision, 0)::text AS tree_revision,
      COALESCE((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('revision', l.revision::text) ORDER BY l.full_path, l.id)
                  FROM mail_labels l WHERE l.account_id = a.id), '[]'::jsonb) AS labels
    FROM email_accounts a LEFT JOIN mail_label_state s ON s.account_id = a.id
    WHERE a.id = $1 AND a.user_id = $2`, [accountId, userId]);
  if (!rows.length) missing();
  return { labels: rows[0].labels.map(row => dto(fromRow(row))), treeRevision: rows[0].tree_revision, ...LABEL_CAPABILITIES };
}
export async function previewDeletion(userId, id, input) {
  id = uuid(id, 'id');
  const state = await listDefinitions(userId, input);
  const label = state.labels.find(item => item.id === id);
  if (!label) missing();
  const descendants = state.labels.filter(item => item.path.startsWith(`${label.path}/`));
  return { label, descendants, deletedLabelIds: [id, ...descendants.map(item => item.id)],
    treeRevision: state.treeRevision, removesMessages: false, ...LABEL_CAPABILITIES };
}
const requestHash = request => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');

async function mutate(userId, operation, id, rawInput) {
  const input = validateRequest(operation, rawInput);
  if (id !== null) id = uuid(id, 'id');
  const hash = requestHash({ operation, id, ...input });
  try {
    return await withTransaction(async client => {
      // Ownership is rechecked under a lock that prevents deleting/transferring the account
      // during this transaction. All definition mutations take the state lock in this order.
      const owned = await client.query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 FOR SHARE', [input.accountId, userId]);
      if (!owned.rows.length) missing();
      await client.query('INSERT INTO mail_label_state (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [input.accountId]);
      const { rows: [state] } = await client.query('SELECT tree_revision::text FROM mail_label_state WHERE account_id = $1 FOR UPDATE', [input.accountId]);
      const { rows: [replay] } = await client.query(`SELECT request_hash, response, created_at < NOW() - INTERVAL '30 days' AS expired
        FROM mail_label_mutations WHERE account_id = $1 AND mutation_id = $2`, [input.accountId, input.mutationId]);
      if (replay) {
        if (replay.request_hash !== hash) conflict('mutation_conflict', 'This mutationId was already used for a different request');
        if (replay.expired || !replay.response) conflict('mutation_expired', 'This mutation has expired; refresh labels before making a new request');
        return { result: replay.response, changed: false };
      }
      const { rows } = await client.query('SELECT * FROM mail_labels WHERE account_id = $1 ORDER BY full_path, id', [input.accountId]);
      const labels = rows.map(fromRow);
      let label = id === null ? null : labels.find(item => item.id === id);
      if (id !== null && !label) missing();
      let changed = true;
      let result;
      const nextTreeRevision = (BigInt(state.tree_revision) + 1n).toString();
      if (operation === 'delete') {
        if (input.expectedTreeRevision !== state.tree_revision) conflict('stale_tree_revision', 'Labels changed since the preview. Review a fresh preview before deleting');
        const deletedLabelIds = [id, ...labels.filter(item => item.path.startsWith(`${label.path}/`)).map(item => item.id)];
        await client.query('DELETE FROM mail_labels WHERE account_id = $1 AND id = ANY($2::uuid[])', [input.accountId, deletedLabelIds]);
        result = { deletedLabelIds, treeRevision: nextTreeRevision, ...LABEL_CAPABILITIES };
      } else {
        const fields = validateDefinition(rawInput);
        if (operation === 'create') {
          if (labels.length >= MAX_LABELS) invalid(`An account may have at most ${MAX_LABELS} labels`);
          label = { id: randomUUID(), accountId: input.accountId, parentId: null, color: null, textColor: null,
            visibility: 'show', messageVisible: true, revision: '1', ...fields };
          labels.push(label);
        } else {
          if (input.expectedRevision !== label.revision) conflict('stale_label_revision', 'This label changed. Refresh it before saving');
          changed = Object.entries(fields).some(([key, value]) => label[key] !== value);
          Object.assign(label, fields);
          if (changed) label.revision = (BigInt(label.revision) + 1n).toString();
        }
        const paths = derivePaths(labels);
        label.path = paths.get(label.id);
        if (operation === 'create') {
          await client.query(`INSERT INTO mail_labels (id, account_id, parent_id, name, normalized_name, full_path,
            color, text_color, sidebar_visibility, message_visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [label.id, input.accountId, label.parentId, label.name, label.normalizedName, label.path, label.color, label.textColor, label.visibility, label.messageVisible]);
        } else if (changed) {
          await client.query(`UPDATE mail_labels SET parent_id=$3, name=$4, normalized_name=$5, full_path=$6,
            color=$7, text_color=$8, sidebar_visibility=$9, message_visibility=$10, revision=$11, updated_at=NOW()
            WHERE account_id=$1 AND id=$2`,
          [input.accountId, id, label.parentId, label.name, label.normalizedName, label.path, label.color, label.textColor, label.visibility, label.messageVisible, label.revision]);
          for (const descendant of labels) {
            if (descendant.id !== id && paths.get(descendant.id) !== descendant.path) {
              await client.query(`UPDATE mail_labels SET full_path=$3, revision=revision+1, updated_at=NOW() WHERE account_id=$1 AND id=$2`,
                [input.accountId, descendant.id, paths.get(descendant.id)]);
            }
          }
        }
        result = { label: dto(label), treeRevision: changed ? nextTreeRevision : state.tree_revision, ...LABEL_CAPABILITIES };
      }
      if (changed) await client.query('UPDATE mail_label_state SET tree_revision=$2 WHERE account_id=$1', [input.accountId, nextTreeRevision]);
      await client.query(`UPDATE mail_label_mutations SET response=NULL WHERE account_id=$1 AND response IS NOT NULL AND created_at < NOW() - INTERVAL '30 days'`, [input.accountId]);
      await client.query('INSERT INTO mail_label_mutations (account_id,mutation_id,request_hash,response) VALUES ($1,$2,$3,$4::jsonb)',
        [input.accountId, input.mutationId, hash, JSON.stringify(result)]);
      return { result, changed };
    });
  } catch (error) {
    if (error.code === '23505') conflict('duplicate_name', 'A label with this name already exists at this level');
    throw error;
  }
}
export const createDefinition = (userId, input) => mutate(userId, 'create', null, input);
export const updateDefinition = (userId, id, input) => mutate(userId, 'patch', id, input);
export const deleteDefinition = (userId, id, input) => mutate(userId, 'delete', id, input);
