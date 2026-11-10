import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { installNativeLabelReadFixture, fixtureId, fixtureName } from '../services/testSupport/nativeLabelReadFixture.js';
import express from 'express';
import { buildSearchConditions } from '../services/searchConditions.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'size-owner' }; next(); } }));
import routes from './search.js';
import { query } from '../services/db.js';

// CI supplies a disposable PostgreSQL 16 database. Temporary tables never alter
// persistent mail, and assertions execute the actual route/compiler SQL.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('size search PostgreSQL', () => {
  let database, server, base;
  async function search(q, scope = {}) {
    if (scope.accountId) scope = { ...scope, accountId: fixtureId(scope.accountId) };
    const response = await fetch(`${base}/?${new URLSearchParams({ q, ...scope })}`);
    expect(response.status).toBe(200);
    const data = await response.json();
    for (const message of data.messages) expect(message).toMatchObject({ nativeLabelState: 'unavailable', nativeLabels: null, entityId: null, metadataVersion: null, storageGeneration: expect.any(String) });
    return { ids: data.messages.map(m => fixtureName(m.id)).sort(), sizeIndex: data.sizeIndex };
  }
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text, folder_mappings jsonb DEFAULT '{}');
      CREATE TEMP TABLE folders (account_id uuid, path text, special_use text, name text);
      CREATE TEMP TABLE messages (id uuid, account_id uuid DEFAULT '${fixtureId('main')}', folder text DEFAULT 'INBOX',
        uid bigint, message_id text, subject text, from_name text, from_email text,
        to_addresses jsonb, cc_addresses jsonb, reply_to jsonb, delivery_addresses jsonb, thread_id text,
        in_reply_to text, thread_references text, date timestamptz DEFAULT '2026-11-10', snippet text,
        is_read boolean, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false,
        search_vector tsvector, body_text text, category text, attachments jsonb DEFAULT '[]', rfc822_size_bytes bigint);
      INSERT INTO email_accounts(id,user_id,enabled,include_in_unified_inbox) VALUES
        ('${fixtureId('main')}','size-owner',true,true), ('${fixtureId('other')}','stranger',true,true),
        ('${fixtureId('excluded')}','size-owner',true,false), ('${fixtureId('disabled')}','size-owner',false,true);
      INSERT INTO folders VALUES ('${fixtureId('main')}','Trash','\\Trash','Trash');
      INSERT INTO messages(id,rfc822_size_bytes) VALUES ('${fixtureId('unknown')}',NULL), ('${fixtureId('zero')}',0), ('${fixtureId('below')}',999), ('${fixtureId('equal')}',1000), ('${fixtureId('above')}',1001), ('${fixtureId('maximum')}',9007199254740991);
      INSERT INTO messages(id,rfc822_size_bytes,subject) VALUES ('${fixtureId('unknown-true')}',NULL,'invoice');
      INSERT INTO messages(id,account_id,rfc822_size_bytes) VALUES ('${fixtureId('foreign')}','${fixtureId('other')}',2000), ('${fixtureId('opted-out')}','${fixtureId('excluded')}',2000), ('${fixtureId('disabled')}','${fixtureId('disabled')}',2000);
      INSERT INTO messages(id,folder,rfc822_size_bytes) VALUES ('${fixtureId('trash')}','Trash',2000), ('${fixtureId('archive')}','Archive',2000);
      INSERT INTO messages(id,is_deleted,rfc822_size_bytes) VALUES ('${fixtureId('deleted')}',true,2000);
    `);
    await installNativeLabelReadFixture(database);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express(); app.use(routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await database?.end(); });

  it('uses strict bounds, preserves valid zero, and excludes unknowns under positive and negative size predicates', async () => {
    expect((await search('larger:1000', { folder: 'INBOX' })).ids).toEqual(['above', 'maximum']);
    expect((await search('size:1000', { folder: 'INBOX' })).ids).toEqual(['above', 'maximum']);
    expect((await search('smaller:1000')).ids).toEqual(['below', 'zero']);
    expect((await search('-larger:1000')).ids).toEqual(['below', 'equal', 'zero']);
    expect((await search('smaller:1')).ids).toEqual(['zero']);
    expect((await search('smaller:0')).ids).toEqual([]);
    expect((await search('larger:9007199254740991')).ids).toEqual([]);
    expect((await search('larger:999 smaller:1001')).ids).toEqual(['equal']);
  });
  it('lets independently true OR branches match unknown sizes without widening negations', async () => {
    expect((await search('larger:1000 OR subject:invoice', { folder: 'INBOX' })).ids).toEqual(['above', 'maximum', 'unknown-true']);
    expect((await search('-(larger:1000 OR subject:invoice)')).ids).toEqual(['below', 'equal', 'zero']);
    expect((await search('-(-larger:1000)', { folder: 'INBOX' })).ids).toEqual(['above', 'maximum']);
    expect((await search('-(larger:1000 AND subject:invoice)', { folder: 'INBOX' })).ids).toEqual(['above', 'below', 'equal', 'maximum', 'unknown', 'zero']);
  });
  it('keeps ownership, unified opt-outs, deletion and trash boundaries intact', async () => {
    expect((await search('larger:1000', { accountId: 'other' })).ids).toEqual(['above', 'archive', 'maximum']);
    expect((await search('larger:1000', { accountId: 'excluded' })).ids).toEqual(['opted-out']);
    expect((await search('(in:trash size:1000) OR (in:inbox smaller:1)')).ids).toEqual(['trash', 'zero']);
  });
  it('reports unknowns in authorized cache scope even when no messages match', async () => {
    const empty = await search('larger:9007199254740991', { folder: 'INBOX' });
    expect(empty.ids).toEqual([]);
    expect(empty.sizeIndex).toEqual({ state: 'partial', scope: 'selected-folder-synchronized-cache', providerComplete: false });
    expect((await search('size:0', { folder: 'Archive' })).sizeIndex.state).toBe('complete-for-cache');
    expect((await search('size:0', { accountId: 'excluded' })).sizeIndex.state).toBe('complete-for-cache');
  });
  it('evaluates the complete three-valued truth table for nested NOT, OR and AND', async () => {
    const queries = [
      ['larger:1000', [null, false, false, true]],
      ['-larger:1000', [null, true, true, false]],
      ['-(-larger:1000)', [null, false, false, true]],
      ['larger:1000 OR subject:invoice', [true, true, true, true]],
      ['larger:1000 AND subject:invoice', [null, false, false, true]],
      ['-(larger:1000 OR subject:missing)', [null, true, true, false]],
      ['-(larger:1000 AND subject:missing)', [true, true, true, true]],
    ];
    for (const [raw, expected] of queries) {
      const compiled = buildSearchConditions(raw, { firstParam: 1 });
      const result = await database.query(`SELECT ${compiled.conditions[0]} AS matched FROM
        (VALUES (0,NULL::bigint), (1,0), (2,1000), (3,1001)) sizes(ord,rfc822_size_bytes)
        CROSS JOIN LATERAL (SELECT sizes.rfc822_size_bytes, 'invoice'::text AS subject) m ORDER BY sizes.ord`, compiled.params);
      expect(result.rows.map(row => row.matched), raw).toEqual(expected);
    }
  });
});
