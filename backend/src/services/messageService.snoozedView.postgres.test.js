import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { listMessages } from './messageService.js';

// The Snoozed view lists only exact, current entity projections with ready snooze decisions,
// including folders placed under a server namespace. The
// count is built in SQL that listMessages turns into 0 if it fails, so it is checked here against
// PostgreSQL. Uses only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('all-accounts Snoozed view PostgreSQL', () => {
  let database;
  const plain = '33333333-3333-4333-8333-333333333333';
  const prefixed = '44444444-4444-4444-8444-444444444444';
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (storage_generation uuid DEFAULT gen_random_uuid(), id uuid, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        folder_mappings jsonb);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, delimiter text,
        special_use text, total_count integer DEFAULT 0, unread_count integer DEFAULT 0);
      CREATE TEMP TABLE message_entities (id uuid PRIMARY KEY, account_id uuid, storage_generation uuid, canonical_entity_id uuid);
      CREATE TEMP TABLE mailbox_identity_epochs (account_id uuid, storage_generation uuid, folder_path text, uid_validity bigint,
        PRIMARY KEY(account_id,storage_generation,folder_path));
      CREATE TEMP TABLE entity_locations (account_id uuid, storage_generation uuid, folder_path text, uid_validity bigint,
        uid bigint, entity_id uuid REFERENCES message_entities(id), status text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        storage_generation uuid, uid_validity bigint, entity_id uuid REFERENCES message_entities(id),
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, spam_verdict text,
        spam_user_override text, spam_score_ml real, flags jsonb, unsubscribed_at timestamptz);
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text);
      CREATE TEMP TABLE snoozed_messages (storage_generation uuid, account_id uuid, message_id_header text,
        entity_id uuid REFERENCES message_entities(id), wake_state text DEFAULT 'ready',
        original_folder text, snoozed_folder text, snooze_until timestamptz)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, contacts, snoozed_messages, entity_locations, mailbox_identity_epochs, message_entities');
    // The view takes in every enabled account, the one left out of All Inboxes too.
    await database.query(
      `INSERT INTO email_accounts(id,user_id,enabled,include_in_unified_inbox,name,email_address,color,folder_mappings) VALUES
        ($1,'owner',true,true,'Plain','plain@example.com','#111111',NULL),
        ($2,'owner',true,false,'Prefixed','prefixed@example.com','#222222',NULL)`,
      [plain, prefixed],
    );
    // Snoozed is a folder of that name on one server and INBOX.Snoozed on the other. The plain
    // account also has an INBOX.Snoozed of its own, which is where none of its snoozes went.
    await folder(plain, 'Snoozed', 2, 1);
    await folder(prefixed, 'INBOX.Snoozed', 3, 2);
    await folder(plain, 'INBOX.Snoozed', 1, 1);
    const p1 = await message(plain, 'Snoozed', '<p1@x>', false);
    const p2 = await message(plain, 'Snoozed', '<p2@x>', true);
    const s1 = await message(prefixed, 'INBOX.Snoozed', '<s1@x>', false);
    const s2 = await message(prefixed, 'INBOX.Snoozed', '<s2@x>', true);
    await message(prefixed, 'INBOX.Snoozed', '<filed@x>', false);
    await message(plain, 'INBOX.Snoozed', '<other@x>', false);
    await snooze(p1, '2026-10-20T08:00Z');
    await snooze(p2, '2026-10-22T08:00Z');
    await snooze(s1, '2026-10-15T08:00Z');
    await snooze(s2, '2026-10-21T08:00Z');
  });

  const folder = (account, path, total, unread) => database.query(
    'INSERT INTO folders(account_id,path,name,delimiter,total_count,unread_count) VALUES ($1,$2,$2,$3,$4,$5)',
    [account, path, path.includes('.') ? '.' : '/', total, unread],
  );
  const message = async (account, path, messageId, isRead) => {
    const messageIdDb = id(), entityId = id(), uid = nextId++;
    const { rows: [owner] } = await database.query('SELECT storage_generation FROM email_accounts WHERE id=$1', [account]);
    const generation = owner.storage_generation;
    await database.query('INSERT INTO message_entities(id,account_id,storage_generation) VALUES ($1,$2,$3)', [entityId, account, generation]);
    await database.query(`INSERT INTO mailbox_identity_epochs(account_id,storage_generation,folder_path,uid_validity)
      VALUES ($1,$2,$3,10) ON CONFLICT DO NOTHING`, [account, generation, path]);
    await database.query(`INSERT INTO entity_locations(account_id,storage_generation,folder_path,uid_validity,uid,entity_id,status)
      VALUES ($1,$2,$3,10,$4,$5,'present')`, [account, generation, path, uid, entityId]);
    await database.query(`INSERT INTO messages(id,account_id,folder,message_id,thread_id,thread_key,date,subject,is_read,uid,storage_generation,uid_validity,entity_id)
      VALUES ($1,$2,$3,$4,$4,$4,'2026-10-10T10:00Z',$4,$5,$6,$7,10,$8)`,
    [messageIdDb, account, path, messageId, isRead, uid, generation, entityId]);
    return { account, path, messageId, entityId, generation };
  };
  // Callers pass the explicitly created delivery, never resolve an entity by header.
  const snooze = (source, until, { entityId = source.entityId, wakeState = 'ready' } = {}) => database.query(
    `INSERT INTO snoozed_messages(account_id,message_id_header,original_folder,snoozed_folder,snooze_until,storage_generation,entity_id,wake_state)
     VALUES ($1,$2,'INBOX',$3,$4,$5,$6,$7)`,
    [source.account, source.messageId, source.path, until, source.generation, entityId, wakeState],
  );

  it('lists snoozed mail in both kinds of folder, soonest back first, and counts it', async () => {
    const { messages, total } = await listMessages({ userId: 'owner', folder: 'Snoozed' });

    expect(messages.map(m => [m.message_id, m.snoozed_folder])).toEqual([
      ['<s1@x>', 'INBOX.Snoozed'],
      ['<p1@x>', 'Snoozed'],
      ['<s2@x>', 'INBOX.Snoozed'],
      ['<p2@x>', 'Snoozed'],
    ]);
    // Actual verified snoozes, not folder counts that also include mail filed by hand.
    expect(total).toBe(4);
  });

  it('counts only unread snoozed mail when the view is unread only', async () => {
    const { messages, total } = await listMessages({ userId: 'owner', folder: 'Snoozed', unreadOnly: 'true' });

    expect(messages.map(m => m.message_id)).toEqual(['<s1@x>', '<p1@x>']);
    expect(total).toBe(2);
  });
  it('holds legacy NULL-entity decisions and never binds an independent same-header delivery', async () => {
    const legacy = await message(plain, 'Snoozed', '<legacy@x>', false);
    await snooze(legacy, '2026-10-01T08:00Z', { entityId: null });
    await message(prefixed, 'INBOX.Snoozed', '<s1@x>', false);
    const pending = await message(plain, 'Snoozed', '<pending@x>', false);
    await snooze(pending, '2026-10-01T08:00Z', { wakeState: 'pending' });
    const { messages, total } = await listMessages({ userId: 'owner', folder: 'Snoozed' });
    expect(total).toBe(4);
    expect(messages.map(m => m.message_id)).toEqual(['<s1@x>', '<p1@x>', '<s2@x>', '<p2@x>']);
  });

  it.each([[plain, ['<p1@x>', '<p2@x>']], [prefixed, ['<s1@x>', '<s2@x>']]])(
    'direct account %s uses the same verified snooze scope, including namespace folders', async (accountId, headers) => {
      const legacy = await message(accountId, 'Snoozed', '<held@x>', false);
      await snooze(legacy, '2026-10-01T08:00Z', { entityId: null });
      const { messages, total } = await listMessages({ userId: 'owner', accountId, folder: 'Snoozed' });
      expect(total).toBe(2);
      expect(messages.map(m => m.message_id)).toEqual(headers);
    });

  it('holds snoozes whose cached coordinates no longer match the current mailbox epoch', async () => {
    await database.query("UPDATE mailbox_identity_epochs SET uid_validity=11 WHERE account_id=$1 AND folder_path='INBOX.Snoozed'", [prefixed]);
    const { messages, total } = await listMessages({ userId: 'owner', folder: 'Snoozed' });
    expect(total).toBe(2);
    expect(messages.map(m => m.message_id)).toEqual(['<p1@x>', '<p2@x>']);
  });

});
