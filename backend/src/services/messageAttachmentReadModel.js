import { query } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PART = /^[1-9]\d*(?:\.[1-9]\d*)*$/;
const BATCH_SIZE = 200;
const SCAN_LIMIT = 100;
const DISPLAY_LIMIT = 20;
const FILENAME_LIMIT = 512;
const FIELD_LIMIT = 128;
const CALENDAR_TYPES = new Set(['text/calendar', 'text/x-vcalendar', 'application/ics',
  'application/calendar', 'application/icalendar', 'application/x-icalendar', 'application/x-vcalendar']);
// Sender-controlled labels remain plain text. Remove invisible controls that can
// conceal/reverse an extension, but never invent a name for an unnamed part.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const textField = (value, limit) => typeof value === 'string' && value.length <= limit ? value : null;
const partNumber = value => textField(value, FIELD_LIMIT) && PART.test(value) ? value : null;
const protocolNumber = value => {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const number = String(value);
  return /^\d{1,10}$/.test(number) && Number(number) > 0 && Number(number) <= 4294967295 ? String(Number(number)) : null;
};

function sourceOf(row) {
  if (![row.id, row.account_id, row.entity_id, row.storage_generation].every(value => typeof value === 'string' && UUID.test(value))
    || typeof row.folder !== 'string' || !row.folder.length || row.folder.length > 500) return null;
  const uid = protocolNumber(row.uid), uidValidity = protocolNumber(row.uid_validity);
  if (!uid || !uidValidity) return null;
  return { messageId: row.id.toLowerCase(), accountId: row.account_id.toLowerCase(),
    storageGeneration: row.storage_generation.toLowerCase(), entityId: row.entity_id.toLowerCase(),
    folder: row.folder, uidValidity, uid };
}

export function normalizeCachedAttachmentMetadata(source, cached) {
  const result = { state: 'unavailable', scope: 'message', source: source ?? null,
    items: [], omittedCount: null, providerComplete: false, inlineClassification: 'partial', sizeIsExact: false };
  if (!source) return result;
  result.state = 'unknown';
  if (!Array.isArray(cached?.entries) || !Number.isSafeInteger(cached.cached_count) || cached.cached_count < 0) return result;
  const entries = cached.entries.slice(0, SCAN_LIMIT);
  const counts = new Map();
  for (const entry of entries) {
    const part = partNumber(entry?.part);
    if (part) counts.set(part, (counts.get(part) || 0) + 1);
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const part = partNumber(entry.part);
    const filename = textField(entry.filename, FILENAME_LIMIT)?.replace(INVISIBLE, '').trim();
    if (!part || counts.get(part) !== 1 || !filename) continue;
    const disposition = textField(entry.disposition, FIELD_LIMIT)?.split(';', 1)[0].trim().toLowerCase();
    const type = textField(entry.type, FIELD_LIMIT)?.split(';', 1)[0].trim().toLowerCase();
    if ((entry.shownInline != null && entry.shownInline !== false) || (entry.inline != null && entry.inline !== false)
      || disposition === 'inline' || CALENDAR_TYPES.has(type) || /\.(?:ics|ical|icalendar|vcs)[.\s]*$/i.test(filename)) continue;
    const size = Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : null;
    result.items.push({ part, filename, type: type && /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(type) ? type : null, size });
    if (result.items.length === DISPLAY_LIMIT) break;
  }
  result.state = result.items.length ? 'partial' : 'unknown';
  // Includes invalid/filtered entries and entries past the scan/display limits.
  // This is not a count of additional displayable attachments.
  result.omittedCount = Math.max(0, cached.cached_count - result.items.length);
  return result;
}

const jsonText = (key, limit) => `CASE WHEN jsonb_typeof(entry->'${key}')='string'
  AND length(entry->>'${key}')<=${limit} THEN entry->>'${key}' END`;
const projectionSql = `WITH requested AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(request_index integer,id uuid,account_id uuid,
    folder text,uid bigint,entity_id uuid,storage_generation uuid,uid_validity bigint)
), verified AS MATERIALIZED (
  SELECT r.request_index,m.attachments
  FROM requested r JOIN messages m ON m.id=r.id AND m.account_id=r.account_id
    AND m.folder=r.folder AND m.uid=r.uid AND m.entity_id=r.entity_id
    AND m.storage_generation=r.storage_generation AND m.uid_validity=r.uid_validity
  JOIN email_accounts a ON a.id=m.account_id AND a.storage_generation=m.storage_generation
  JOIN entity_locations loc ON loc.account_id=m.account_id AND loc.storage_generation=m.storage_generation
    AND loc.folder_path=m.folder AND loc.uid_validity=m.uid_validity AND loc.uid=m.uid
    AND loc.entity_id=m.entity_id AND loc.status='present'
  JOIN mailbox_identity_epochs ep ON ep.account_id=loc.account_id AND ep.storage_generation=loc.storage_generation
    AND ep.folder_path=loc.folder_path AND ep.uid_validity=loc.uid_validity
  JOIN message_entities entity ON entity.id=m.entity_id AND entity.account_id=m.account_id
    AND entity.storage_generation=m.storage_generation
  WHERE a.user_id=$1 AND a.enabled=true AND m.is_deleted=false
), cached AS (
  SELECT *,CASE WHEN jsonb_typeof(attachments)='array' THEN jsonb_array_length(attachments) END AS cached_count
  FROM verified
)
SELECT request_index,cached_count,COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'part',${jsonText('part', FIELD_LIMIT)},'filename',${jsonText('filename', FILENAME_LIMIT)},
  'type',${jsonText('type', FIELD_LIMIT)},'disposition',${jsonText('disposition', FIELD_LIMIT)},
  'size',CASE WHEN jsonb_typeof(entry->'size')='number' AND length(entry->>'size')<=32 THEN entry->'size' END,
  'shownInline',COALESCE(entry->'shownInline' NOT IN ('false'::jsonb,'null'::jsonb),false),
  'inline',COALESCE(entry->'inline' NOT IN ('false'::jsonb,'null'::jsonb),false)
) ORDER BY ordinal)
  FROM generate_series(0,LEAST(COALESCE(cached_count,0),${SCAN_LIMIT})-1) AS ord(ordinal)
  CROSS JOIN LATERAL (SELECT attachments->ordinal AS entry) item),'[]'::jsonb) AS entries FROM cached`;

// Read only the exact physical row selected by each surface. Canonical entities,
// Message-IDs, thread members and sibling locations cannot supply another part.
// The SQL bounds both the JSON keys and array before it leaves PostgreSQL.
export async function hydrateCachedAttachmentMetadata(userId, messages, execute = query) {
  if (!messages.length) return messages;
  const sources = messages.map(sourceOf), metadata = new Map();
  for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
    const batch = sources.slice(offset, offset + BATCH_SIZE).flatMap((source, index) => source ? [{
      request_index: offset + index, id: source.messageId, account_id: source.accountId,
      storage_generation: source.storageGeneration, entity_id: source.entityId,
      folder: source.folder, uid_validity: source.uidValidity, uid: source.uid,
    }] : []);
    if (!batch.length) continue;
    const result = await execute(projectionSql, [userId, JSON.stringify(batch)]);
    for (const row of result.rows) metadata.set(row.request_index, row);
  }
  return messages.map((message, index) => {
    const row = { ...message };
    delete row.attachments;
    delete row.body_html;
    delete row.body_text;
    const cached = metadata.get(index);
    row.attachmentMetadata = normalizeCachedAttachmentMetadata(cached ? sources[index] : null, cached);
    return row;
  });
}
