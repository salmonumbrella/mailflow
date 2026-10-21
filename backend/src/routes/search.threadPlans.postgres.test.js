import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
import routes from './search.js';
import { query } from '../services/db.js';

const start = 'AND NOT EXISTS (\n          SELECT 1 FROM messages s';
const end = '\n          LIMIT 1\n        )\n        ORDER BY';
const scalarStart = 'AND (\n          SELECT s.id FROM messages s';
const scalarEnd = '\n          ORDER BY s.date DESC NULLS LAST, s.id LIMIT 1\n        ) IS NULL\n        ORDER BY';
function existsProbe(sql) {
  expect(sql.split(scalarStart)).toHaveLength(2);
  expect(sql.split(scalarEnd)).toHaveLength(2);
  const exists = sql.replace(scalarStart, start).replace(scalarEnd, end);
  expect(exists.split(start)).toHaveLength(2);
  expect(exists.split(end)).toHaveLength(2);
  expect(exists.replace(start, scalarStart).replace(end, scalarEnd)).toBe(sql);
  return exists;
}
function passThrough(plan) {
  while (plan && ['Result', 'Subquery Scan'].includes(plan['Node Type'])) {
    if (plan.Plans?.length !== 1) return null;
    [plan] = plan.Plans;
  }
  return plan;
}
function folderPolicyProbe(plan) {
  const node = passThrough(plan);
  if (node?.['Node Type'] === 'Materialize') {
    return node.Plans?.length === 1 && folderPolicyProbe(node.Plans[0]);
  }
  return node?.['Relation Name'] === 'folders' &&
    ['Seq Scan', 'Index Scan', 'Index Only Scan'].includes(node['Node Type']) && !node.Plans?.length;
}
function siblingScan(plan) {
  const node = passThrough(plan);
  if (node?.['Node Type'] === 'Nested Loop' && node['Join Type'] === 'Anti') {
    const outer = (node.Plans || []).filter(child => child['Parent Relationship'] === 'Outer');
    const inner = (node.Plans || []).filter(child => child['Parent Relationship'] === 'Inner');
    if (node.Plans?.length !== 2 || outer.length !== 1 || inner.length !== 1 || !folderPolicyProbe(inner[0])) return null;
    return siblingScan(outer[0]); // The folders-only probe preserves its ordered outer stream.
  }
  return node;
}
function orderedSiblingScan(plan, parameterized = false) {
  const scan = siblingScan(plan);
  const condition = scan?.['Index Cond'] || '';
  return scan?.Alias === 's' && scan['Relation Name'] === 'messages' &&
    ['Index Scan', 'Index Only Scan'].includes(scan['Node Type']) &&
    scan['Index Name'] === 'idx_messages_search_thread_order' &&
    /\baccount_id\b/.test(condition) && /\bthread_key\b/.test(condition) &&
    (!parameterized || /\bm\./.test(condition));
}
function siblingAccess(plan, result = { ordered: false, sequential: false, scans: [] }) {
  if (plan.Alias === 's' && plan['Relation Name'] === 'messages') {
    if (plan['Node Type'] === 'Seq Scan') result.sequential = true;
    result.scans.push({ node: plan['Node Type'], index: plan['Index Name'], indexCond: plan['Index Cond'],
      loops: plan['Actual Loops'], rows: plan['Actual Rows'], rowsRemoved: plan['Rows Removed by Filter'] });
  }
  // Only the named scalar subplan's Limit counts; the outer page Limit cannot.
  const subplan = /^SubPlan\b/.test(plan['Subplan Name'] || '') ? passThrough(plan) : null;
  if (subplan?.['Node Type'] === 'Limit' && subplan.Plans?.length === 1 &&
      orderedSiblingScan(subplan.Plans[0])) result.ordered = true;
  // EXISTS may become an anti join and lose its redundant constant LIMIT.
  // Its inner scan must stay parameterized by the actual route's outer alias m.
  if (plan['Node Type'] === 'Nested Loop' && plan['Join Type'] === 'Anti') {
    const inner = (plan.Plans || []).filter(child => child['Parent Relationship'] === 'Inner');
    if (inner.length === 1 && orderedSiblingScan(inner[0], true)) result.ordered = true;
  }
  for (const child of plan.Plans || []) siblingAccess(child, result);
  return result;
}

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('grouped search ordered sibling plans', () => {
  let db, server, base, form, captured, fixtureKind;
  const boundMs = 6000;
  const log = record => process.stdout.write(JSON.stringify(record) + '\n');
  const cancelledPlan = async (entry, phase) => {
    Object.assign(entry, { timedOut: true, boundMs, phase });
    log({ nb4: 'statement-timeout', kind: fixtureKind, variant: form, timedOut: true, boundMs, phase });
    const result = await db.query('EXPLAIN (FORMAT JSON) ' + entry.sql, entry.values);
    entry.plan = result.rows[0]['QUERY PLAN'][0];
    return entry.plan;
  };
  const schema = `mf_search_${randomUUID().replaceAll('-', '')}`;
  const account = '11111111-1111-4111-8111-111111111111';
  const generation = '22222222-2222-4222-8222-222222222222';
  const migration = new URL('../../migrations/0077_search_thread_order.sql', import.meta.url);
  const applyIndex = async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql.split('\n')[0]).toBe('-- no-transaction');
    // Match the existing loader's nontransactional statement handling exactly.
    const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) await db.query(statement);
    await db.query('ANALYZE messages');
  };
  const load = async kind => {
    await db.query('TRUNCATE messages, search_text_chunks, search_text_generations CASCADE');
    await db.query(`INSERT INTO messages(id,account_id,thread_id,date,body_text,from_email)
      SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,$1,'T',
        TIMESTAMPTZ '2026-01-01' + i * interval '1 second',
        CASE WHEN $2='common' OR ($2='old' AND i=1) THEN 'orchid' ELSE 'granite' END,
        'sender@synthetic.test' FROM generate_series(1,5000) i`, [account, kind]);
    if (kind === 'chunk') {
      await db.query("INSERT INTO search_text_generations(id,account_id,source_key) VALUES ($1,$2,'synthetic')", [generation, account]);
      await db.query("INSERT INTO search_text_chunks VALUES ($1,0,'orchid',to_tsvector('english','orchid'),to_tsvector('simple','orchid'))", [generation]);
      await db.query('UPDATE messages SET search_generation_id=$1', [generation]);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(5000);
    await db.query('ANALYZE messages'); await db.query('ANALYZE search_text_chunks');
  };
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    const bounds = (await db.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('application_name') AS application")).rows[0];
    expect(bounds.statement).toBe('6s');
    expect(bounds.lock).toBe('5s');
    expect(bounds.application).toMatch(/^nb4-/);
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE email_accounts (id uuid PRIMARY KEY,user_id text,enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true,name text,email_address text,color text);
      CREATE TABLE folders (account_id uuid,path text,special_use text,name text);
      CREATE TABLE messages (id uuid PRIMARY KEY,account_id uuid,uid bigint,folder text DEFAULT 'INBOX',
        message_id text,subject text,from_name text,from_email text,to_addresses jsonb,cc_addresses jsonb,
        in_reply_to text,thread_references text,thread_id text,reply_to jsonb,delivery_addresses jsonb,
        thread_key text GENERATED ALWAYS AS(COALESCE(thread_id,id::text)) STORED,date timestamptz,
        snippet text,body_text text,search_vector tsvector,is_read boolean DEFAULT false,is_starred boolean,
        has_attachments boolean,is_deleted boolean DEFAULT false);
      CREATE INDEX idx_messages_thread_key_lookup ON messages(account_id,thread_key) WHERE is_deleted=false;`);
    await db.query(await readFile(new URL('../../migrations/0072_verified_search_text.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../migrations/0073_search_change_fence.sql', import.meta.url), 'utf8'));
    await db.query("INSERT INTO email_accounts(id,user_id) VALUES ($1,'owner')", [account]);
    const settings = await db.query(`SELECT version(),current_setting('enable_seqscan') AS enable_seqscan,
      current_setting('enable_indexscan') AS enable_indexscan,current_setting('enable_bitmapscan') AS enable_bitmapscan,
      current_setting('random_page_cost') AS random_page_cost,current_setting('seq_page_cost') AS seq_page_cost,
      current_setting('work_mem') AS work_mem,current_setting('max_parallel_workers_per_gather') AS parallel_workers,
      current_setting('jit') AS jit`);
    log({ nb4: 'server-settings', ...settings.rows[0], bounds });
    query.mockImplementation(async (sql, values) => {
      if (sql.includes(scalarStart)) {
        const executed = form === 'exists' ? existsProbe(sql) : sql;
        const entry = { sql: executed, values: [...values] };
        captured.push(entry);
        const begin = performance.now();
        try {
          return await db.query(executed, values);
        } catch (error) {
          if (error.code === '57014') await cancelledPlan(entry, 'request');
          throw error;
        } finally { entry.queryMs = performance.now() - begin; }
      }
      return db.query(sql, values);
    });
    const app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });

  it.each(['common', 'old', 'chunk'])('compares exact cap50 route rows, cursors and plans on 5000 %s messages', async kind => {
    fixtureKind = kind;
    await load(kind); await applyIndex();
    const responses = [], gates = [], timedOut = [];
    for (const variant of ['exists', 'scalar']) {
      form = variant; captured = [];
      const begin = performance.now();
      const response = await fetch(`${base}/?q=orchid&threaded=true&limit=50&cursor=`);
      const body = await response.json(); const requestMs = performance.now() - begin;
      const cancelled = captured.find(call => call.timedOut);
      if (cancelled) {
        expect(response.status).toBe(500); // Only the recorded 57014 classifies a timeout.
        responses.push(null);
      } else {
        expect(response.status).toBe(200); expect(body.messages).toHaveLength(1);
        expect(body.messages[0].id).toBe(`00000000-0000-4000-8000-${kind === 'old' ? '000000000001' : '000000005000'}`);
        responses.push(body); expect(captured).toHaveLength(2);
      }
      const dated = cancelled || captured[0];
      let plan = cancelled?.plan;
      if (!cancelled) {
        try {
          const explain = await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + dated.sql, dated.values);
          plan = explain.rows[0]['QUERY PLAN'][0];
        } catch (error) {
          if (error.code !== '57014') throw error;
          plan = await cancelledPlan(dated, 'analyze');
        }
      }
      const access = siblingAccess(plan.Plan);
      timedOut.push(Boolean(dated.timedOut));
      gates.push(!dated.timedOut && access.ordered && !access.sequential);
      log({ nb4: kind, variant, rows: 5000, cap: 50, requestMs, timedOut: Boolean(dated.timedOut),
        boundMs, queryMs: captured.map(call => call.queryMs),
        oldMatchBound: kind === 'old' ? '4999 newer nonmatches; O(thread)' : null,
        eligible: gates.at(-1), access, sql: dated.sql, values: dated.values, plan });
    }
    expect(responses.some(Boolean)).toBe(true);
    if (responses.every(Boolean)) expect(responses[1]).toEqual(responses[0]); // Whole-body parity.
    else expect(responses.some((body, i) => body && gates[i])).toBe(true);
    if (kind !== 'old' || timedOut.some(Boolean)) expect(gates.some(Boolean)).toBe(true);
    log({ nb4: 'eligible-forms', kind,
      forms: ['exists', 'scalar'].filter((_variant, i) => gates[i]),
      parity: responses.every(Boolean) ? 'equal' : 'one request cancelled; other expected representative and plan verified' });
  }, 25000);

  it('recovers an INVALID concurrent build and a valid but unrecorded build using actual0077', async () => {
    await load('common'); await db.query('DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_thread_order');
    await expect(db.query('CREATE UNIQUE INDEX CONCURRENTLY idx_messages_search_thread_order ON messages(account_id)'))
      .rejects.toMatchObject({ code: '23505' });
    const state = () => db.query(`SELECT indexrelid::oid::text AS oid,indisvalid,indisready,pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indexrelid=to_regclass('idx_messages_search_thread_order')`);
    expect((await state()).rows[0].indisvalid).toBe(false);
    await applyIndex(); const first = (await state()).rows[0];
    expect(first).toMatchObject({ indisvalid: true, indisready: true });
    expect(first.definition).toContain('(account_id, thread_key, date DESC NULLS LAST, id)');
    expect(first.definition).toContain('WHERE (is_deleted = false)');
    await applyIndex(); const reapplied = (await state()).rows[0];
    expect(reapplied).toMatchObject({ indisvalid: true, indisready: true, definition: first.definition });
    expect(reapplied.oid).not.toBe(first.oid);
    log({ nb4: 'index-recovery', invalidRecovered: true, validReapply: true,
      firstOid: first.oid, reappliedOid: reapplied.oid });
  }, 25000);
});
