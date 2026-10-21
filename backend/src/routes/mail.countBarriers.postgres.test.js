import { afterEach, beforeEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), bulkMoveMessages: vi.fn(), scheduleCountRefresh: vi.fn(), broadcast: vi.fn(), syncFolderOnDemand: vi.fn() } }));
vi.mock('../utils/mailUtils.js', async original => ({ ...await original(), resolveArchiveFolder: async () => 'All Mail', isAllMailFolder: async () => true, adjustFolderCounts: vi.fn() }));
import { query, withTransaction } from '../services/db.js';
import router from './mail.js';
import { imapManager } from '../index.js';
import { countCompletion } from '../services/countCompletion.js';
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
    if (decodeURIComponent(new URL(process.env.MAILFLOW_TEST_DATABASE_URL).pathname) !== '/mailflow_svtw') throw new Error('Requires dedicated mailflow_svtw');
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE TEMP SEQUENCE folder_status_revision;
      CREATE TEMP TABLE email_accounts(id uuid, user_id text, enabled boolean DEFAULT true, include_in_unified_inbox boolean, folder_mappings jsonb);
      CREATE TEMP TABLE messages(id uuid, account_id uuid, uid bigint, folder text, category text, is_read boolean DEFAULT false, is_deleted boolean DEFAULT false, provider_msgid text, is_archive_residue boolean DEFAULT false);
      CREATE TEMP TABLE folders(id int DEFAULT 1, account_id uuid, path text, uid_validity bigint, no_select boolean DEFAULT false, server_total_count int, server_unread_count int,
        server_uid_next bigint, server_uid_validity bigint, server_highest_modseq bigint, server_counts_at timestamptz,
        server_count_revision bigint, status_attempt_revision bigint, status_attempted_at timestamptz, status_error text);`);
    await db.query("INSERT INTO email_accounts(id,user_id,include_in_unified_inbox) VALUES ($1,'owner.test',true),($2,'owner.test',false)", [account, other]);
    await db.query("INSERT INTO messages(id,account_id,uid,folder,category,is_read,is_deleted) VALUES ($1,$2,1,'INBOX','primary',false,false),($3,$2,2,'INBOX','primary',true,false),($4,$5,3,'INBOX','primary',false,false)", [id, account, '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', other]);
    await db.query("INSERT INTO folders(account_id,path) VALUES ($1,'INBOX')", [account]);
    withTransaction.mockImplementation(async work => {
      await db.query('BEGIN');
      try { const value = await work({ query: (sql, params) => db.query(sql, params) }); await db.query('COMMIT'); return value; }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    });
    query.mockImplementation((sql, params) => sql.includes('FROM snoozed_messages') ? Promise.resolve({ rows: [] }) : db.query(sql, params));
  });
  afterAll(async () => { await db?.end(); });
  let warnings;
  beforeEach(() => { warnings = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { try { expect(warnings).not.toHaveBeenCalled(); } finally { warnings.mockRestore(); } });
  it('preserves observation ordering without treating archive responses or failed STATUS as truth', async () => {
    let release;
    const old = observeFolder({ status: () => new Promise(resolve => { release = resolve; }) }, account, 'INBOX', () => countCompletion.observation('owner.test', account));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: ['1'], failed: [] });
    const response = await call('/messages/bulk-archive', 'post', { ids: [id] });
    expect(response.countTargets).toHaveLength(1);
    expect(response.countBarrierRevision).toBeUndefined();
    const refresh = await call('/counts/refresh', 'post', { ops: [] });
    const marker = BigInt(refresh.refreshSeq);
    release(status);
    await old;
    const oldRow = (await db.query('SELECT * FROM folders')).rows[0];
    expect(BigInt(oldRow.server_count_revision)).toBeLessThan(marker);
    expect((await call('/unread-counts', 'get')).snapshots[account].quiescentAtStart).toBe(false);
    const category = await call('/category-counts', 'get');
    expect(category.counts).toEqual({ primary: 0 });
    expect(category.totals).toEqual({ primary: 1 });
    expect(BigInt(category.countRevision)).toBeGreaterThan(marker);
    await expect(observeFolder({ status: async () => false }, account, 'INBOX')).rejects.toThrow('Incomplete');
    const failed = (await db.query('SELECT * FROM folders')).rows[0];
    expect(BigInt(failed.server_count_revision)).toBeLessThan(marker);
    expect(BigInt(failed.status_attempt_revision)).toBeGreaterThan(marker);
    await observeFolder({ status: async () => ({ ...status, messages: 1, unseen: 0 }) }, account, 'INBOX', () => countCompletion.observation('owner.test', account));
    const good = (await db.query('SELECT * FROM folders')).rows[0];
    expect(BigInt(good.server_count_revision)).toBeGreaterThan(marker);
    expect(good.server_unread_count).toBe(0);
    expect((await call('/unread-counts', 'get')).snapshots[account]).toMatchObject({ quiescentAtStart: true, refreshSeqAtStart: refresh.refreshSeq });
  });
  it('excludes disabled accounts with retained provider retries from the refresh certification scope', async () => {
    const disabled = '00000000-0000-4000-8000-000000000006';
    await db.query("INSERT INTO email_accounts(id,user_id,enabled) VALUES ($1,'owner.test',false)", [disabled]);
    countCompletion.pending = accountId => accountId === disabled ? 1 : 0;
    imapManager.scheduleCountRefresh.mockClear();
    try {
      const refresh = await call('/counts/refresh', 'post', { ops: [] });
      expect(imapManager.scheduleCountRefresh.mock.calls.map(([id]) => id).sort()).toEqual([account, other]);
      expect(countCompletion.observation('owner.test', account)).toMatchObject({ quiescentAtStart: true, refreshSeqAtStart: refresh.refreshSeq });
      expect(countCompletion.observation('owner.test', disabled).quiescentAtStart).toBe(false);
    } finally { countCompletion.pending = () => 0; }
  });

});
