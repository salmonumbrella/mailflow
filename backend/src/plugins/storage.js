import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../services/db.js';

// Generic per-plugin storage — lets a plugin own data without raw DB access.
//
// A record is keyed by (pluginId, key) and holds a JSON `value`, an optional binary `blob`
// (+ mime), an optional `ownerId` (a user; the row is cascade-deleted when they're deleted),
// and a `visibility` flag the plugin can use for its own read gating. Modeled on the existing
// user_integrations table, extended to carry blobs. See migration 0041_plugin_data.sql.
//
// This is the first safe, generic capability of the plugin platform: the GTD inbox-zero pet
// is its first consumer, and it's the storage surface future (sandboxed) plugins will use.

export async function put(pluginId, key, { value = {}, blob = null, mime = null, ownerId = null, visibility = 'private' } = {}) {
  await query(
    `INSERT INTO plugin_data (plugin_id, key, owner_id, value, blob, blob_mime, visibility, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW())
     ON CONFLICT (plugin_id, key) DO UPDATE SET
       owner_id   = EXCLUDED.owner_id,
       value      = EXCLUDED.value,
       blob       = EXCLUDED.blob,
       blob_mime  = EXCLUDED.blob_mime,
       visibility = EXCLUDED.visibility,
       updated_at = NOW()`,
    [pluginId, key, ownerId, JSON.stringify(value), blob, mime, visibility]
  );
}

// Metadata (no blob) — key, owner, JSON value, visibility. Null when absent.
export async function getValue(pluginId, key) {
  const { rows } = await query(
    `SELECT key, owner_id, value, visibility FROM plugin_data WHERE plugin_id = $1 AND key = $2`,
    [pluginId, key]
  );
  return rows[0] || null;
}

// The binary blob + mime (and owner/visibility for gating). Null when absent.
export async function getBlob(pluginId, key) {
  const { rows } = await query(
    `SELECT blob, blob_mime, owner_id, visibility FROM plugin_data WHERE plugin_id = $1 AND key = $2`,
    [pluginId, key]
  );
  return rows[0] || null;
}

export async function del(pluginId, key) {
  await query(`DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2`, [pluginId, key]);
}

// New private records use an envelope so revisions survive restarts without a schema change.
// Legacy blob/public consumers above keep their original wire and storage format.
function ownedArgs(pluginId, ownerId, key = '') {
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginId)
    || typeof ownerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)
    || typeof key !== 'string' || key.length > 255) throw new TypeError('Invalid owned storage scope');
}
const record = row => row ? { key: row.key, value: row.value.data, revision: row.value.revision } : null;
const ownedSelect = `SELECT key, value FROM plugin_data WHERE plugin_id = $1 AND owner_id = $2 AND key = $3 AND value->>'revision' IS NOT NULL`;
const withOwnedWrite = (pluginId, ownerId, write) => withTransaction(async client => {
  // Shared by every revisioned write/delete, including unguarded creators. Row locks alone
  // cannot protect an expected absence in a multi-key snapshot.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([pluginId, ownerId.toLowerCase()])]);
  return write(client);
});

export async function getOwned(pluginId, ownerId, key) {
  ownedArgs(pluginId, ownerId, key);
  return record((await query(ownedSelect, [pluginId, ownerId, key])).rows[0]);
}

export async function listOwned(pluginId, ownerId, { prefix = '', after = null, limit = 100, filters = [] } = {}) {
  ownedArgs(pluginId, ownerId, prefix);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (after !== null && (typeof after !== 'string' || after.length > 255))
    || !Array.isArray(filters) || filters.length > 8) throw new TypeError('Invalid owned storage page');
  const values = [pluginId, ownerId, prefix, after];
  const operators = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' };
  const clauses = filters.map(({ field, op, value }) => {
    if (typeof field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field)
      || !Object.hasOwn(operators, op) || typeof value !== 'string' || value.length > 1000) throw new TypeError('Invalid owned storage filter');
    values.push(field, value);
    return `(value->'data'->>$${values.length - 1}) COLLATE "C" ${operators[op]} $${values.length}`;
  });
  values.push(limit + 1);
  const { rows } = await query(`SELECT key, value FROM plugin_data
    WHERE plugin_id = $1 AND owner_id = $2 AND left(key, length($3)) = $3
      AND ($4::text IS NULL OR key COLLATE "C" > $4) AND value->>'revision' IS NOT NULL
      ${clauses.map(c => `AND ${c}`).join(' ')}
    ORDER BY key COLLATE "C" LIMIT $${values.length}`, values);
  const items = rows.slice(0, limit).map(record);
  return { items, nextCursor: rows.length > limit ? items.at(-1).key : null };
}

