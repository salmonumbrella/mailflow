import { randomUUID } from 'crypto';
import { findOwnedAccount, findOwnedMessage } from './ownership.js';
import { buildCalendarReply, InvitationError, invitationKey, invitationSeriesKey, MAX_INVITATION_SOURCE_BYTES, trustedInvitation } from './calendarInvitation.js';
import { checkInvitationMasterSequence, claimInvitationDelivery, observeInvitationSequence, readInvitationResponse, reserveInvitationResponse, updateInvitationResponse, publicInvitationResponse } from './invitationLedger.js';
import { validateSendInput, resolveIdentity, prepareDelivery, deliverAndRecord } from './outgoingMail.js';
import { classifySendError } from './scheduledSendRules.js';

async function owned(userId, messageId) {
  const message = await findOwnedMessage(userId, messageId, { live: true, enabledAccount: true });
  if (!message) throw new InvitationError(404, 'Message not found.');
  const account = await findOwnedAccount(userId, message.account_id, { enabled: true });
  if (!account) throw new InvitationError(404, 'Account not found.');
  return { message, account };
}

export async function loadInvitation(userId, messageId, engine) {
  const { message, account } = await owned(userId, messageId);
  let source;
  try { source = await engine.fetchRawMessage(account, message.uid, message.folder, { maximumBytes: MAX_INVITATION_SOURCE_BYTES }); }
  catch (cause) {
    throw new InvitationError(cause?.code === 'MESSAGE_TOO_LARGE' ? 422 : 502, cause?.code === 'MESSAGE_TOO_LARGE' ? 'This invitation is too large to respond to here.' : 'The invitation could not be read from your mail server. Try again.');
  }
  const invitation = trustedInvitation(source, message, account);
  await observeInvitationSequence(invitationSeriesKey(userId, account.id, invitation), invitation.sequence, invitation.cancelled, { userId, accountId: account.id });
  const masterSeriesKey = invitation.recurrenceIdentity ? invitationSeriesKey(userId, account.id, { ...invitation, recurrenceIdentity: null }) : null;
  if (masterSeriesKey) await checkInvitationMasterSequence(masterSeriesKey, invitation.sequence, { userId, accountId: account.id });
  return { invitation, message, account, key: invitationKey(userId, account.id, invitation), masterSeriesKey };
}

function publicInvitation(invitation) {
  const { summary, organizer, attendee, start, timeZone, dateOnly, sequence, recurrenceId, recurrenceRange, revision } = invitation;
  return { summary, organizer, attendee, start, timeZone, dateOnly, sequence, recurringInstance: Boolean(recurrenceId), recurrenceRange, revision };
}

export async function getInvitation(userId, messageId, engine) {
  const loaded = await loadInvitation(userId, messageId, engine);
  return { invitation: publicInvitation(loaded.invitation), response: publicInvitationResponse(await readInvitationResponse(loaded.key, Date.now(), { userId, accountId: loaded.account.id })) };
}

export async function respondToInvitation(userId, messageId, body, engine) {
  const { invitation, message, account, key, masterSeriesKey } = await loadInvitation(userId, messageId, engine);
  if (body.revision !== invitation.revision) throw new InvitationError(409, 'The invitation changed. Reload it before responding.', 'invitation_changed');
  const content = buildCalendarReply(invitation, body.response);
  const scope = { userId, accountId: account.id };
  const reserved = await reserveInvitationResponse(key, body, Date.now(), scope);
  if (!reserved.acquired) return { invitation: publicInvitation(invitation), response: publicInvitationResponse(reserved.state) };
  const { attemptId } = reserved.state;
  let phase = 'prepare', delivery, accepted = false;
  try {
    const input = validateSendInput({
      accountId: account.id, to: [invitation.organizer], cc: [], bcc: [],
      subject: `${{ ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' }[body.response]}: ${invitation.summary}`,
      body: `${invitation.attendee} ${body.response.toLowerCase()} the invitation: ${invitation.summary}.`,
      editedSignature: '', inReplyTo: message.message_id,
      attachments: [{ filename: 'reply.ics', contentType: 'text/calendar; charset=utf-8; method=REPLY', content: Buffer.from(content).toString('base64') }],
    });
    const identity = await resolveIdentity(userId, input);
    if (identity.fromEmail.toLowerCase() !== invitation.attendee) throw new InvitationError(409, 'The sending identity changed. Reload the invitation.', 'identity_changed');
    delivery = await prepareDelivery(input, identity, { attachments: [], messages: [] }, { messageId: `<${randomUUID()}@${invitation.attendee.split('@')[1]}>` });
    const current = await owned(userId, messageId);
    if (current.account.email_address.toLowerCase() !== invitation.attendee || current.message.message_id !== message.message_id) throw new InvitationError(409, 'The message or sending account changed. Reload the invitation.', 'identity_changed');
    // Token refresh/preparation can take a while. A newer invitation or cancellation opened
    // meanwhile must supersede this one before it is handed to SMTP.
    await observeInvitationSequence(invitationSeriesKey(userId, account.id, invitation), invitation.sequence, invitation.cancelled, { userId, accountId: account.id });
    // A stale preparation that lost its reservation must never reach SMTP.
    const ready = await claimInvitationDelivery(key, attemptId, invitationSeriesKey(userId, account.id, invitation), invitation.sequence, scope, masterSeriesKey);
    if (!ready) return { invitation: publicInvitation(invitation), response: publicInvitationResponse(await readInvitationResponse(key, Date.now(), scope)) };
    phase = 'send';
    const result = await deliverAndRecord({ userId, input, identity, delivery }, {
      onDelivered: async early => {
        if (early.rejected?.length) {
          await updateInvitationResponse(key, attemptId, { status: 'failed', code: 'smtp_rejected' }, scope);
          return;
        }
        accepted = true;
        await updateInvitationResponse(key, attemptId, { status: 'sent', code: null }, scope);
      },
    });
    if (!result.rejected?.length) {
      accepted = true;
      await updateInvitationResponse(key, attemptId, { status: 'sent', code: null, ...(result.sentCopySaved === false ? { sentCopySaved: false } : {}) }, scope);
    } else await updateInvitationResponse(key, attemptId, { status: 'failed', code: 'smtp_rejected' }, scope);
  } catch (err) {
    // A failed status write after acceptance is not a failed delivery. Leave the reservation
    // intact and surface uncertainty, rather than allowing a second response to be sent.
    if (accepted) throw new InvitationError(503, 'The response was accepted by your mail server, but its saved status is unavailable. Check Sent before trying again.', 'response_unavailable');
    const classification = err instanceof InvitationError ? { outcome: 'failed', code: err.code } : classifySendError(err, { phase });
    await updateInvitationResponse(key, attemptId, { status: classification.outcome === 'uncertain' ? 'uncertain' : 'failed', code: classification.code }, scope);
  } finally {
    delivery?.transport?.close?.();
  }
  return { invitation: publicInvitation(invitation), response: publicInvitationResponse(await readInvitationResponse(key, Date.now(), scope)) };
}
