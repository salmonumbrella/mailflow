import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const boundary = vi.hoisted(() => ({ pool: null }));
vi.mock('../services/db.js', () => ({
  query: (...args) => boundary.pool.query(...args),
  withTransaction: async fn => {
    const client = await boundary.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
import * as storage from './storage.js';
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('independent storage SQL review', () => {
  let admin;
  const schema = `storage_review_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    boundary.pool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
    await boundary.pool.query(`CREATE TABLE users (id uuid PRIMARY KEY); INSERT INTO users VALUES ('${alice}'), ('${bob}');
      CREATE TABLE plugin_data (plugin_id varchar(64), key varchar(255), owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
      value jsonb NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT now(), PRIMARY KEY(plugin_id, key))`);
  });
  beforeEach(async () => { await boundary.pool.query('DELETE FROM plugin_data'); });
  afterAll(async () => { await boundary.pool?.end(); await admin?.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  it('preserves record owner in conflicting create/update and bounded batch deletion', async () => {
    const row = await storage.putOwned('review', alice, 'same', { secret: 'alice' }, { expectedRevision: null });
    expect(await storage.putOwned('review', bob, 'same', {}, { expectedRevision: null })).toBeNull();
    expect(await storage.putOwned('review', bob, 'same', {}, { expectedRevision: row.revision })).toBeNull();
    expect(await storage.getOwned('review', bob, 'same')).toBeNull();
    expect(await storage.deleteOwnedBatch('review', bob, [row])).toBe(0);
    expect(await storage.deleteOwnedBatch('other-plugin', alice, [row])).toBe(0);
    const latest = await storage.putOwned('review', alice, 'same', { secret: 'new' }, { expectedRevision: row.revision });
    expect(await storage.deleteOwnedBatch('review', alice, [row])).toBe(0);
    expect((await storage.getOwned('review', alice, 'same')).value.secret).toBe('new');
    expect(await storage.deleteOwnedBatch('review', alice, [latest])).toBe(1);
  });
  it('serializes guards for absent keys so concurrent writes to distinct anchors cannot both accept the same snapshot', async () => {
    const guards = [{ key: 'a', revision: null }, { key: 'b', revision: null }];
    const results = await Promise.all(['a', 'b'].map(key => storage.putOwned('review', alice, key, { text: key }, { expectedRevision: null, guards })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.find(Boolean);
    const loser = winner.key === 'a' ? 'b' : 'a';
    expect(await storage.getOwned('review', alice, loser)).toBeNull();
    const stale = guards;
    expect(await storage.putOwned('review', alice, loser, {}, { expectedRevision: null, guards: stale })).toBeNull();
    const current = guards.map(guard => guard.key === winner.key ? { ...guard, revision: winner.revision } : guard);
    expect(await storage.putOwned('review', alice, loser, {}, { expectedRevision: null, guards: current })).not.toBeNull();
  });
  it('atomically commits linked records and rolls back every change on a late constraint failure or foreign-owner conflict', async () => {
    const changes = [{ key: 'a-note', value: { text: 'secret' }, expectedRevision: null }, { key: 'z-alias', value: { anchors: ['a-note'] }, expectedRevision: null }];
    const guards = changes.map(({ key }) => ({ key, revision: null }));
    await boundary.pool.query("ALTER TABLE plugin_data ADD CONSTRAINT reject_alias CHECK (key <> 'z-alias')");
    try {
      await expect(storage.putOwnedBatch('review', alice, changes, { guards })).rejects.toMatchObject({ code: '23514' });
      expect(await storage.getOwned('review', alice, 'a-note')).toBeNull();
    } finally { await boundary.pool.query('ALTER TABLE plugin_data DROP CONSTRAINT reject_alias'); }
    const foreign = await storage.putOwned('review', bob, 'z-alias', { text: 'bob secret' }, { expectedRevision: null });
    expect(await storage.putOwnedBatch('review', alice, changes, { guards })).toBeNull();
    expect(await storage.getOwned('review', alice, 'a-note')).toBeNull();
    expect((await storage.getOwned('review', bob, 'z-alias')).revision).toBe(foreign.revision);
    await storage.deleteOwned('review', bob, 'z-alias', { expectedRevision: foreign.revision });
    const created = await storage.putOwnedBatch('review', alice, changes, { guards });
    expect(created).toHaveLength(2);
    expect((await storage.getOwned('review', alice, 'a-note')).value.text).toBe('secret');
    expect(await storage.putOwnedBatch('review', alice, changes, { guards })).toBeNull();
  });
  it('rolls guarded writes back on failure without releasing the parent CAS protection', async () => {
    const parent = await storage.putOwned('review', alice, 'catalog', {}, { expectedRevision: null });
    await boundary.pool.query("ALTER TABLE plugin_data ADD CONSTRAINT reject_test_child CHECK (key <> 'forbidden')");
    try {
      await expect(storage.putOwned('review', alice, 'forbidden', {}, { expectedRevision: null, guard: { key: 'catalog', revision: parent.revision } })).rejects.toMatchObject({ code: '23514' });
      expect(await storage.getOwned('review', alice, 'forbidden')).toBeNull();
      expect((await storage.getOwned('review', alice, 'catalog')).revision).toBe(parent.revision);
      expect(await storage.putOwned('review', alice, 'allowed', {}, { expectedRevision: null, guard: { key: 'catalog', revision: parent.revision } })).not.toBeNull();
    } finally { await boundary.pool.query('ALTER TABLE plugin_data DROP CONSTRAINT reject_test_child'); }
  });
  it('cannot commit a new child once a concurrent parent deletion has committed', async () => {
    const parent = await storage.putOwned('review', alice, 'catalog', {}, { expectedRevision: null });
    const client = await boundary.pool.connect();
    await client.query('BEGIN'); await client.query("DELETE FROM plugin_data WHERE key = 'catalog'");
    const waiting = storage.putOwned('review', alice, 'child', {}, { expectedRevision: null, guard: { key: 'catalog', revision: parent.revision } });
    await client.query('COMMIT'); client.release();
    expect(await waiting).toBeNull(); expect(await storage.getOwned('review', alice, 'child')).toBeNull();
  });
  it('bounds pages after SQL filtering without leaking wildcard prefixes or another owner', async () => {
    await Promise.all(Array.from({ length: 220 }, (_, i) => storage.putOwned('review', alice, `ev/${String(i).padStart(3, '0')}`, { category: i < 10 ? 'old' : 'current' }, { expectedRevision: null })));
    await storage.putOwned('review', bob, 'ev/secret', { category: 'current' }, { expectedRevision: null });
    await storage.putOwned('review', alice, 'ev%not-slash', { category: 'current' }, { expectedRevision: null });
    const options = { prefix: 'ev/', limit: 200, filters: [{ field: 'category', op: 'eq', value: 'current' }] };
    const one = await storage.listOwned('review', alice, options);
    const two = await storage.listOwned('review', alice, { ...options, after: one.nextCursor });
    expect(one.items).toHaveLength(200); expect(two.items).toHaveLength(10); expect(two.nextCursor).toBeNull();
    expect(new Set([...one.items, ...two.items].map(row => row.key)).size).toBe(210);
    expect((await storage.listOwned('review', alice, { prefix: 'ev%' })).items.map(row => row.key)).toEqual(['ev%not-slash']);
    await expect(storage.deleteOwnedBatch('review', alice, Array(201).fill(one.items[0]))).rejects.toThrow();
  });
});