export async function putOwned(pluginId, ownerId, key, value, { expectedRevision, guard, guards } = {}) {
  ownedArgs(pluginId, ownerId, key);
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 64)) throw new TypeError('A revision or null is required');
  if (guard) {
    ownedArgs(pluginId, ownerId, guard.key);
    if (typeof guard.revision !== 'string' || !guard.revision || guard.revision.length > 64) throw new TypeError('Invalid guard revision');
  }
  if (guards !== undefined) {
    if (!Array.isArray(guards) || guards.length < 1 || guards.length > 200
      || new Set(guards.map(item => item?.key)).size !== guards.length) throw new TypeError('Invalid owned revision guards');
    for (const item of guards) {
      if (!item || typeof item.key !== 'string' || (item.revision !== null && (typeof item.revision !== 'string' || !item.revision || item.revision.length > 64))) throw new TypeError('Invalid guard revision');
      ownedArgs(pluginId, ownerId, item.key);
    }
  }
  const encoded = JSON.stringify({ data: value, revision: randomUUID() });
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new TypeError('Owned record is too large');
  const write = async client => {
    if (guards) {
      const { rows } = await client.query(`SELECT key, value->>'revision' AS revision FROM plugin_data
        WHERE plugin_id = $1 AND owner_id = $2 AND key = ANY($3::text[]) FOR UPDATE`, [pluginId, ownerId, guards.map(item => item.key)]);
      const revisions = new Map(rows.map(row => [row.key, row.revision]));
      if (guards.some(item => item.revision === null ? revisions.has(item.key) : revisions.get(item.key) !== item.revision)) return null;
    }
    if (guard) {
      const { rows } = await client.query(`${ownedSelect} AND value->>'revision' = $4 FOR UPDATE`, [pluginId, ownerId, guard.key, guard.revision]);
      if (!rows.length) return null;
    }
    const { rows } = expectedRevision === null
      ? await client.query(`INSERT INTO plugin_data (plugin_id, key, owner_id, value) VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (plugin_id, key) DO NOTHING RETURNING key, value`, [pluginId, key, ownerId, encoded])
      : await client.query(`UPDATE plugin_data SET value = $4::jsonb, updated_at = NOW()
          WHERE plugin_id = $1 AND key = $2 AND owner_id = $3 AND value->>'revision' = $5 RETURNING key, value`, [pluginId, key, ownerId, encoded, expectedRevision]);
    return record(rows[0]);
  };
  return withOwnedWrite(pluginId, ownerId, write);
}

export async function deleteOwned(pluginId, ownerId, key, { expectedRevision } = {}) {
  ownedArgs(pluginId, ownerId, key);
  if (typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 64) throw new TypeError('A revision is required');
  return withOwnedWrite(pluginId, ownerId, async client => {
    const result = await client.query(`DELETE FROM plugin_data WHERE plugin_id = $1 AND owner_id = $2 AND key = $3 AND value->>'revision' = $4`, [pluginId, ownerId, key, expectedRevision]);
    return result.rowCount === 1;
  });
}

