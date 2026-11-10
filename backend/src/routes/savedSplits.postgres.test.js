import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
import routes from './search.js';
import { putSavedSplits } from './savedSplitsPreferences.js';
import { query } from '../services/db.js';
const splits = [
  { id: 'unread', label: 'Unread', query: 'is:unread' },
  { id: 'all', label: 'All folders', query: 'in:all is:unread' },
  { id: 'exclude', label: 'Not Alice', query: '-from:alice is:unread' },
];
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('saved split PostgreSQL semantics', () => {
  let database, server, base;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await database.connect();
    await database.query(`CREATE TEMP TABLE users (id text PRIMARY KEY, preferences jsonb DEFAULT '{}');
      CREATE TEMP TABLE email_accounts (id text, user_id text, enabled boolean, include_in_unified_inbox boolean, name text, email_address text, color text);
      CREATE TEMP TABLE folders (account_id text, path text, special_use text, name text);
      CREATE TEMP TABLE messages (id text, account_id text DEFAULT 'main', folder text DEFAULT 'INBOX', uid bigint, message_id text, subject text DEFAULT 'Report', from_name text DEFAULT 'Alice', from_email text DEFAULT 'alice@example.test', to_addresses jsonb, cc_addresses jsonb, reply_to jsonb, delivery_addresses jsonb, thread_id text, in_reply_to text, thread_references text, date timestamptz DEFAULT now(), snippet text, is_read boolean DEFAULT false, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false, search_vector tsvector, body_text text);
      INSERT INTO users(id,preferences) VALUES ('owner','{"theme":"dark","snippets":["keep"]}'),('stranger','{"theme":"light"}');
      INSERT INTO email_accounts VALUES ('main','owner',true,true,'Main','owner@example.test',null),('excluded','owner',true,false,'Excluded','excluded@example.test',null),('foreign','stranger',true,true,'Foreign','foreign@example.test',null),('disabled','owner',false,true,'Disabled','disabled@example.test',null);
      INSERT INTO folders VALUES ('main','Trash','\\Trash','Trash');
      INSERT INTO messages(id) VALUES ('inbox-a');
      INSERT INTO messages(id,from_name,from_email) VALUES ('inbox-b','Bob','bob@example.test');
      INSERT INTO messages(id,is_read) VALUES ('read',true);
      INSERT INTO messages(id,is_deleted) VALUES ('deleted',true);
      INSERT INTO messages(id,folder) VALUES ('archive','Archive'),('trash','Trash');
      INSERT INTO messages(id,account_id) VALUES ('opted-out','excluded'),('other-user','foreign'),('disabled','disabled');`);
    await database.query("UPDATE users SET preferences = preferences || $1::jsonb WHERE id = 'owner'", [JSON.stringify({ savedSplits: splits, savedSplitsRevision: 1 })]);
    query.mockImplementation((sql, params) => database.query(sql, params));
    const app = express(); app.use(routes); await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await database?.end(); });
  it('matches counts to actual native search rows, preserving folder, negation, deletion and owner scope', async () => {
    const counts = await (await fetch(`${base}/splits`)).json();
    expect(counts.counts).toEqual({ unread: { total: 2, unread: 2 }, all: { total: 3, unread: 3 }, exclude: { total: 1, unread: 1 } });
    for (const split of splits) {
      const result = await (await fetch(`${base}/?${new URLSearchParams({ q: split.query, folder: 'INBOX' })}`)).json();
      expect(result.messages).toHaveLength(counts.counts[split.id].total);
    }
    const selected = await (await fetch(`${base}/splits?accountId=excluded`)).json();
    expect(selected.counts.unread.total).toBe(1);
  });
  it('accepts only one writer for a revision and preserves concurrent unrelated preference merges', async () => {
    const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }); const first = res(); const second = res();
    const request = savedSplits => ({ session: { userId: 'owner' }, body: { savedSplits, hideEmptySplits: true, savedSplitsRevision: 1 } });
    await Promise.all([
      putSavedSplits(request([splits[0]]), first),
      database.query("UPDATE users SET preferences = preferences || '{\"theme\":\"light\"}'::jsonb WHERE id = 'owner'"),
      putSavedSplits(request([splits[1]]), second),
    ]);
    expect(first.json).toHaveBeenCalledWith({ savedSplits: [splits[0]], hideEmptySplits: true, savedSplitsRevision: 2 });
    expect(second.status).toHaveBeenCalledWith(409);
    const { rows } = await database.query("SELECT preferences FROM users WHERE id='owner'");
    expect(rows[0].preferences).toEqual({ theme: 'light', snippets: ['keep'], savedSplits: [splits[0]], hideEmptySplits: true, savedSplitsRevision: 2 });
    const stranger = await database.query("SELECT preferences FROM users WHERE id='stranger'"); expect(stranger.rows[0].preferences).toEqual({ theme: 'light' });
  });
});
