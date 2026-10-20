import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), bulkMoveMessages: vi.fn(), scheduleCountRefresh: vi.fn(), broadcast: vi.fn() } }));
vi.mock('../utils/mailUtils.js', async original => ({ ...await original(), resolveArchiveFolder: async () => 'All Mail', isAllMailFolder: async () => true, adjustFolderCounts: vi.fn() }));
import { query } from '../services/db.js';
import router from './mail.js';
import { imapManager } from '../index.js';
import { observeFolder } from '../services/folderStatus.js';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('archive targets and local observations in isolated PostgreSQL', () => {
  let db;
  const account = '00000000-0000-4000-8000-000000000001';
  const id = '00000000-0000-4000-8000-000000000002';
  const other = '00000000-0000-4000-8000-000000000003';
  const status = { messages: 2, unseen: 1, uidNext: 4, uidValidity: 1n };
  const call = async (path, method, body = {}) => {
    let result;
    const res = { json: value => { result = value; }, set: () => res, status: () => res };
    await router.stack.find(r => r.route?.path === path && r.route.methods[method]).route.stack.at(-1).handle({ body, query: {}, session: { userId: 'owner.test' } }, res);
    return result;
  };
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE TEMP SEQUENCE folder_status_revision;
      CREATE TEMP TABLE email_accounts(id uuid, user_id text, enabled boolean DEFAULT true, include_in_unified_inbox boolean, folder_mappings jsonb);
      CREATE TEMP TABLE messages(id uuid, account_id uuid, uid bigint, folder text, category text, is_read boolean DEFAULT false, is_deleted boolean DEFAULT false);
      CREATE TEMP TABLE folders(id int DEFAULT 1, account_id uuid, path text, server_total_count int, server_unread_count int,
        server_uid_next bigint, server_uid_validity bigint, server_highest_modseq bigint, server_counts_at timestamptz,
        server_count_revision bigint, status_attempt_revision bigint, status_attempted_at timestamptz, status_error text);`);
    await db.query("INSERT INTO email_accounts(id,user_id,include_in_unified_inbox) VALUES ($1,'owner.test',true),($2,'owner.test',false)", [account, other]);
    await db.query("INSERT INTO messages VALUES ($1,$2,1,'INBOX','primary',false,false),($3,$2,2,'INBOX','primary',true,false),($4,$5,3,'INBOX','primary',false,false)", [id, account, '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', other]);
    await db.query("INSERT INTO folders(account_id,path) VALUES ($1,'INBOX')", [account]);
    query.mockImplementation((sql, params) => db.query(sql, params));
  });
  afterAll(async () => { await db?.end(); });
  it('preserves observation ordering without treating archive responses or failed STATUS as truth', async () => {
    let release;
    const old = observeFolder({ status: () => new Promise(resolve => { release = resolve; }) }, account, 'INBOX');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: ['1'], failed: [] });
    const response = await call('/messages/bulk-archive', 'post', { ids: [id] });
    expect(response.countTargets).toHaveLength(1);
    expect(response.countBarrierRevision).toBeUndefined();
    // A test-only marker separates the held old STATUS from later local observations.
    const marker = BigInt((await db.query("SELECT nextval('folder_status_revision') AS revision")).rows[0].revision);
    release(status);
    await old;
    const oldRow = (await db.query('SELECT * FROM folders')).rows[0];
    expect(BigInt(oldRow.server_count_revision)).toBeLessThan(marker);
    const category = await call('/category-counts', 'get');
    expect(category.counts).toEqual({ primary: 0 });
    expect(category.totals).toEqual({ primary: 1 });
    expect(BigInt(category.countRevision)).toBeGreaterThan(marker);
    await expect(observeFolder({ status: async () => false }, account, 'INBOX')).rejects.toThrow('Incomplete');
    const failed = (await db.query('SELECT * FROM folders')).rows[0];
    expect(BigInt(failed.server_count_revision)).toBeLessThan(marker);
    expect(BigInt(failed.status_attempt_revision)).toBeGreaterThan(marker);
    await observeFolder({ status: async () => ({ ...status, messages: 1, unseen: 0 }) }, account, 'INBOX');
    const good = (await db.query('SELECT * FROM folders')).rows[0];
    expect(BigInt(good.server_count_revision)).toBeGreaterThan(marker);
    expect(good.server_unread_count).toBe(0);
  });
});
