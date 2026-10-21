import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import routes from './mail.js';
import { query } from '../services/db.js';

// Unrun RED proposal. Requires the named final context+0069/0070+d143 source
// composition and a separately reviewed/granted synthetic task-DB runner.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('search physical context PostgreSQL', () => {
  let db, server, base;
  const schema = `mf_search_${randomUUID().replaceAll('-', '')}`;
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const request = async (extra = {}, status = 200) => {
    const response = await fetch(`${base}/thread?${new URLSearchParams({ id: JSON.stringify([a, 'T']),
      q: 'Nana', matchedMessageId: id(1), ...extra })}`);
    expect(response.status).toBe(status);
    return response.json();
  };
  const insert = async (n, folder = 'INBOX', { account = a, thread = 'T', provider = null, date = '2026-10-20' } = {}) => {
    await db.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,thread_id,date,from_email,provider_msgid)
      VALUES ($1,$2,$3,$4,'<repeated@synthetic.test>',$5,$6,'author@synthetic.test',$7)`,
    [id(n), account, n, folder, thread, date, provider]);
  };
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE email_accounts(id uuid PRIMARY KEY,user_id text,enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true,folder_mappings jsonb,imap_host text DEFAULT 'imap.gmail.com',
        oauth_provider text,name text,email_address text,color text);
      CREATE TABLE folders(account_id uuid,path text,name text,delimiter text DEFAULT '/',special_use text,
        no_select boolean DEFAULT false,uid_validity bigint DEFAULT 1);
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts(id),uid bigint,folder text,
        message_id text,thread_id text,thread_key text GENERATED ALWAYS AS (COALESCE(thread_id,id::text)) STORED,
        subject text,from_name text,from_email text,to_addresses jsonb,cc_addresses jsonb,reply_to jsonb,
        in_reply_to text,thread_references text,date timestamptz,snippet text,is_read boolean,is_starred boolean,
        has_attachments boolean,is_deleted boolean DEFAULT false,category text,list_unsubscribe text,
        list_unsubscribe_post text,unsubscribed_at timestamptz,delivery_addresses jsonb,flags jsonb);`);
    // Real accepted identity schema, not invented substitute provider fields.
    await db.query(await readFile(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8'));
    const indexSql = await readFile(new URL('../../migrations/0070_archive_identity_indexes.sql', import.meta.url), 'utf8');
    for (const sql of indexSql.replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean)) await db.query(sql);
    query.mockImplementation((sql, values) => db.query(sql, values));
    const app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); }); base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });
  beforeEach(async () => {
    await db.query('TRUNCATE email_accounts,messages,folders,archive_coverage,background_download_debits CASCADE');
    await db.query("INSERT INTO email_accounts(id,user_id) VALUES ($1,'owner'),($2,'other')", [a,b]);
    for (const [path, role] of [['INBOX', null], ['Sent', '\\Sent'], ['All', '\\All'], ['Trash', '\\Trash'], ['Spam', '\\Junk']]) {
      await db.query('INSERT INTO folders(account_id,path,name,special_use) VALUES ($1,$2,$2,$3)', [a,path,role]);
      await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES ($1,$2,1,true)", [a,path]);
    }
  });
  it('keeps newer nonmatching Sent context and physical RFC repetitions in chronological order', async () => {
    await insert(1); await insert(2,'Sent',{ date: '2026-10-22' }); await insert(3,'INBOX',{ date: null });
    await insert(4,'INBOX',{ account: b });
    const body = await request();
    expect(body.messages.map(row => row.id)).toEqual([id(3),id(1),id(2)]);
    expect(body.messages.map(row => row.from_email)).toEqual(Array(3).fill('author@synthetic.test'));
    expect(body.messages[0]).not.toHaveProperty('message_count');
    expect(body).not.toHaveProperty('complete');
  });
  it('keeps an all-folder Spam hit and its ordinary context reachable', async () => {
    await insert(1,'Spam'); await insert(2,'INBOX'); await insert(3,'Trash');
    expect((await request()).messages.map(row => row.id)).toEqual([id(1),id(2)]);
  });
  it('excludes name-only Deleted Items exactly as search does', async () => {
    await insert(1); await insert(2,'Deleted Items'); await insert(3,'Spam');
    await db.query("INSERT INTO folders(account_id,path,name) VALUES ($1,'Deleted Items','Deleted Items')",[a]);
    expect((await request()).messages.map(row => row.id)).toEqual([id(1),id(3)]);
  });
  it('includes explicit in:trash matches but not an unselected Trash folder', async () => {
    await insert(1,'Trash'); await insert(2,'Deleted Items'); await insert(3,'INBOX');
    await db.query("INSERT INTO folders(account_id,path,name) VALUES ($1,'Deleted Items','Deleted Items')",[a]);
    expect((await request({ q: 'Nana in:trash', folder: 'Spam' })).messages.map(row => row.id)).toEqual([id(1),id(3)]);
  });
  it('does not open every Trash folder when an ordinary folder scope is selected', async () => {
    await insert(1); await insert(2,'Trash'); await insert(3,'Spam');
    expect((await request({ folder: 'INBOX' })).messages.map(row => row.id)).toEqual([id(1),id(3)]);
  });
  it('suppresses verified cross-folder provider copies, retaining selected physical repetitions', async () => {
    await insert(1,'INBOX',{ provider: 'exact-provider-id' });
    await insert(2,'INBOX',{ provider: 'exact-provider-id' });
    await insert(3,'All',{ provider: 'exact-provider-id' });
    await insert(4,'All',{ provider: 'exact-provider-id' });
    expect((await request()).messages.map(row => row.id)).toEqual([id(1),id(2)]);
    expect((await request({ matchedMessageId: id(3) })).messages.map(row => row.id)).toEqual([id(3),id(4)]);
  });
  it('retains unknown identities and does not trust a stale bootstrap epoch', async () => {
    await insert(1,'INBOX',{ provider: 'exact-provider-id' });
    await insert(2,'All',{ provider: 'exact-provider-id' }); await insert(3,'Sent');
    await db.query("UPDATE folders SET uid_validity=2 WHERE path='INBOX'");
    expect((await request()).messages.map(row => row.id)).toEqual([id(1),id(2),id(3)]);
  });
  it('keeps NULL raw thread_id while addressing its physical fallback key', async () => {
    await insert(1,'INBOX',{ thread: null });
    const body = await request({ id: JSON.stringify([a,id(1)]) });
    expect(body.messages[0]).toMatchObject({ id: id(1), thread_id: null, reply_thread_id: null });
  });
  it('denies foreign/disabled/unified-opt-out scopes and permits explicit enabled owner', async () => {
    await insert(1);
    await request({ id: JSON.stringify([b,'T']),accountId: b },403);
    await db.query('UPDATE email_accounts SET include_in_unified_inbox=false WHERE id=$1',[a]);
    await request({},403); expect((await request({ accountId: a })).messages).toHaveLength(1);
    await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1',[a]);
    await request({ accountId: a },403);
  });
  it('refuses a selected physical id outside the authorized context instead of replacing it', async () => {
    await insert(1); await insert(2,'Trash');
    await request({ matchedMessageId: id(2) },404);
    await request({ matchedMessageId: id(99) },404);
  });
});
