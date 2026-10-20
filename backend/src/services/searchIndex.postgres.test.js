import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import express from 'express';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
import { query, withTransaction } from './db.js';
import { publishSearchGeneration } from './searchIndex.js';
import routes, { freeTextTermCondition } from '../routes/search.js';
import { MAIL_CACHE_TABLES, unclassifiedTables, writeBackup, restoreBackup } from './backup.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = (n = 1, extra = {}) => ({ id: id(n), uid: n, folder: 'INBOX', uidValidity: '7', ...extra });
const extraction = (texts = ['How are we doing Orion?'], extra = {}) => ({ complete: true,
  identity: { accountId: a, uid: 1, folder: 'INBOX', uidValidity: '7' },
  requiredParts: texts.map((_, i) => String(i + 1)), textParts: texts.map((text, i) => ({ part: String(i + 1), text })), ...extra });

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('verified generation PostgreSQL', () => {
  let db, server, base, backupClient;
  const schema = `search_chunks_${process.pid}`;
  const previousKey = process.env.ENCRYPTION_KEY;
  const publish = (result = extraction(), targets = [target()], accountId = a) =>
    publishSearchGeneration({ accountId, sourceKey: 'opaque:synthetic', targets, extraction: result });
  const search = async (q, extra = {}) => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q, ...extra })}`);
    expect(response.status).toBe(200);
    return (await response.json()).messages.map(m => m.id).sort();
  };
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '39'.repeat(32); // synthetic, test-only key
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    // The backup service catalogs public; point only its catalog queries at the
    // private fixture schema. Data/FK/restore SQL still executes on real PG.
    backupClient = { query: (sql, values) => db.query(typeof sql === 'string'
      ? sql.replaceAll("'public'", `'${schema}'`)
      : { ...sql, text: sql.text.replaceAll("'public'", `'${schema}'`) }, values) };
    query.mockImplementation((sql, values) => db.query(sql, values));
    withTransaction.mockImplementation(async fn => {
      await db.query('BEGIN');
      try { const result = await fn(db); await db.query('COMMIT'); return result; }
      catch (err) { await db.query('ROLLBACK'); throw err; }
    });
    const app = express(); app.use(routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = previousKey;
  });
  beforeEach(async () => {
    await db.query(`SET statement_timeout=0; DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE schema_migrations(version text);
      INSERT INTO schema_migrations VALUES ('0072_verified_search_text');
      CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true, name text, email_address text, color text);
      CREATE TABLE folders (account_id uuid REFERENCES email_accounts ON DELETE CASCADE, path text,
        uid_validity bigint, special_use text, name text, PRIMARY KEY(account_id,path));
      CREATE TABLE messages (id uuid PRIMARY KEY, account_id uuid REFERENCES email_accounts ON DELETE CASCADE,
        uid bigint, folder text DEFAULT 'INBOX', message_id text, subject text, from_name text, from_email text,
        to_addresses jsonb, cc_addresses jsonb, reply_to jsonb, delivery_addresses jsonb, thread_id text,
        in_reply_to text, thread_references text, date timestamptz DEFAULT now(), snippet text,
        is_read boolean, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false,
        search_vector tsvector, body_text text);
      INSERT INTO email_accounts(id,user_id) VALUES ('${a}','owner'),('${b}','stranger');
      INSERT INTO folders VALUES ('${a}','INBOX',7,NULL,'Inbox'),('${a}','Sent',8,NULL,'Sent'),
        ('${a}','Trash',9,'\\Trash','Trash'),('${b}','INBOX',7,NULL,'Inbox');
      INSERT INTO messages(id,account_id,uid,body_text) VALUES ('${id(1)}','${a}',1,'legacyquartz');`);
    await db.query(readFileSync(new URL('../../migrations/0072_verified_search_text.sql', import.meta.url), 'utf8'));
  });

  it('publishes all chunks and multiple physical pointers atomically; replacement retains old until commit', async () => {
    await db.query("INSERT INTO messages(id,account_id,uid,folder) VALUES ($1,$2,2,'Sent')", [id(2), a]);
    const result = await publish(extraction(['firstquartz', 'lastquartz']), [target(), target(2, { folder: 'Sent', uidValidity: '8' })]);
    expect(result.published).toBe(true);
    expect((await db.query('SELECT DISTINCT search_generation_id FROM messages')).rows).toEqual([{ search_generation_id: result.generationId }]);
    // Failure after generation/chunks have been written must roll back the pointer and rows together.
    await db.query(`CREATE FUNCTION reject_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$;
      CREATE TRIGGER reject_pointer BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_pointer();`);
    await expect(publish(extraction(['replacement']))).rejects.toThrow('synthetic interruption');
    expect((await db.query('SELECT count(*)::int AS n FROM search_text_generations')).rows[0].n).toBe(1);
    expect(await search('firstquartz lastquartz')).toEqual([id(1), id(2)]);
    await db.query('DROP TRIGGER reject_pointer ON messages');
    expect((await publish(extraction(['replacement']))).published).toBe(true);
    expect(await search('replacement')).toEqual([id(1)]);
    expect(await search('firstquartz')).toEqual([id(2)]);
  });

  it('rejects typed failures, missing/duplicate parts and unknown completeness without publishing prefixes', async () => {
    for (const result of [extraction([], { complete: false, status: 'retry' }),
      extraction([], { complete: false, status: 'unsupported' }), extraction([], { status: 'cancelled' }),
      extraction([], { complete: undefined }), extraction(['prefix'], { requiredParts: ['1','2'] }),
      extraction(['prefix','other'], { requiredParts: ['1','1'] }),
      extraction(['prefix'], { textParts: [null] })]) {
      expect((await publish(result)).published).toBe(false);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM search_text_generations')).rows[0].n).toBe(0);
    expect(await search('legacyquartz')).toEqual([id(1)]);
    expect((await publish(extraction(['']))).published).toBe(true);
    expect(await search('legacyquartz')).toEqual([]);
  });

  it('runs the optional job guard inside the publication transaction before message locks', async () => {
    const old = await publish(extraction(['oldquartz']));
    await db.query('CREATE TABLE guard_events (event text)');
    const guarded = guard => publishSearchGeneration({ accountId:a, sourceKey:'opaque:guarded',
      targets:[target()], extraction:extraction(['newquartz']), guard });
    const guard = async (client, decision) => {
      expect(client).toBe(db);
      expect((await client.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid()
        AND relation='messages'::regclass AND mode='RowShareLock'`)).rows[0].n).toBe(0);
      await client.query('INSERT INTO guard_events VALUES ($1)', [String(decision)]);
      return decision;
    };
    expect(await guarded(client => guard(client,false))).toEqual({ published:false,status:'stale-job' });
    expect(await search('oldquartz')).toEqual([id(1)]);
    expect((await db.query('SELECT id FROM search_text_generations')).rows).toEqual([{ id:old.generationId }]);
    const next = await guarded(client => guard(client,true));
    expect(next.published).toBe(true);
    expect(await search('newquartz')).toEqual([id(1)]);
    await expect(guarded(async client => {
      await guard(client,true);
      throw new Error('synthetic guard failure');
    })).rejects.toThrow('synthetic guard failure');
    expect((await db.query('SELECT count(*)::int AS n FROM guard_events')).rows[0].n).toBe(2);
    expect((await db.query('SELECT search_generation_id FROM messages')).rows).toEqual([{ search_generation_id:next.generationId }]);
  });

  it('rechecks source and each target account, UID, folder and epoch, including deleted accounts', async () => {
    for (const change of [{ uid: 99 }, { folder: 'Sent' }, { uidValidity: '99' }]) {
      expect((await publish(extraction(), [target(1, change)])).published).toBe(false);
    }
    await db.query('INSERT INTO messages(id,account_id,uid) VALUES ($1,$2,2)', [id(2), b]);
    const result = await publish(extraction(), [target(), target(2)]);
    expect(result.messageIds).toEqual([id(1)]);
    await db.query("UPDATE folders SET uid_validity=10 WHERE account_id=$1 AND path='INBOX'", [a]);
    expect((await publish()).published).toBe(false);
    await db.query('DELETE FROM email_accounts WHERE id=$1', [a]);
    expect((await publish()).published).toBe(false);
    expect((await db.query('SELECT count(*)::int AS n FROM search_text_generations')).rows[0].n).toBe(0);
  });

  it('preserves stable UID/folder locators and clears a deleted generation pointer', async () => {
    for (const sql of ["UPDATE messages SET uid=99", "UPDATE messages SET folder='Sent'", "UPDATE messages SET is_deleted=true"]) {
      await db.query(sql);
      expect((await publish()).published).toBe(false);
      await db.query("UPDATE messages SET uid=1,folder='INBOX',is_deleted=false");
    }
    await publish();
    await db.query('DELETE FROM search_text_generations');
    expect((await db.query('SELECT search_generation_id FROM messages')).rows[0].search_generation_id).toBeNull();
    expect(await search('legacyquartz')).toEqual([id(1)]);
  });

  it('matches separate chunks of one message, stems English, keeps stop words and negates across all chunks', async () => {
    await publish(extraction(['running ' + 'filler '.repeat(6000), 'we Orion forbidden']));
    expect(await search('runs we Orion')).toEqual([id(1)]);
    expect(await search('Orion -we')).toEqual([]);
    expect(await search('Orion -forbidden')).toEqual([]);
    expect(await search('Orion -absentquartz')).toEqual([id(1)]);
    expect(await search('???')).toEqual([]);
    expect(await search('legacyquartz')).toEqual([]);
    await db.query('INSERT INTO messages(id,account_id,uid) VALUES ($1,$2,2)', [id(2), a]);
    await publish(extraction(['separate'], { identity: { accountId:a, uid:2, folder:'INBOX', uidValidity:'7' } }), [target(2)]);
    expect(await search('Orion separate')).toEqual([]);
  });

  it('retains matches past 600k and after an unsupported long token without vector-size failures', async () => {
    const text = Array.from({ length: 100000 }, (_, i) => `q${i.toString(36)}x`).join(' ') + ' beyondquartz';
    expect(text.length).toBeGreaterThan(600000);
    await publish(extraction([text + ' ' + 'z'.repeat(65537) + ' finalquartz']));
    expect(await search('beyondquartz finalquartz')).toEqual([id(1)]);
    expect(await search('zz')).toEqual([]);
    expect((await db.query('SELECT max(char_length(text)) AS n FROM search_text_chunks')).rows[0].n).toBeLessThanOrEqual(32768);
    expect((await db.query("SELECT string_agg(text,'' ORDER BY ordinal) AS text FROM search_text_chunks")).rows[0].text).toBe(text + ' ' + 'z'.repeat(65537) + ' finalquartz');
  }, 30000);

  it('does not manufacture a short lexeme when a long unsupported token follows punctuation', async () => {
    await publish(extraction(['!'.repeat(19998) + 'zz' + 'a'.repeat(20000) + ' latequartz']));
    expect(await search('zz')).toEqual([]);
    expect(await search('latequartz')).toEqual([id(1)]);
  });

  it('retains raw order when canonical vector batches outnumber raw chunks', async () => {
    const text = '中-中 '.repeat(8000);
    await publish(extraction([text]));
    const { rows } = await db.query(`SELECT text,en_tsv::text AS en,simple_tsv::text AS simple
      FROM search_text_chunks ORDER BY ordinal`);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(row => row.text).join('')).toBe(text);
    expect(rows.filter(row => row.text !== '')).toHaveLength(1);
    expect(rows.every(row => row.en && row.simple)).toBe(true);
    expect(await search('中-中')).toEqual([id(1)]);
  });

  it('keeps a supported compound intact at a punctuation-only chunk boundary', async () => {
    await publish(extraction(['a,'.repeat(16381) + 'foo-bar']));
    expect(await search('foo-bar')).toEqual([id(1)]);
  });

  it('agrees with unsplit PostgreSQL for independently generated separators, terms and boundaries', async () => {
    await db.query("SET statement_timeout='60s'");
    let seed = 0x39a7;
    const draw = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const terms = ['foo-bar','name@example.test','https://example.test/path','hello_world','we_are','résumé','quartz'];
    const separators = [',','!','?',';',':','.','/','-','@','_','\t'];
    for (let i = 0; i < 24; i++) {
      const separator = separators[i < separators.length ? i : draw(separators.length)];
      const term = terms[draw(terms.length)], boundary = [1024,32768][draw(2)] + draw(7)-3;
      const text = ('a' + separator).repeat(Math.floor(boundary/2)) + term;
      await publish(extraction([text])).catch(err => { err.message += JSON.stringify({i,separator,term,boundary}); throw err; });
      // '_' is a parser blank; equivalent blanks avoid repeating PostgreSQL's
      // pathological whole-body parse while publication still sees the raw run.
      const oracleText = separator === '_' ? text.replaceAll('_',' ') : text;
      const result = await db.query(`SELECT CASE WHEN numnode(plainto_tsquery('english',$2))>0
          THEN to_tsvector('english',$3) @@ plainto_tsquery('english',$2)
          ELSE to_tsvector('simple',$3) @@ plainto_tsquery('simple',$2) END AS expected,
        coalesce(${freeTextTermCondition(1,2)},false) AS found,
        NOT coalesce(${freeTextTermCondition(1,2)},false) AS absent FROM messages m WHERE id=$4`,
      [`%${term}%`,term,oracleText,id(1)]);
      const detail = JSON.stringify({i,separator,term,boundary});
      expect(result.rows[0].found,detail).toBe(result.rows[0].expected);
      expect(result.rows[0].absent,detail).toBe(!result.rows[0].expected);
    }
  }, 120000);

  it('matches every lexeme of a punctuation term across the same physical message', async () => {
    await publish(extraction(['we running orion ' + 'filler '.repeat(6000), 'are quartz']));
    expect(await search('we_are')).toEqual([id(1)]);
    expect(await search('orion_quartz')).toEqual([id(1)]);
    expect(await search('runs_quartz')).toEqual([id(1)]);
    expect(await search('orion -we_are')).toEqual([]);
    expect(await search('orion -we_absentquartz')).toEqual([id(1)]);
  });

  it('does not invent a searchable suffix from an unsupported overlong hyphen compound', async () => {
    for (const prefix of ['a-'.repeat(16896), 'a'.repeat(32768)+'-']) {
      await publish(extraction([prefix + 'foo-bar latequartz']));
      expect(await search('foo-bar')).toEqual([]);
      expect(await search('foo bar latequartz')).toEqual([id(1)]);
    }
  });

  it('probes canonical compounds and quoted URL lexemes literally', async () => {
    for (const text of ['we-the', "https://example.test/a'b", 'https://example.test/a\\b']) {
      await publish(extraction([text]));
      expect(await search(text),text).toEqual([id(1)]);
      expect(await search('-'+text),text).toEqual([]);
    }
  });

  it('agrees with PostgreSQL Unicode token classes in oversized runs', async () => {
    for (const unit of ['we١','weⅠ','we²','we界','we\u0301']) {
      const text = unit.repeat(12000);
      await publish(extraction([text]));
      const result = await db.query(`SELECT to_tsvector('simple',$3) @@ plainto_tsquery('simple',$2) AS expected,
        coalesce(${freeTextTermCondition(1,2)},false) AS found FROM messages m WHERE id=$4`,
      ['%we%','we',text,id(1)]);
      expect(result.rows[0].found,unit).toBe(result.rows[0].expected);
    }
  }, 30000);

  it('uses only published generations and preserves authorization and explicit folder scope', async () => {
    await publish();
    await db.query("INSERT INTO search_text_generations(account_id,source_key) VALUES ($1,'unpublished')", [a]);
    await db.query("INSERT INTO messages(id,account_id,uid,folder) VALUES ($2,$1,2,'Trash'),($3,$4,3,'INBOX')", [a, id(2), id(3), b]);
    await db.query(`INSERT INTO search_text_chunks(generation_id,ordinal,text,en_tsv,simple_tsv)
      SELECT id,0,'hiddenquartz',to_tsvector('english','hiddenquartz'),to_tsvector('simple','hiddenquartz') FROM search_text_generations WHERE source_key='unpublished'`);
    await publish(extraction(['Orion foreignsecret'], { identity: { accountId:b, uid:3, folder:'INBOX', uidValidity:'7' } }), [target(3)], b);
    expect(await search('foreignsecret')).toEqual([]);
    expect(await search('hiddenquartz')).toEqual([]);
    expect(await search('Orion', { accountId: b })).toEqual([id(1)]); // existing unauthorized account fallback
    await db.query("UPDATE messages SET folder='Trash' WHERE id=$1", [id(1)]);
    expect(await search('Orion')).toEqual([]);
    expect(await search('Orion', { folder: 'Trash' })).toEqual([id(1)]);
  });

  it('agrees with generated literal token membership and its complement on verified rows', async () => {
    let seed = 0x7a39;
    const draw = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const words = ['we','the','orion','quartz','candy'];
    for (let i = 0; i < 40; i++) {
      const tokens = Array.from({ length: draw(30) }, () => words[draw(words.length)]);
      const term = words[draw(words.length)];
      await publish(extraction([tokens.slice(0, 10).join(' '), tokens.slice(10).join(' ')]));
      const result = await db.query(`SELECT coalesce(${freeTextTermCondition(1, 2)},false) AS found,
        NOT coalesce(${freeTextTermCondition(1, 2)},false) AS absent FROM messages m WHERE id=$3`,
        [`%${term}%`, term, id(1)]);
      expect(result.rows[0].found, JSON.stringify({tokens,term})).toBe(tokens.includes(term));
      expect(result.rows[0].absent).toBe(!tokens.includes(term));
    }
  });

  it('preserves native scientific-number suffixes and XML tag state across raw chunk boundaries', async () => {
    for (const [text, term] of [
      ['1e' + '0'.repeat(32768) + 'quartz', 'quartz'],
      ['x '.repeat(16382) + '<t title="hiddenquartz">visible</t>', 'hiddenquartz'],
      ['x '.repeat(16380) + '<t title="we_are">visible</t>', 'we_are'],
      ['x '.repeat(16383) + "<t title='hiddenquartz'>visible</t>", 'visible'],
      ['x '.repeat(16382) + '<!-- hiddenquartz --> visible', 'hiddenquartz'],
      ['x '.repeat(16382) + '<t title="hello_world">visible</t>', 'hello_world'],
    ]) {
      await publish(extraction([text]));
      const { rows } = await db.query(`SELECT CASE WHEN numnode(plainto_tsquery('english',$2))>0
        THEN to_tsvector('english',$1) @@ plainto_tsquery('english',$2)
        ELSE to_tsvector('simple',$1) @@ plainto_tsquery('simple',$2) END AS found`, [text,term]);
      expect.soft(await search(term), JSON.stringify({term,length:text.length})).toEqual(rows[0].found ? [id(1)] : []);
      expect.soft(await search('-'+term)).toEqual(rows[0].found ? [] : [id(1)]);
      expect((await db.query("SELECT string_agg(text,'' ORDER BY ordinal) AS text FROM search_text_chunks WHERE generation_id=(SELECT search_generation_id FROM messages WHERE id=$1)", [id(1)])).rows[0].text).toBe(text);
    }
  }, 30000);

  it('classifies both tables and roundtrips grouped generations/chunks/pointers through full and setup restore', async () => {
    await db.query('INSERT INTO messages(id,account_id,uid) VALUES ($1,$2,2)', [id(2), a]);
    await publish(extraction(['restoredquartz']), [target(), target(2)]);
    expect(MAIL_CACHE_TABLES).toEqual(expect.arrayContaining(['search_text_generations','search_text_chunks']));
    expect(await unclassifiedTables(backupClient)).toEqual([]);
    for (const scope of ['full','setup']) {
      const out = new PassThrough(), parts = [];
      out.on('data', part => parts.push(part));
      await writeBackup(backupClient, { scope, appVersion: '4.0.3', out });
      const bytes = Buffer.concat(parts), manifest = JSON.parse(gunzipSync(bytes).toString().split('\n')[0]);
      if (scope === 'full') expect(manifest.tables.indexOf('search_text_generations')).toBeLessThan(manifest.tables.indexOf('messages'));
      else expect(manifest.tables).not.toContain('search_text_generations');
      await restoreBackup(backupClient, Readable.from([bytes]));
      expect(await search('restoredquartz')).toEqual(scope === 'full' ? [id(1),id(2)] : []);
      expect((await db.query('SELECT count(*)::int AS n FROM search_text_chunks')).rows[0].n).toBe(scope === 'full' ? 1 : 0);
      expect((await db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(2);
    }
  });

  it('measures bounded chunk GIN size/write cost and explains the actual authorized route', async () => {
    const started = performance.now();
    await db.query(`INSERT INTO search_text_generations(id,account_id,source_key)
      SELECT ('00000000-0000-4000-9000-' || lpad(i::text,12,'0'))::uuid,$1,'fixture:' || i
      FROM generate_series(1,2000) i`, [a]);
    await db.query(`INSERT INTO search_text_chunks(generation_id,ordinal,text,en_tsv,simple_tsv)
      SELECT id,n,text,to_tsvector('english',text),to_tsvector('simple',text) FROM (
        SELECT id,n,repeat('the we running ordinary ',20) || source_key ||
          CASE WHEN source_key='fixture:1000' AND n=2 THEN ' rarequartz' ELSE '' END AS text
        FROM search_text_generations CROSS JOIN generate_series(0,2) n) fixture`);
    const writeMs = performance.now() - started;
    await db.query(`INSERT INTO messages(id,account_id,uid,search_generation_id)
      SELECT id,account_id,10000+row_number() OVER (),id FROM search_text_generations;
      CREATE INDEX ON messages(date DESC,account_id,id);
      ANALYZE messages; ANALYZE search_text_chunks;`);
    const plans = {};
    for (const [dictionary, column, term] of [['english','en_tsv','rarequartz'],['simple','simple_tsv','fixture:1000']]) {
      const result = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT generation_id FROM search_text_chunks WHERE ${column} @@ plainto_tsquery('${dictionary}',$1)`, [term]);
      plans[dictionary] = result.rows[0]['QUERY PLAN'][0];
    }
    plans.pointer = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM messages WHERE search_generation_id=$1`, ['00000000-0000-4000-9000-000000001000']))
      .rows[0]['QUERY PLAN'][0];
    const usesPointerIndex = plan => String(plan['Index Cond'] || '').includes('search_generation_id') ||
      (plan.Plans || []).some(usesPointerIndex);
    expect(usesPointerIndex(plans.pointer.Plan)).toBe(true);
    query.mockClear();
    expect(await search('rarequartz', { cursor: '' })).toHaveLength(1);
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes('m.date IS NOT NULL'));
    plans.route = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'][0];
    const sizes = (await db.query(`SELECT pg_relation_size('idx_search_chunks_english')::int AS english,
      pg_relation_size('idx_search_chunks_simple')::int AS simple`)).rows[0];
    // Bounded diagnostics are separate from full-scale API/UI acceptance.
    console.info('CHUNK_PLAN_DIAGNOSTIC', JSON.stringify({ messages:2001, chunks:6000, writeMs, sizes, plans }));
    expect(sizes.english).toBeGreaterThan(0);
    expect(sizes.simple).toBeGreaterThan(0);
  }, 30000);

});
