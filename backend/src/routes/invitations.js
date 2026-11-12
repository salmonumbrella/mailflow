import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getInvitation, respondToInvitation } from '../services/invitationResponses.js';
import { InvitationError } from '../services/calendarInvitation.js';
import { UUID_RE } from '../services/outgoingMail.js';
import { consume } from '../services/rateLimiter.js';

const router = Router();
router.use(requireAuth);
const allowed = new Set(['response', 'revision', 'requestId', 'expectedAttemptId', 'retry']);

function validateBody(body) {
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw new InvitationError(400, 'Only a response to this stored invitation can be submitted.');
  if (!['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(body.response) || !/^[a-f0-9]{64}$/.test(body.revision || '') || !UUID_RE.test(body.requestId || '') || (body.expectedAttemptId != null && !UUID_RE.test(body.expectedAttemptId)) || (body.retry !== undefined && typeof body.retry !== 'boolean')) throw new InvitationError(400, 'Invalid invitation response.');
}

for (const method of ['get', 'post']) {
  router[method]('/messages/:id/invitation', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) throw new InvitationError(400, 'Invalid message id.');
      if (method === 'post') validateBody(req.body);
      const { limited } = await consume(`invitations:${req.session.userId}`, 90, 60_000);
      if (limited) throw new InvitationError(429, 'Too many invitation requests. Please wait a minute.');
      const engine = req.app.get('imapManager');
      const data = method === 'get'
        ? await getInvitation(req.session.userId, req.params.id, engine)
        : await respondToInvitation(req.session.userId, req.params.id, req.body, engine);
      res.status(data.response?.status === 'pending' ? 202 : 200).json(data);
    } catch (err) {
      if (err instanceof InvitationError) res.status(err.status).json({ error: err.message, code: err.code });
      else next(err);
    }
  });
}
export default router;
