import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { LabelError, listDefinitions, previewDeletion, createDefinition, updateDefinition, deleteDefinition } from '../services/nativeLabelDefinitions.js';

const router = Router();
router.use(requireAuth);
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (error) {
    if (error instanceof LabelError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
};
// The push transport lives on the manager, but broadcasting never issues an IMAP command.
// A push failure must not change the result of an already committed transaction.
function publish(req, outcome) {
  if (!outcome.changed) return;
  try { req.app.get('imapManager')?.broadcast({ type: 'labels_changed', accountId: req.body.accountId, treeRevision: outcome.result.treeRevision }, req.session.userId); }
  catch (error) { console.warn('Label update notification failed:', error.message); }
}
router.get('/', handle(async (req, res) => res.json(await listDefinitions(req.session.userId, req.query))));
router.post('/', handle(async (req, res) => {
  const outcome = await createDefinition(req.session.userId, req.body);
  publish(req, outcome);
  res.status(201).json(outcome.result);
}));
router.patch('/:id', handle(async (req, res) => {
  const outcome = await updateDefinition(req.session.userId, req.params.id, req.body);
  publish(req, outcome);
  res.json(outcome.result);
}));
router.post('/:id/delete-preview', handle(async (req, res) => res.json(await previewDeletion(req.session.userId, req.params.id, req.body))));
router.delete('/:id', handle(async (req, res) => {
  const outcome = await deleteDefinition(req.session.userId, req.params.id, req.body);
  publish(req, outcome);
  res.json(outcome.result);
}));
export default router;
