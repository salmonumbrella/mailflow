import { hydrateCachedAttachmentMetadata } from './messageAttachmentReadModel.js';
// Native metadata reads never contact IMAP or the legacy folder-backed label API.
import { query, withTransaction } from './db.js';
import { LabelError } from './nativeLabelDefinitions.js';
import { trashMessageSql } from '../utils/mailUtils.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_SIZE = 200;
const invalid = message => { throw new LabelError(400, 'invalid_label_request', message); };
const uuid = (value, name) => {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${name} must be a UUID`);
  return value.toLowerCase();
};
const bool = (value, name) => {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  invalid(`${name} must be true or false`);
};

function validCursorDate(value) {
  if (value === '-infinity') return true;
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?([+-])(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute = '0'] = parts;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+month - 1];
  return +year > 0 && +day >= 1 && +day <= days && +hour < 24 && +minute < 60
    && +second < 60 && +offsetHour < 16 && +offsetMinute < 60;
}

// Use only current, verified cache coordinates. Canonical aliases are flattened by
// identity reconciliation; headers and thread keys are never evidence of identity.
export const nativeLabelLiveJoins = (m = 'm') => `
  JOIN email_accounts a ON a.id=${m}.account_id AND a.storage_generation=${m}.storage_generation
  JOIN entity_locations loc ON loc.account_id=${m}.account_id AND loc.storage_generation=${m}.storage_generation
    AND loc.folder_path=${m}.folder AND loc.uid_validity=${m}.uid_validity AND loc.uid=${m}.uid
    AND loc.entity_id=${m}.entity_id AND loc.status='present'
  JOIN mailbox_identity_epochs ep ON ep.account_id=loc.account_id AND ep.storage_generation=loc.storage_generation
    AND ep.folder_path=loc.folder_path AND ep.uid_validity=loc.uid_validity
  JOIN message_entities source ON source.account_id=${m}.account_id AND source.storage_generation=${m}.storage_generation AND source.id=${m}.entity_id
  JOIN message_entities entity ON entity.account_id=source.account_id AND entity.storage_generation=source.storage_generation
    AND entity.id=COALESCE(source.canonical_entity_id,source.id) AND entity.canonical_entity_id IS NULL`;

const labelJson = `jsonb_build_object('id',label.id,'accountId',label.account_id,'parentId',label.parent_id,
  'name',label.name,'path',label.full_path,'color',label.color,'textColor',label.text_color,
  'visibility',label.sidebar_visibility,'messageVisible',label.message_visibility,'revision',label.revision::text)`;
const labelsSql = `SELECT COALESCE(jsonb_agg(${labelJson} ORDER BY label.full_path COLLATE "C",label.id),'[]'::jsonb)
  FROM native_label_memberships membership
  JOIN message_entities member_entity ON member_entity.account_id=membership.account_id
    AND member_entity.storage_generation=membership.storage_generation AND member_entity.id=membership.entity_id
  JOIN mail_labels label ON label.account_id=membership.account_id AND label.id=membership.label_id
  WHERE membership.account_id=entity.account_id AND membership.storage_generation=entity.storage_generation
    AND COALESCE(member_entity.canonical_entity_id,member_entity.id)=entity.id`;

// Adds metadata to actual message rows, including a thread's representative only.
// Bounded set-based reads, never one query per message or label. Recheck the original
// coordinate because a cache UUID may have moved since the caller selected its rows.
export async function hydrateNativeLabels(userId, messages, execute = query) {
  if (!messages.length) return messages;
  const metadata = new Map();
  for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
    const batch = messages.slice(offset, offset + BATCH_SIZE).map((row, index) => ({ ...row, request_index: offset + index })).filter(row => UUID.test(row.id || '') && UUID.test(row.account_id || ''));
    if (!batch.length) continue;
    const result = await execute(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(request_index integer,id uuid,account_id uuid,folder text,uid bigint,entity_id uuid,storage_generation uuid,uid_validity bigint)
    ), verified AS (
      SELECT r.request_index,m.id,entity.id AS entity_id,entity.metadata_version::text,(${labelsSql}) AS labels
      FROM requested r JOIN messages m ON m.id=r.id AND m.account_id=r.account_id AND m.folder=r.folder AND m.uid=r.uid
        AND m.entity_id=r.entity_id AND m.storage_generation=r.storage_generation AND m.uid_validity=r.uid_validity
      ${nativeLabelLiveJoins()}
      WHERE a.user_id=$1 AND m.is_deleted=false
    )
    SELECT r.request_index,r.id,a.storage_generation,verified.entity_id,verified.metadata_version,verified.labels
    FROM requested r JOIN email_accounts a ON a.id=r.account_id AND a.user_id=$1
    LEFT JOIN verified ON verified.request_index=r.request_index`, [userId, JSON.stringify(batch.map(({ request_index, id, account_id, folder, uid, entity_id, storage_generation, uid_validity }) => ({ request_index, id, account_id, folder, uid, entity_id, storage_generation, uid_validity })))]);
    for (const row of result.rows) metadata.set(row.request_index, row);
  }
  return messages.map((message, index) => {
    const row = metadata.get(index);
    const available = !!row?.entity_id;
    return { ...message, entityId: available ? row.entity_id : null,
      storageGeneration: row?.storage_generation ?? null,
      metadataVersion: available ? String(row.metadata_version) : null,
      nativeLabelState: available ? 'available' : 'unavailable', nativeLabelScope: 'message',
      nativeLabels: available ? row.labels : null };
  });
}

