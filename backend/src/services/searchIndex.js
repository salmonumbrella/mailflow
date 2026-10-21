import { withTransaction } from './db.js';

const CHUNK_CHARS = 32768;

/** Retain raw text in bounded chunks, keeping ordinary token boundaries intact.
 * Search vectors are projected from the whole source independently: parser state
 * (for example XML tags) can span whitespace and raw storage boundaries. */
export function chunkSearchText(text) {
  const chunks = [];
  let chunk = '';
  const flush = () => { if (chunk) chunks.push({ text:chunk }); chunk = ''; };
  for (const [token] of text.matchAll(/\s+|\S+/gu)) {
    if (token.length <= CHUNK_CHARS) {
      if (chunk.length + token.length > CHUNK_CHARS) flush();
      chunk += token;
      continue;
    }
    flush();
    for (let start = 0; start < token.length;) {
      const remaining = token.length-start;
      let end = start + Math.ceil(remaining/Math.ceil(remaining/CHUNK_CHARS));
      if (end < token.length && /[\uD800-\uDBFF]/u.test(token[end-1]) && /[\uDC00-\uDFFF]/u.test(token[end])) end--;
      chunks.push({ text:token.slice(start,end) });
      start = end;
    }
  }
  flush();
  return chunks;
}

/** Attach one verified extraction to unchanged physical rows. sourceKey is
 * opaque to this layer; the worker owns identity grouping, retries and GC.
 * No generation or pointer is committed on a partial extraction or stale source.
 * An optional guard locks/rechecks worker state first, in this same transaction.
 */
export async function publishSearchGeneration({ accountId, sourceKey, targets, extraction, guard }) {
  const reject = status => ({ published: false, status });
  const { identity, requiredParts, textParts } = extraction || {};
  if (extraction?.status && extraction.status !== 'complete') return reject(extraction.status);
  if (extraction?.complete !== true || !identity || identity.accountId !== accountId ||
      !identity.uidValidity || !Array.isArray(requiredParts) || !Array.isArray(textParts) ||
      new Set(requiredParts).size !== requiredParts.length || textParts.length !== requiredParts.length ||
      requiredParts.some(part => textParts.filter(p => p?.part === part && typeof p.text === 'string').length !== 1)) {
    return reject('incomplete');
  }
  const text = textParts.map(p => p.text).join('\n');
  const chunks = chunkSearchText(text);
  return withTransaction(async client => {
    if (guard !== undefined && await guard(client) !== true) return reject('stale-job');
    // UIDVALIDITY lives on folders. Lock both the folder epoch and message
    // locator through COMMIT so rollover/relocation cannot race publication.
    const { rows } = await client.query(`
      SELECT m.id, m.uid::text, m.folder, f.uid_validity::text AS epoch
      FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
      JOIN jsonb_to_recordset($2::jsonb) AS t(id uuid, uid bigint, folder text, "uidValidity" bigint)
        ON m.id=t.id AND m.uid=t.uid AND m.folder=t.folder AND f.uid_validity=t."uidValidity"
      WHERE m.account_id=$1 AND m.is_deleted=false
      ORDER BY m.id FOR UPDATE OF m FOR SHARE OF f`, [accountId, JSON.stringify(targets)]);
    if (!rows.some(row => row.uid === String(identity.uid) && row.folder === identity.folder && row.epoch === String(identity.uidValidity))) {
      return reject('stale-identity');
    }
    const { rows: generations } = await client.query(
      'INSERT INTO search_text_generations(account_id,source_key) VALUES ($1,$2) RETURNING id', [accountId, sourceKey]);
    const generationId = generations[0].id;
    // Parse the whole source with PostgreSQL's native dictionaries so storage
    // cuts cannot invent or drop lexemes. Bound each canonical vector batch to
    // below256KiB; no positions are needed for unranked AND membership queries.
    // PostgreSQL itself ignores source tokens and lexemes exceeding2047bytes.
    await client.query(`WITH raw AS (
        SELECT (ordinality-1)::int AS ordinal, c->>'text' AS text
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS chunks(c,ordinality)
      ), lexemes AS (
        SELECT d.config, p.ordinality AS position, l.lexeme
        FROM (VALUES ('english'),('simple')) d(config)
        CROSS JOIN LATERAL ts_debug(d.config::regconfig,$3) WITH ORDINALITY p
        CROSS JOIN LATERAL unnest(p.lexemes) l(lexeme)
        WHERE octet_length(p.token)<=2047 AND octet_length(l.lexeme)<=2047
      ), batches AS (
        SELECT *, ((sum(octet_length(lexeme)+8) OVER (
          PARTITION BY config ORDER BY position,lexeme ROWS UNBOUNDED PRECEDING)-1)/262144)::int AS batch
        FROM lexemes
      ), vectors AS (
        SELECT batch,
          array_to_tsvector(coalesce(array_agg(lexeme) FILTER (WHERE config='english'),ARRAY[]::text[])) AS en,
          array_to_tsvector(coalesce(array_agg(lexeme) FILTER (WHERE config='simple'),ARRAY[]::text[])) AS simple
        FROM batches GROUP BY batch
      )
      INSERT INTO search_text_chunks(generation_id,ordinal,text,en_tsv,simple_tsv)
      SELECT $1, coalesce(r.ordinal,v.batch),coalesce(r.text,''),
        coalesce(v.en,''::tsvector),coalesce(v.simple,''::tsvector)
      FROM raw r FULL JOIN vectors v ON r.ordinal=v.batch`, [generationId, JSON.stringify(chunks), text]);
    const messageIds = [...new Set(rows.map(row => row.id))];
    await client.query('UPDATE messages SET search_generation_id=$1 WHERE id=ANY($2::uuid[])', [generationId, messageIds]);
    return { published: true, generationId, messageIds };
  });
}
