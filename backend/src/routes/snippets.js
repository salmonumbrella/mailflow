import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { changeSnippet, listSnippets, recordSnippetUse, SnippetError } from '../services/mailSnippets.js';

const router = Router();
router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof SnippetError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

router.get('/', handle(async (req, res) => {
  res.json({ snippets: await listSnippets(req.session.userId) });
}));
router.post('/', handle(async (req, res) => {
  res.status(201).json(await changeSnippet(req.session.userId, 'create', null, req.body));
}));
router.post('/:id/use', handle(async (req, res) => {
  res.json(await recordSnippetUse(req.session.userId, req.params.id, req.body?.requestId));
}));
router.put('/:id', handle(async (req, res) => {
  res.json(await changeSnippet(req.session.userId, 'update', req.params.id, req.body));
}));
router.delete('/:id', handle(async (req, res) => {
  const version = /^\d+$/.test(req.query.version || '') ? Number(req.query.version) : null;
  await changeSnippet(req.session.userId, 'delete', req.params.id, { version });
  res.status(204).end();
}));

export default router;
