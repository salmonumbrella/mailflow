import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const migration = new URL('../../migrations/0079_message_flag_addresses.sql', import.meta.url);
// Isolate actual persistent migration objects, including its sequence, from other tests.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('flag address and intent schema', () => {
  let database, sql, schema;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    sql = await readFile(migration, 'utf8');
  });
  afterAll(async () => { await database?.end(); });
  afterEach(async () => {
    if (schema) await database.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  beforeEach(async () => {
    schema = `flag_schema_${randomUUID().replaceAll('-', '')}`;
    await database.query(`CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE folders(account_id uuid, path text, uid_validity bigint);
      CREATE TABLE messages(id uuid PRIMARY KEY, account_id uuid, folder text, uid bigint);
      INSERT INTO folders VALUES ('11111111-1111-4111-8111-111111111111','INBOX',17);
      INSERT INTO messages VALUES ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111','INBOX',42)`);
  });
  it('leaves preexisting row epochs unproven and initializes both durable versions', async () => {
    await database.query(sql);
    expect((await database.query(`SELECT n.nspname, c.relpersistence FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid='message_flag_intent_version_seq'::regclass`)).rows)
      .toEqual([{ nspname: schema, relpersistence: 'p' }]);
    expect((await database.query("SELECT to_regclass('pg_temp.message_flag_intent_version_seq') AS shadow")).rows[0].shadow).toBeNull();
    expect((await database.query("SELECT nextval('message_flag_intent_version_seq')::text AS version")).rows[0].version).toBe('1');
    expect((await database.query('SELECT flag_address_valid,flag_uid_validity,read_intent_version,star_intent_version FROM messages')).rows)
      .toEqual([{ flag_address_valid: true, flag_uid_validity: null, read_intent_version: '0', star_intent_version: '0' }]);
  });
  it('preserves old flag0076 receipts and data when successor0079 applies again', async () => {
    await database.query(sql);
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY); INSERT INTO schema_migrations VALUES ('0076_message_flag_addresses')");
    await database.query('UPDATE messages SET flag_address_valid=false,read_intent_version=9007199254740993,star_intent_version=9007199254740995');
    await database.query(sql);
    await database.query("INSERT INTO schema_migrations VALUES ('0079_message_flag_addresses')");
    expect((await database.query('SELECT version FROM schema_migrations ORDER BY version')).rows)
      .toEqual([{ version: '0076_message_flag_addresses' }, { version: '0079_message_flag_addresses' }]);
    expect((await database.query('SELECT flag_address_valid,read_intent_version,star_intent_version FROM messages')).rows)
      .toEqual([{ flag_address_valid: false, read_intent_version: '9007199254740993', star_intent_version: '9007199254740995' }]);
    await database.query('ALTER SEQUENCE message_flag_intent_version_seq RESTART WITH 9007199254740996');
    expect((await database.query("SELECT nextval('message_flag_intent_version_seq')::text AS version")).rows[0].version)
      .toBe('9007199254740996');
  });
});
