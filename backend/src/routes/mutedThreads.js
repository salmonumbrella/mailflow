import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getMutedThread, listMutedThreads, setMutedThread, MutedThreadError } from '../services/mutedThreads.js';
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) { if (error instanceof MutedThreadError) return res.status(error.status).json({ error: error.message }); next(error); }
};
router.get('/muted', handle(async (req, res) => {
  if (req.query.account_id !== undefined && typeof req.query.account_id !== 'string') throw new MutedThreadError(400, 'Invalid account');
  if (req.query.offset !== undefined && !/^\d{1,6}$/.test(req.query.offset)) throw new MutedThreadError(400, 'Invalid page');
  res.json(await listMutedThreads(req.session.userId, { accountId: req.query.account_id || null, offset: Number(req.query.offset || 0) }));
}));
router.get('/messages/:id/mute', handle(async (req, res) => res.json(await getMutedThread(req.session.userId, req.params.id))));
router.patch('/messages/:id/mute', handle(async (req, res) => res.json(await setMutedThread(req.session.userId, req.params.id, req.body))));
export default router;
