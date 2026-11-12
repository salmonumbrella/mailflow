import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from '../services/db.js';
import * as storage from './storage.js';
vi.mock('./api.js', async () => ({ storage: await vi.importActual('./storage.js'), requireAuth: (req, res, next) => next(), isPluginActivated: async () => true }));
import calendarRouter from './local-calendar/routes.js';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('private plugin storage on disposable PostgreSQL', () => {
  let db, admin;
  const schema = `plugin_storage_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await db.query(`CREATE TABLE users (id uuid PRIMARY KEY); CREATE TABLE plugin_data (
      plugin_id varchar(64) NOT NULL, key varchar(255) NOT NULL, owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
      value jsonb NOT NULL DEFAULT '{}', blob bytea, blob_mime text, visibility varchar(16) NOT NULL DEFAULT 'private',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(plugin_id,key));
      INSERT INTO users VALUES ('${U1}'), ('${U2}')`);
    query.mockImplementation((sql, values) => db.query(sql, values));
    withTransaction.mockImplementation(async fn => {
      const client = await db.connect(); await client.query('BEGIN');
      try { const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
    });
  });
  beforeEach(async () => { await db.query('DELETE FROM plugin_data'); });
  afterAll(async () => { await db?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('checks ownership for reads, writes, deletes, guards and list results', async () => {
    const row = await storage.putOwned('test', U1, 'private', { title: 'secret' }, { expectedRevision: null });
    expect(await storage.getOwned('test', U2, 'private')).toBeNull();
    expect(await storage.putOwned('test', U2, 'private', {}, { expectedRevision: row.revision })).toBeNull();
    expect(await storage.putOwned('test', U2, 'private', {}, { expectedRevision: null })).toBeNull();
    expect(await storage.deleteOwned('test', U2, 'private', { expectedRevision: row.revision })).toBe(false);
    expect(await storage.listOwned('test', U2)).toEqual({ items: [], nextCursor: null });
    expect(await storage.putOwned('test', U2, 'child', {}, { expectedRevision: null, guard: { key: 'private', revision: row.revision } })).toBeNull();
    expect((await storage.getOwned('test', U1, 'private')).value.title).toBe('secret');
  });
  it('uses create-only and compare-and-swap across concurrent database connections', async () => {
    const first = await Promise.all(Array.from({ length: 6 }, (_, i) => storage.putOwned('test', U1, 'same', { i }, { expectedRevision: null })));
    expect(first.filter(Boolean)).toHaveLength(1);
    const revision = first.find(Boolean).revision;
    const updates = await Promise.all(Array.from({ length: 6 }, (_, i) => storage.putOwned('test', U1, 'same', { i }, { expectedRevision: revision })));
    expect(updates.filter(Boolean)).toHaveLength(1);
    expect(await storage.deleteOwned('test', U1, 'same', { expectedRevision: revision })).toBe(false);
    expect(await storage.deleteOwned('test', U1, 'same', { expectedRevision: updates.find(Boolean).revision })).toBe(true);
  });
  it('filters in SQL before bounded keyset pages and treats prefixes literally', async () => {
    for (const [key, start, end] of [['ev/1', '2026-01-01', '2026-01-02'], ['ev/2', '2026-02-01', '2026-02-02'], ['ev/3', '2026-02-03', '2026-02-04'], ['ev/4', '2026-02-05', '2026-02-06'], ['ev%5', '2026-02-05', '2026-02-06']]) await storage.putOwned('test', U1, key, { start, end }, { expectedRevision: null });
    const options = { prefix: 'ev/', limit: 2, filters: [{ field: 'end', op: 'gt', value: '2026-02-01' }, { field: 'start', op: 'lt', value: '2026-03-01' }] };
    const first = await storage.listOwned('test', U1, options);
    expect(first.items.map(r => r.key)).toEqual(['ev/2', 'ev/3']); expect(first.nextCursor).toBe('ev/3');
    const last = await storage.listOwned('test', U1, { ...options, after: first.nextCursor });
    expect(last.items.map(r => r.key)).toEqual(['ev/4']); expect(last.nextCursor).toBeNull();
    expect((await storage.listOwned('test', U1, { prefix: 'ev%' })).items.map(r => r.key)).toEqual(['ev%5']);
    await expect(storage.listOwned('test', U1, { limit: 100000 })).rejects.toThrow();
    await expect(storage.listOwned('test', U1, { filters: [{ field: 'x', op: "eq' OR true", value: 'x' }] })).rejects.toThrow();
  });
  it('locks and rechecks a parent revision before a guarded write', async () => {
    const parent = await storage.putOwned('test', U1, 'catalog', {}, { expectedRevision: null });
    const client = await db.connect(); await client.query('BEGIN');
    await client.query("UPDATE plugin_data SET value = jsonb_set(value, '{revision}', '\"new-revision\"') WHERE key = 'catalog'");
    const pending = storage.putOwned('test', U1, 'event', {}, { expectedRevision: null, guard: { key: 'catalog', revision: parent.revision } });
    await client.query('COMMIT'); client.release();
    expect(await pending).toBeNull(); expect(await storage.getOwned('test', U1, 'event')).toBeNull();
    const current = await storage.getOwned('test', U1, 'catalog');
    expect(await storage.putOwned('test', U1, 'event', {}, { expectedRevision: null, guard: { key: 'catalog', revision: current.revision } })).toBeTruthy();
  });
  it('preserves legacy blobs and cascades private data with the user', async () => {
    await storage.put('legacy', 'pet', { value: { name: 'Pet' }, blob: Buffer.from('png'), mime: 'image/png', ownerId: U1 });
    expect((await storage.getValue('legacy', 'pet')).value).toEqual({ name: 'Pet' });
    expect((await storage.getBlob('legacy', 'pet')).blob.toString()).toBe('png');
    await storage.del('legacy', 'pet'); expect(await storage.getValue('legacy', 'pet')).toBeNull();
    await storage.putOwned('test', U2, 'owned', {}, { expectedRevision: null });
    await db.query('DELETE FROM users WHERE id = $1', [U2]);
    expect(await storage.getOwned('test', U2, 'owned')).toBeNull();
  });
  it('batch deletes only matching owner and revision within the hard limit', async () => {
    const a = await storage.putOwned('test', U1, 'a', {}, { expectedRevision: null });
    const b = await storage.putOwned('test', U1, 'b', {}, { expectedRevision: null });
    const current = await storage.putOwned('test', U1, 'b', { edited: true }, { expectedRevision: b.revision });
    expect(await storage.deleteOwnedBatch('test', U2, [a, b])).toBe(0);
    expect(await storage.deleteOwnedBatch('test', U1, [a, b])).toBe(1);
    expect((await storage.getOwned('test', U1, 'b')).revision).toBe(current.revision);
    await expect(storage.deleteOwnedBatch('test', U1, Array(201).fill(current))).rejects.toThrow();
  });
  it('persists the calendar route CRUD lifecycle without crossing owners', async () => {
    await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [U2]);
    const request = async (owner, method, path, { body = {}, params = {}, query = {} } = {}) => {
      const req = { session: { userId: owner }, body, params, query };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      const route = calendarRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
      await route.route.stack[0].handle(req, res, err => { throw err; }); return res;
    };
    expect((await request(U1, 'get', '/catalog')).body.calendars).toEqual([]);
    const cal = { id: randomUUID(), name: 'Real local calendar', color: '#aabbcc', visible: true };
    const config = (await request(U1, 'put', '/catalog', { body: { calendars: [cal], templates: [{ id: randomUUID(), title: 'Focus', duration: 30 }], timezone: 'Europe/London', weekStart: 1, revision: null } })).body;
    expect(config.revision).toBeTruthy();
    const created = await request(U1, 'post', '/events', { body: { title: 'Trip', start: '2026-11-01', end: '2026-11-04', allDay: true, calendarId: cal.id, timezone: 'Europe/London' } });
    expect(created.statusCode).toBe(201);
    const event = created.body;
    const range = { start: '2026-11-02T00:00:00Z', end: '2026-11-03T00:00:00Z' };
    expect((await request(U1, 'get', '/events', { query: range })).body.items).toHaveLength(1);
    expect((await request(U2, 'get', '/events', { query: range })).body.items).toHaveLength(0);
    expect((await request(U2, 'delete', '/events/:id', { params: { id: event.id }, query: { revision: event.revision } })).statusCode).toBe(404);
    const updated = await request(U1, 'put', '/events/:id', { params: { id: event.id }, body: { ...event, title: 'Updated trip' } });
    expect(updated.statusCode).toBe(200);
    expect((await request(U1, 'put', '/events/:id', { params: { id: event.id }, body: event })).statusCode).toBe(409);
    expect((await request(U1, 'delete', '/events/:id', { params: { id: event.id }, query: { revision: updated.body.revision } })).statusCode).toBe(200);
    expect((await request(U1, 'get', '/events', { query: range })).body.items).toHaveLength(0);
    const another = await request(U1, 'post', '/events', { body: { ...event, title: 'Remove with calendar' } });
    await db.query(`INSERT INTO plugin_data(plugin_id,key,owner_id,value) SELECT 'local-calendar', $1 || '/events/' || gen_random_uuid(), $1::uuid, jsonb_build_object('revision', gen_random_uuid(), 'data', jsonb_build_object('calendarId', $2::text)) FROM generate_series(1,1001)`, [U1, cal.id]);
    const deletion = await request(U1, 'put', '/catalog', { body: { ...config, calendars: [] } });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.body.pendingCleanupIds).toEqual([cal.id]);
    expect(Number((await db.query("SELECT count(*) FROM plugin_data WHERE plugin_id='local-calendar' AND value->'data'->>'calendarId' = $1", [cal.id])).rows[0].count)).toBe(2);
    const finished = await request(U1, 'post', '/cleanup');
    expect(finished.body.pendingCleanupIds).toEqual([]);
    expect(await storage.getOwned('local-calendar', U1, `${U1}/events/${another.body.id}`)).toBeNull();
    expect((await request(U1, 'get', '/catalog')).body.templates[0].title).toBe('Focus');
  });

});