// A bounded CAS delete for records obtained through an owner-scoped page. Concurrent edits
// survive: callers must re-list rather than delete an updated record by key alone.
export async function deleteOwnedBatch(pluginId, ownerId, records) {
  ownedArgs(pluginId, ownerId);
  if (!Array.isArray(records) || records.length > 200) throw new TypeError('Invalid owned deletion batch');
  for (const item of records) {
    if (!item || typeof item.revision !== 'string' || !item.revision || item.revision.length > 64) throw new TypeError('A revision is required');
    ownedArgs(pluginId, ownerId, item.key);
  }
  if (!records.length) return 0;
  const expected = records.map(({ key, revision }) => ({ key, revision }));
  return withOwnedWrite(pluginId, ownerId, async client => {
    const result = await client.query(`DELETE FROM plugin_data AS stored
    WHERE stored.plugin_id = $1 AND stored.owner_id = $2 AND EXISTS (
      SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS expected(key text, revision text)
      WHERE stored.key = expected.key AND stored.value->>'revision' = expected.revision
    )`, [pluginId, ownerId, JSON.stringify(expected)]);
    return result.rowCount;
  });
}

// Atomically change a small set of revisioned private records. Discoverability indexes and
// their values must commit together, never leave an accepted value with a missing index.
export async function putOwnedBatch(pluginId, ownerId, changes, { guards } = {}) {
  ownedArgs(pluginId, ownerId);
  if (!Array.isArray(changes) || !changes.length || changes.length > 20
    || !Array.isArray(guards) || !guards.length || guards.length > 200) throw new TypeError('Invalid owned write batch');
  const revision = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 64);
  const validate = (item, field) => {
    if (!item || typeof item.key !== 'string' || !revision(item[field])) throw new TypeError('Invalid owned batch record');
    ownedArgs(pluginId, ownerId, item.key);
  };
  changes.forEach(item => validate(item, 'expectedRevision'));
  guards.forEach(item => validate(item, 'revision'));
  if (new Set(changes.map(item => item.key)).size !== changes.length || new Set(guards.map(item => item.key)).size !== guards.length) throw new TypeError('Duplicate owned batch keys');
  const keys = [...new Set([...changes, ...guards].map(item => item.key))].sort();
  if (keys.length > 200) throw new TypeError('Owned batch scope is too large');
  const encoded = changes.map(item => ({ ...item, json: JSON.stringify({ data: item.value, revision: randomUUID() }) }));
  if (encoded.some(item => Buffer.byteLength(item.json) > 256 * 1024)
    || encoded.reduce((total, item) => total + Buffer.byteLength(item.json), 0) > 512 * 1024) throw new TypeError('Owned batch is too large');
  class Conflict extends Error {}
  try {
    return await withOwnedWrite(pluginId, ownerId, async client => {
      const { rows } = await client.query(`SELECT key, owner_id, value->>'revision' AS revision FROM plugin_data
        WHERE plugin_id = $1 AND key = ANY($2::text[]) ORDER BY key FOR UPDATE`, [pluginId, keys]);
      if (rows.some(row => row.owner_id?.toLowerCase() !== ownerId.toLowerCase())) return null;
      const existing = new Map(rows.map(row => [row.key, row]));
      const matches = (key, expected) => expected === null ? !existing.has(key) : existing.get(key)?.revision === expected;
      if (guards.some(item => !matches(item.key, item.revision)) || changes.some(item => !matches(item.key, item.expectedRevision))) return null;
      const result = [];
      for (const item of encoded) {
        const saved = item.expectedRevision === null
          ? await client.query(`INSERT INTO plugin_data (plugin_id, key, owner_id, value) VALUES ($1, $2, $3, $4::jsonb)
              ON CONFLICT (plugin_id, key) DO NOTHING RETURNING key, value`, [pluginId, item.key, ownerId, item.json])
          : await client.query(`UPDATE plugin_data SET value = $4::jsonb, updated_at = NOW()
              WHERE plugin_id = $1 AND key = $2 AND owner_id = $3 AND value->>'revision' = $5 RETURNING key, value`, [pluginId, item.key, ownerId, item.json, item.expectedRevision]);
        if (!saved.rows.length) throw new Conflict();
        result.push(record(saved.rows[0]));
      }
      return result;
    });
  } catch (error) {
    if (error instanceof Conflict) return null;
    throw error;
  }
}
