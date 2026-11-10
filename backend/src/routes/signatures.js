import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { SignatureError, getSignatureLibrary, saveSignatureLibrary } from '../services/signatureLibrary.js';
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => req.apiToken ? res.status(403).json({ error: 'Signature settings require a browser session' }) : next());
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (error) {
    if (error instanceof SignatureError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
};
router.get('/:accountId', handle(async (req, res) => res.json(await getSignatureLibrary(req.session.userId, req.params.accountId))));
router.put('/:accountId', handle(async (req, res) => res.json(await saveSignatureLibrary(req.session.userId, req.params.accountId, req.body))));
export default router;
