// UNRUN preflight tests. Requires the dedicated 61dz database AND a released
// focused-test slot. This proves index enforcement, not admission/writer locking.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

const migration = new URL('../../migrations/0070_archive_identity_indexes.sql', import.meta.url);
const account = '11111111-1111-4111-8111-111111111111';
const otherAccount = '22222222-2222-4222-8222-222222222222';
const providerId = '9007199254740993';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)(
  '0070 archive identity indexes (dedicated residue database)', () => {
    let db, peer, schema, created = false;
    // Same statement boundaries as the existing nontransactional runner.
    const migrate = async () => {
      const sql = await readFile(migration, 'utf8');
      expect(sql).toMatch(/^--\s*no-transaction\b/m);
      for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await db.query(statement);
      }
    };
    const insert = (connection, { accountId = account, uid = 1, folder = 'Étiquettes/Tous',
      identity = providerId, residue = true } = {}) => connection.query(`
      INSERT INTO messages(account_id,uid,folder,message_id,provider_msgid,is_archive_residue)
      VALUES ($1,$2,$3,'<same@example.test>',$4,$5)`, [accountId, uid, folder, identity, residue]);
    const indexes = async () => (await db.query(`
      SELECT indexrelid::regclass::text AS name, indisvalid, indisunique,
        pg_get_indexdef(indexrelid) AS definition, pg_get_expr(indpred,indrelid) AS predicate
      FROM pg_index WHERE indrelid='messages'::regclass AND NOT indisprimary`)).rows;

    beforeAll(async () => {
      // The lead's runner injects this URL; refuse another worker's database.
      if (decodeURIComponent(new URL(process.env.MAILFLOW_TEST_DATABASE_URL).pathname) !== '/mailflow_svtw') {
        throw new Error('Residue tests require the dedicated mailflow_svtw database');
      }
      const config = { connectionString: process.env.MAILFLOW_TEST_DATABASE_URL };
      schema = `residue_indexes_${randomUUID().replaceAll('-', '')}`;
      db = new pg.Client(config);
      await db.connect();
      await db.query(`CREATE SCHEMA ${schema}`);
      created = true;
      await db.query(`SET search_path TO ${schema}; SET statement_timeout='5s';
        CREATE TABLE archive_coverage(account_id uuid,folder text,uid_validity bigint);
        CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          account_id uuid NOT NULL, uid bigint NOT NULL, folder text NOT NULL,
          message_id text, provider_msgid text, is_archive_residue boolean NOT NULL DEFAULT false,
          UNIQUE(account_id,folder,uid))`);
      peer = new pg.Client(config);
      await peer.connect();
      await peer.query(`SET search_path TO ${schema}; SET statement_timeout='5s'`);
    });
    afterAll(async () => {
      await peer?.end();
      if (db) {
        try { if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await db.end(); }
      }
    });
    beforeEach(async () => {
      await db.query('TRUNCATE messages');
      await migrate();
    });

    it('creates valid partial uniqueness and a separate account/provider lookup', async () => {
      const rows = await indexes();
      const unique = rows.find(row => row.indisunique && row.predicate);
      expect(unique).toMatchObject({ indisvalid: true });
      expect(unique.definition).toMatch(/\(account_id, provider_msgid\)/);
      expect(unique.predicate).toMatch(/is_archive_residue/);
      const lookup = rows.find(row => !row.indisunique && !row.predicate &&
        /\(account_id, provider_msgid\)/.test(row.definition));
      expect(lookup).toMatchObject({ indisvalid: true });
    });

    it('allows exactly one concurrent residue insert per account/provider object', async () => {
      const results = await Promise.allSettled([
        insert(db, { uid: 11 }), insert(peer, { uid: 12 }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: '23505' });
      expect((await db.query('SELECT account_id,provider_msgid,is_archive_residue FROM messages')).rows)
        .toEqual([{ account_id: account, provider_msgid: providerId, is_archive_residue: true }]);
    });

    it('preserves physical normal duplicates and exact IDs across accounts', async () => {
      await insert(db);
      await insert(db, { uid: 2, folder: 'INBOX', residue: false });
      await insert(db, { uid: 3, folder: 'INBOX', residue: false });
      await insert(db, { uid: 4, identity: '9007199254740992' });
      await insert(db, { accountId: otherAccount });
      const { rows } = await db.query(`SELECT account_id,uid::text,provider_msgid,is_archive_residue
        FROM messages ORDER BY account_id,uid`);
      expect(rows).toEqual([
        { account_id: account, uid: '1', provider_msgid: providerId, is_archive_residue: true },
        { account_id: account, uid: '2', provider_msgid: providerId, is_archive_residue: false },
        { account_id: account, uid: '3', provider_msgid: providerId, is_archive_residue: false },
        { account_id: account, uid: '4', provider_msgid: '9007199254740992', is_archive_residue: true },
        { account_id: otherAccount, uid: '1', provider_msgid: providerId, is_archive_residue: true },
      ]);
    });

    it('recovers a genuinely invalid concurrent index after the duplicate is resolved', async () => {
      const unique = (await indexes()).find(row => row.indisunique && row.predicate);
      // Name/DDL came from this test's own catalog, never a public or worker table.
      await db.query(`DROP INDEX ${unique.name}`);
      await insert(db, { uid: 11 });
      await insert(db, { uid: 12 });
      await expect(db.query(unique.definition.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY')))
        .rejects.toMatchObject({ code: '23505' });
      expect((await indexes()).find(row => row.name === unique.name)?.indisvalid).toBe(false);
      await db.query('DELETE FROM messages WHERE uid=12');
      await migrate();
      expect((await indexes()).find(row => row.name === unique.name)?.indisvalid).toBe(true);
      await expect(insert(db, { uid: 13 })).rejects.toMatchObject({ code: '23505' });
      await migrate();
      expect((await indexes()).every(row => row.indisvalid)).toBe(true);
    });
  },
);