const coverage = includeSpamTrash => ({ kind: 'synchronized-cache', providerComplete: false,
  includesSpamTrash: includeSpamTrash, directMembershipOnly: true });

async function readScope(client, { userId, accountId, storageGeneration }) {
  const account = (await client.query(`SELECT id,storage_generation FROM email_accounts
    WHERE id=$1 AND user_id=$2 AND enabled=true FOR SHARE`, [accountId, userId])).rows[0];
  if (!account) throw new LabelError(404, 'not_found', 'Account or label not found');
  if (account.storage_generation !== storageGeneration) throw new LabelError(409, 'storage_generation_conflict', 'The mailbox changed. Reload before reading labels.');
}

// Spam/Trash are excluded by default, with an explicit opt-in. Account mappings,
// special-use markers and the conventional path names work even after cache purges.
const spamTrashSql = `(${trashMessageSql()} OR m.folder=a.folder_mappings->>'trash'
  OR m.folder=a.folder_mappings->>'junk' OR m.folder=a.folder_mappings->>'spam'
  OR lower(m.folder) IN ('spam','junk','trash','deleted','deleted items','deleted messages')
  OR EXISTS (SELECT 1 FROM folders sf WHERE sf.account_id=m.account_id AND sf.path=m.folder
    AND (sf.special_use IN ('\\Junk','\\Trash') OR lower(sf.name) IN ('spam','junk','trash','deleted','deleted items','deleted messages'))))`;
const liveCtes = `WITH live AS MATERIALIZED (
  SELECT m.id,m.uid,m.folder,m.entity_id,m.storage_generation,m.uid_validity,m.message_id,m.subject,m.from_name,m.from_email,
    m.to_addresses,m.cc_addresses,m.reply_to,m.in_reply_to,m.thread_references,m.thread_id,
    m.date,m.snippet,m.is_read,m.is_starred,m.has_attachments,m.account_id,m.category,
    m.list_unsubscribe,m.list_unsubscribe_post,m.delivery_addresses,
    m.spam_verdict,m.spam_user_override,m.spam_score_ml,
    entity.id AS canonical_id,a.name AS account_name,a.email_address AS account_email,a.color AS account_color,
    ($3::boolean OR NOT COALESCE(${spamTrashSql},false)) AS included
  FROM messages m ${nativeLabelLiveJoins()}
  WHERE m.account_id=$1 AND m.storage_generation=$2 AND m.is_deleted=false
    AND NOT (m.message_id IS NULL AND (m.subject IS NULL OR m.subject='(no subject)') AND COALESCE(m.snippet,'')='')
), eligible AS (
  SELECT canonical_id,bool_or(NOT is_read) AS unread,max(date) AS sort_date FROM live WHERE included GROUP BY canonical_id
), memberships AS (
  SELECT DISTINCT membership.label_id,COALESCE(e.canonical_entity_id,e.id) AS entity_id
  FROM native_label_memberships membership JOIN message_entities e
    ON e.account_id=membership.account_id AND e.storage_generation=membership.storage_generation AND e.id=membership.entity_id
  WHERE membership.account_id=$1 AND membership.storage_generation=$2
)`;

function scopeInput(input) {
  return { userId: input.userId, accountId: uuid(input.accountId, 'accountId'),
    storageGeneration: uuid(input.storageGeneration, 'storageGeneration'),
    includeSpamTrash: bool(input.includeSpamTrash, 'includeSpamTrash') };
}

