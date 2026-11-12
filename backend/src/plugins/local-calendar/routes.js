import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { storage, requireAuth, isPluginActivated } from '../api.js';
import { PLUGIN_ID, catalogKey, eventPrefix, validId, fail, instant, catalogData, eventData } from './model.js';

const router = Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  if (!await isPluginActivated(req.session.userId, PLUGIN_ID)) return res.status(403).json({ error: 'Enable MailFlow calendar in Settings → Plugins first.' });
  next();
});
const defaults = () => ({ calendars: [], templates: [], timezone: 'UTC', weekStart: 1, timeFormat: '24h' });
const loadCatalog = userId => storage.getOwned(PLUGIN_ID, userId, catalogKey(userId));
const response = row => row ? { timeFormat: '24h', ...row.value, revision: row.revision } : { ...defaults(), revision: null };
const action = fn => async (req, res, next) => { try { await fn(req, res); } catch (err) { if (err.status) res.status(err.status).json({ error: err.message }); else next(err); } };
// Persist the pending IDs before deleting children. A crash or database failure therefore
// remains visible and retryable; each request performs at most 1,000 CAS-protected deletions.
async function cleanupCatalog(userId, row) {
  if (!row?.value.pendingCleanupIds?.length) return { row, cleanupError: null };
  const pending = [...row.value.pendingCleanupIds];
  try {
    for (let batch = 0; batch < 5 && pending.length; batch++) {
      const page = await storage.listOwned(PLUGIN_ID, userId, { prefix: eventPrefix(userId), limit: 200,
        filters: [{ field: 'calendarId', op: 'eq', value: pending[0] }] });
      await storage.deleteOwnedBatch(PLUGIN_ID, userId, page.items.map(({ key, revision }) => ({ key, revision })));
      if (!page.nextCursor) pending.shift();
    }
    if (pending.length !== row.value.pendingCleanupIds.length) {
      const saved = await storage.putOwned(PLUGIN_ID, userId, catalogKey(userId), { ...row.value, pendingCleanupIds: pending }, { expectedRevision: row.revision });
      // A newer catalog is never overwritten merely to record cleanup progress.
      row = saved || await loadCatalog(userId) || row;
    }
    return { row, cleanupError: null };
  } catch {
    return { row, cleanupError: 'The calendar was removed, but some event data could not be deleted. Use Finish cleanup to retry.' };
  }
}
router.post('/cleanup', action(async (req, res) => {
  const result = await cleanupCatalog(req.session.userId, await loadCatalog(req.session.userId));
  res.json({ ...response(result.row), cleanupError: result.cleanupError });
}));
router.get('/catalog', action(async (req, res) => res.json(response(await loadCatalog(req.session.userId)))));
router.put('/catalog', action(async (req, res) => {
  const userId = req.session.userId;
  const value = catalogData(req.body);
  const current = await loadCatalog(userId);
  if (req.body.timeFormat === undefined && current?.value.timeFormat) value.timeFormat = current.value.timeFormat;
  if ((current?.revision ?? null) !== req.body.revision) fail('Calendar settings changed. Reload before saving.', 409);
  // IDs cannot be reused after removal, so old hidden events can never reappear.
  const deletedCalendarIds = [...new Set([...(current?.value.deletedCalendarIds || []), ...(current?.value.calendars || []).filter(c => !value.calendars.some(next => next.id === c.id)).map(c => c.id)])];
  if (value.calendars.some(c => deletedCalendarIds.includes(c.id))) fail('A removed calendar cannot be restored with the same ID');
  if (deletedCalendarIds.length > 3000) fail('Calendar history limit reached');
  const pendingCleanupIds = [...new Set([...(current?.value.pendingCleanupIds || []), ...(current?.value.calendars || []).filter(c => !value.calendars.some(next => next.id === c.id)).map(c => c.id)])];
  const storedValue = { ...value, deletedCalendarIds, pendingCleanupIds };
  if (Buffer.byteLength(JSON.stringify(storedValue)) > 250000) fail('Calendar data is too large. Finish pending cleanup or shorten event templates first.');
  const result = await storage.putOwned(PLUGIN_ID, userId, catalogKey(userId), storedValue, { expectedRevision: req.body.revision });
  if (!result) fail('Calendar settings changed. Reload before saving.', 409);
  const cleaned = await cleanupCatalog(userId, result);
  res.json({ ...response(cleaned.row), cleanupError: cleaned.cleanupError });
}));
router.get('/events', action(async (req, res) => {
  const start = instant(req.query.start);
  const end = instant(req.query.end);
  if (end <= start || Date.parse(end) - Date.parse(start) > 100 * 86400000) fail('Choose a date range of at most 100 days');
  if (req.query.after != null && (typeof req.query.after !== 'string' || req.query.after.length > 255)) fail('Invalid event page cursor');
  const userId = req.session.userId;
  const catalog = await loadCatalog(userId);
  const page = await storage.listOwned(PLUGIN_ID, userId, { prefix: eventPrefix(userId), after: req.query.after ?? null, limit: 200,
    filters: [{ field: 'rangeStart', op: 'lt', value: end }, { field: 'rangeEnd', op: 'gt', value: start }] });
  res.json({ items: page.items.filter(row => catalog?.value.calendars.some(c => c.id === row.value.calendarId)).map(row => ({ ...row.value, revision: row.revision })), nextCursor: page.nextCursor });
}));
async function saveEvent(req, res, create) {
  const userId = req.session.userId;
  const id = create ? randomUUID() : req.params.id;
  if (!validId(id)) fail('Event not found', 404);
  const catalog = await loadCatalog(userId);
  const data = eventData(req.body, catalog?.value.calendars || []);
  if (!create && !await storage.getOwned(PLUGIN_ID, userId, eventPrefix(userId) + id)) fail('Event not found', 404);
  if (!create && !validId(req.body.revision)) fail('Event revision required');
  const row = await storage.putOwned(PLUGIN_ID, userId, eventPrefix(userId) + id, { ...data, id }, {
    expectedRevision: create ? null : req.body.revision, guard: { key: catalogKey(userId), revision: catalog.revision },
  });
  if (!row) fail('The event or calendar changed. Reload before saving.', 409);
  res.status(create ? 201 : 200).json({ ...row.value, revision: row.revision });
}
router.post('/events', action((req, res) => saveEvent(req, res, true)));
router.put('/events/:id', action((req, res) => saveEvent(req, res, false)));
router.delete('/events/:id', action(async (req, res) => {
  if (!validId(req.params.id)) fail('Event not found', 404);
  const userId = req.session.userId;
  const key = eventPrefix(userId) + req.params.id;
  if (!await storage.getOwned(PLUGIN_ID, userId, key)) fail('Event not found', 404);
  if (typeof req.query.revision !== 'string' || !req.query.revision || req.query.revision.length > 64) fail('Event revision required');
  if (!await storage.deleteOwned(PLUGIN_ID, userId, key, { expectedRevision: req.query.revision })) fail('The event changed. Reload before deleting.', 409);
  res.json({ ok: true });
}));
export default router;
