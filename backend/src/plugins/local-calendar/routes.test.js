import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../api.js', () => ({ storage: { getOwned: vi.fn(), listOwned: vi.fn(), putOwned: vi.fn(), deleteOwned: vi.fn(), deleteOwnedBatch: vi.fn() }, requireAuth: vi.fn((req, res, next) => req.session?.userId ? next() : res.status(401).json({ error: 'Authentication required' })), isPluginActivated: vi.fn() }));
import { storage, requireAuth, isPluginActivated } from '../api.js';
import router from './routes.js';
const userId = '11111111-1111-4111-8111-111111111111';
const calId = '22222222-2222-4222-8222-222222222222';
const evId = '33333333-3333-4333-8333-333333333333';
const revision = '44444444-4444-4444-8444-444444444444';
const catalog = { revision, value: { calendars: [{ id: calId, name: 'Work', color: '#aabbcc', visible: true }], templates: [], timezone: 'UTC', weekStart: 1 } };
async function call(method, path, { body = {}, query = {}, params = {}, session = { userId } } = {}) {
  const req = { body, query, params, session };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  let passed = false;
  requireAuth(req, res, () => { passed = true; }); if (!passed) return res;
  passed = false; await router.stack[1].handle(req, res, () => { passed = true; }); if (!passed) return res;
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
  await route.route.stack[0].handle(req, res, err => { throw err; });
  return res;
}
beforeEach(() => { vi.clearAllMocks(); isPluginActivated.mockResolvedValue(true); storage.getOwned.mockResolvedValue(catalog); storage.listOwned.mockResolvedValue({ items: [], nextCursor: null }); storage.putOwned.mockImplementation(async (plugin, owner, key, value) => ({ key, value, revision })); });
describe('owner-scoped local-calendar routes', () => {
  it('requires authentication and explicit per-user activation', async () => {
    expect((await call('get', '/catalog', { session: {} })).statusCode).toBe(401);
    isPluginActivated.mockResolvedValue(false);
    expect((await call('get', '/catalog')).statusCode).toBe(403);
    expect(storage.getOwned).not.toHaveBeenCalled();
  });
  it('returns an empty catalog without seeding fictional events or mutating on read', async () => {
    storage.getOwned.mockResolvedValue(null);
    expect((await call('get', '/catalog')).body).toMatchObject({ calendars: [], templates: [], revision: null });
    expect(storage.putOwned).not.toHaveBeenCalled();
  });
  it('bounds requested ranges and filters event records before pagination', async () => {
    const query = { start: '2026-01-01T00:00:00Z', end: '2026-01-08T00:00:00Z', after: 'cursor' };
    expect((await call('get', '/events', { query })).statusCode).toBe(200);
    expect(storage.listOwned).toHaveBeenCalledWith('local-calendar', userId, expect.objectContaining({ after: 'cursor', limit: 200, filters: [{ field: 'rangeStart', op: 'lt', value: '2026-01-08T00:00:00.000Z' }, { field: 'rangeEnd', op: 'gt', value: '2026-01-01T00:00:00.000Z' }] }));
    expect((await call('get', '/events', { query: { ...query, end: '2027-01-08T00:00:00Z' } })).statusCode).toBe(400);
  });
  it('creates events in the authenticated scope and guards the calendar catalog', async () => {
    const body = { title: 'Call', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z', calendarId: calId, allDay: false, timezone: 'UTC', ownerId: 'attacker' };
    const response = await call('post', '/events', { body });
    expect(response.statusCode).toBe(201);
    expect(storage.putOwned).toHaveBeenCalledWith('local-calendar', userId, expect.stringMatching(new RegExp(`^${userId}/events/`)), expect.objectContaining({ title: 'Call' }), { expectedRevision: null, guard: { key: `${userId}/catalog`, revision } });
    expect(response.body.ownerId).toBeUndefined();
  });
  it('reports stale updates/deletes as conflicts without overwriting', async () => {
    storage.putOwned.mockResolvedValue(null);
    const body = { title: 'Call', start: '2026-01-01', end: '2026-01-03', calendarId: calId, allDay: true, timezone: 'UTC', revision };
    expect((await call('put', '/events/:id', { body, params: { id: evId } })).statusCode).toBe(409);
    storage.deleteOwned.mockResolvedValue(false);
    expect((await call('delete', '/events/:id', { params: { id: evId }, query: { revision } })).statusCode).toBe(409);
    storage.getOwned.mockResolvedValue(null);
    expect((await call('delete', '/events/:id', { params: { id: evId }, query: { revision } })).statusCode).toBe(404);
  });
  it('removing a calendar tombstones its ID and never exposes its events', async () => {
    expect((await call('put', '/catalog', { body: { ...catalog.value, calendars: [], revision } })).statusCode).toBe(200);
    expect(storage.putOwned).toHaveBeenCalledWith('local-calendar', userId, `${userId}/catalog`, expect.objectContaining({ deletedCalendarIds: [calId], calendars: [] }), { expectedRevision: revision });
    storage.getOwned.mockResolvedValue({ ...catalog, value: { ...catalog.value, calendars: [], deletedCalendarIds: [calId] } });
    expect((await call('put', '/catalog', { body: { ...catalog.value, revision } })).statusCode).toBe(400);
    storage.listOwned.mockResolvedValue({ items: [{ value: { id: evId, calendarId: calId }, revision }], nextCursor: 'next' });
    const result = await call('get', '/events', { query: { start: '2026-01-01T00:00:00Z', end: '2026-01-08T00:00:00Z' } });
    expect(result.body).toEqual({ items: [], nextCursor: 'next' });
  });
  it('bounds cleanup requests and leaves failures visible and retryable', async () => {
    const pending = { ...catalog, value: { ...catalog.value, calendars: [], deletedCalendarIds: [calId], pendingCleanupIds: [calId] } };
    storage.getOwned.mockResolvedValue(pending);
    storage.listOwned.mockResolvedValue({ items: [{ key: `${userId}/events/${evId}`, revision }], nextCursor: 'more' });
    storage.deleteOwnedBatch.mockResolvedValue(1);
    const result = await call('post', '/cleanup');
    expect(storage.listOwned).toHaveBeenCalledTimes(5);
    expect(storage.deleteOwnedBatch).toHaveBeenCalledTimes(5);
    expect(result.body.pendingCleanupIds).toEqual([calId]);
    storage.listOwned.mockRejectedValue(new Error('database unavailable'));
    const failed = await call('post', '/cleanup');
    expect(failed.body.pendingCleanupIds).toEqual([calId]);
    expect(failed.body.cleanupError).toMatch(/could not be deleted/);
    storage.listOwned.mockResolvedValue({ items: [], nextCursor: null });
    expect((await call('post', '/cleanup')).body.pendingCleanupIds).toEqual([]);
  });

  it('stores owner-scoped time formats, reads them back, and preserves them for older clients', async () => {
    const result = await call('put', '/catalog', { body: { ...catalog.value, timeFormat: '12h', revision } });
    expect(result.body.timeFormat).toBe('12h');
    expect(storage.putOwned).toHaveBeenCalledWith('local-calendar', userId, `${userId}/catalog`, expect.objectContaining({ timeFormat: '12h' }), { expectedRevision: revision });
    storage.getOwned.mockResolvedValue({ ...catalog, value: { ...catalog.value, timeFormat: '12h' } });
    expect((await call('get', '/catalog')).body.timeFormat).toBe('12h');
    const legacyWrite = await call('put', '/catalog', { body: { ...catalog.value, revision } });
    expect(legacyWrite.body.timeFormat).toBe('12h');
    expect((await call('put', '/catalog', { body: { ...catalog.value, revision, timeFormat: '24h' } })).body.timeFormat).toBe('24h');
    expect((await call('put', '/catalog', { body: { ...catalog.value, revision, timeFormat: false } })).statusCode).toBe(400);
    storage.getOwned.mockResolvedValue(catalog);
    expect((await call('get', '/catalog')).body.timeFormat).toBe('24h');
  });

});