export async function getNativeLabelCounts(input) {
  const scope = scopeInput(input);
  return withTransaction(async client => {
    await readScope(client, scope);
    const result = await client.query(`${liveCtes}
      SELECT label.id AS "labelId",count(eligible.canonical_id)::int AS total,
        count(eligible.canonical_id) FILTER (WHERE eligible.unread)::int AS unread,
        count(memberships.entity_id) FILTER (WHERE eligible.canonical_id IS NULL AND NOT EXISTS (SELECT 1 FROM live WHERE live.canonical_id=memberships.entity_id))::int AS "unresolvedMemberships"
      FROM mail_labels label LEFT JOIN memberships ON memberships.label_id=label.id
      LEFT JOIN eligible ON eligible.canonical_id=memberships.entity_id
      WHERE label.account_id=$1 GROUP BY label.id ORDER BY label.full_path COLLATE "C",label.id`,
    [scope.accountId, scope.storageGeneration, scope.includeSpamTrash]);
    return { accountId: scope.accountId, storageGeneration: scope.storageGeneration,
      counts: result.rows, coverage: { ...coverage(scope.includeSpamTrash),
        priorGenerationMemberships: (await client.query(`SELECT count(*)::int AS count FROM native_label_memberships
          WHERE account_id=$1 AND storage_generation<>$2`, [scope.accountId, scope.storageGeneration])).rows[0].count } };
  });
}

export async function listNativeLabelMessages(input) {
  const scope = scopeInput(input);
  const labelId = uuid(input.labelId, 'labelId');
  const unreadOnly = bool(input.unreadOnly, 'unreadOnly');
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit must be an integer between 1 and 200');
  let cursor = null;
  const cursorScope = { accountId: scope.accountId, storageGeneration: scope.storageGeneration, labelId,
    includeSpamTrash: scope.includeSpamTrash, unreadOnly };
  if (input.cursor) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 2000) invalid('Invalid cursor');
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || Object.entries(cursorScope).some(([key, value]) => cursor[key] !== value)
        || !UUID.test(cursor.entityId) || !validCursorDate(cursor.date)) invalid('Invalid cursor');
    } catch { invalid('Invalid or mismatched cursor'); }
  }
  return withTransaction(async client => {
    await readScope(client, scope);
    if (!(await client.query('SELECT id FROM mail_labels WHERE account_id=$1 AND id=$2', [scope.accountId, labelId])).rows.length)
      throw new LabelError(404, 'not_found', 'Account or label not found');
    const params = [scope.accountId, scope.storageGeneration, scope.includeSpamTrash, labelId];
    const stats = (await client.query(`${liveCtes} SELECT
      count(eligible.canonical_id)::int AS total,
      count(eligible.canonical_id) FILTER (WHERE eligible.unread)::int AS unread,
      count(memberships.entity_id) FILTER (WHERE eligible.canonical_id IS NULL AND NOT EXISTS (SELECT 1 FROM live WHERE live.canonical_id=memberships.entity_id))::int AS unresolved,
      (SELECT count(*)::int FROM native_label_memberships WHERE account_id=$1 AND storage_generation<>$2 AND label_id=$4) AS prior
      FROM memberships LEFT JOIN eligible ON eligible.canonical_id=memberships.entity_id WHERE memberships.label_id=$4`, params)).rows[0];
    const page = await client.query(`${liveCtes}
      SELECT chosen.*,eligible.unread AS native_label_unread,COALESCE(eligible.sort_date,'-infinity'::timestamptz)::text AS native_label_sort_date
      FROM memberships JOIN eligible ON eligible.canonical_id=memberships.entity_id
      JOIN LATERAL (SELECT * FROM live WHERE canonical_id=eligible.canonical_id AND included
        ORDER BY (folder='INBOX') DESC,folder COLLATE "C",uid,id LIMIT 1) chosen ON true
      WHERE memberships.label_id=$4 AND (NOT $5::boolean OR eligible.unread)
        AND ($6::timestamptz IS NULL OR COALESCE(eligible.sort_date,'-infinity'::timestamptz)<$6::timestamptz
          OR (COALESCE(eligible.sort_date,'-infinity'::timestamptz)=$6::timestamptz AND eligible.canonical_id>$7::uuid))
      ORDER BY COALESCE(eligible.sort_date,'-infinity'::timestamptz) DESC,eligible.canonical_id LIMIT $8`,
    [...params, unreadOnly, cursor?.date ?? null, cursor?.entityId ?? null, limit + 1]);
    const rows = page.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor = page.rows.length > limit ? Buffer.from(JSON.stringify({ v: 1, ...cursorScope,
      date: last.native_label_sort_date, entityId: last.canonical_id })).toString('base64url') : null;
    const hydrated = await hydrateCachedAttachmentMetadata(scope.userId,
      await hydrateNativeLabels(scope.userId, rows, client.query.bind(client)), client.query.bind(client));
    const messages = hydrated.map(row => {
      const message = { ...row, locator_is_read: row.is_read, is_read: !row.native_label_unread };
      delete message.canonical_id;
      delete message.native_label_sort_date;
      delete message.included;
      return message;
    });
    return { accountId: scope.accountId, storageGeneration: scope.storageGeneration, labelId,
      messages, total: unreadOnly ? stats.unread : stats.total, unread: stats.unread, nextCursor,
      coverage: { ...coverage(scope.includeSpamTrash), unresolvedMemberships: stats.unresolved, priorGenerationMemberships: stats.prior } };
  });
}
