import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

export function hasCalendarInvitation(body) {
  return Boolean(body && ((body.attachments || []).some(a => /^(?:text\/calendar|application\/(?:ics|icalendar))(?:;|$)/i.test(a.type || '') || /\.ics$/i.test(a.filename || '')) || /^(?:Meeting invitation|Meeting cancelled|BEGIN:VCALENDAR)/i.test((body.text || '').trim())));
}

const buttonStyle = { border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', background: 'var(--bg-primary)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 };

function ResponsePanel({ message, onArchive }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState(null);
  const [uncertainRequest, setUncertainRequest] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  const generation = useRef(0);
  const labels = {
    ACCEPTED: t('invitation.accepted', { defaultValue: 'Accepted' }),
    TENTATIVE: t('invitation.tentative', { defaultValue: 'Tentative' }),
    DECLINED: t('invitation.declined', { defaultValue: 'Declined' }),
  };

  const refresh = async () => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const result = await api.getInvitation(message.id);
      if (!alive.current || version !== generation.current) return;
      setData(result);
      setError('');
      setUncertainRequest(false);
    } catch (err) {
      if (alive.current && version === generation.current) setError(err.message);
    } finally {
      if (alive.current && version === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
    // The keyed component is replaced when the message changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (data?.response?.status !== 'pending' || busy) return;
    const timer = setTimeout(refresh, 10_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, busy]);

  const submit = async () => {
    if (running.current || !choice || !data?.invitation || uncertainRequest || loading) return;
    running.current = true;
    setBusy(true);
    setError('');
    const version = ++generation.current;
    try {
      const result = await api.respondToInvitation(message.id, {
        response: choice, revision: data.invitation.revision, requestId: crypto.randomUUID(),
        expectedAttemptId: data.response?.attemptId || null, retry: data.response?.status === 'failed',
      });
      if (!alive.current || generation.current !== version) return;
      setData(result);
      setChoice(null);
    } catch (err) {
      if (alive.current && generation.current === version) {
        setError(err.message);
        // A network failure is not evidence that SMTP failed. Read the durable state first.
        setUncertainRequest(true);
      }
    } finally {
      running.current = false;
      if (alive.current && generation.current === version) setBusy(false);
    }
  };
  const archive = async () => {
    if (archiving || data?.response?.status !== 'sent') return;
    setArchiving(true);
    try { await onArchive(); }
    catch (err) { if (alive.current) setError(err.message || t('invitation.archiveFailed', { defaultValue: 'The response was sent, but the invitation could not be archived.' })); }
    finally { if (alive.current) setArchiving(false); }
  };
  const state = data?.response?.status;
  const invalidated = ['outdated_invitation', 'cancelled_invitation', 'identity_changed', 'message_changed'].includes(data?.response?.code);
  const disabled = busy || loading || uncertainRequest || invalidated || state === 'pending' || state === 'uncertain';
  const invitation = data?.invitation;
  return (
    <section aria-label={t('invitation.title', { defaultValue: 'Meeting response' })} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, margin: '12px 0', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('invitation.title', { defaultValue: 'Meeting response' })}</div>
      {loading && !data && <div role="status">{t('invitation.loading', { defaultValue: 'Checking invitation…' })}</div>}
      {invitation && <>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, overflowWrap: 'anywhere' }}>
          {t('invitation.delivery', { defaultValue: 'Your response will be emailed to {{organizer}} from {{attendee}}.', organizer: invitation.organizer, attendee: invitation.attendee })}
          {invitation.recurringInstance && ` ${invitation.recurrenceRange === 'THISANDFUTURE'
            ? t('invitation.futureInstances', { defaultValue: 'This response applies to this and future recurring event instances.' })
            : t('invitation.instance', { defaultValue: 'This response is for the specified recurring event instance.' })}`}
        </div>
        <div role="status" aria-live="polite" style={{ fontSize: 12, marginBottom: 8 }}>
          {state === 'sent' && t('invitation.sent', { defaultValue: '{{response}} response sent.', response: labels[data.response.response] })}
          {state === 'pending' && t('invitation.pending', { defaultValue: 'Sending response. Its saved status will update here.' })}
          {state === 'failed' && (invalidated
            ? t('invitation.changed', { defaultValue: 'The invitation or sending account changed before delivery. No response was sent. Open the latest invitation.' })
            : t('invitation.failed', { defaultValue: 'The response was not sent. Check your sending settings, then retry.' }))}
          {state === 'uncertain' && t('invitation.uncertain', { defaultValue: 'Delivery is uncertain. Check your Sent folder or calendar before taking further action. MailFlow will not send it again automatically.' })}
          {data.response?.sentCopySaved === false && ` ${t('invitation.copyFailed', { defaultValue: 'Your mail server accepted it, but the Sent copy could not be saved.' })}`}
          {state !== 'sent' && data.response?.previousResponse && ` ${t('invitation.previous', { defaultValue: 'Previous response: {{response}}.', response: labels[data.response.previousResponse] })}`}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {['ACCEPTED', 'TENTATIVE', 'DECLINED'].map(response => <button key={response} type="button" style={{ ...buttonStyle, ...(choice === response ? { border: '1px solid var(--accent)', boxShadow: '0 0 0 1px var(--accent)' } : {}) }} disabled={disabled || (state === 'sent' && data.response.response === response)} aria-pressed={choice === response} onClick={() => setChoice(response)}>
            {response === 'ACCEPTED' ? t('invitation.accept', { defaultValue: 'Accept' }) : response === 'DECLINED' ? t('invitation.decline', { defaultValue: 'Decline' }) : labels.TENTATIVE}
          </button>)}
          {state === 'sent' && onArchive && <button type="button" style={buttonStyle} disabled={archiving || busy} onClick={archive}>{t('invitation.archive', { defaultValue: 'Archive invitation' })}</button>}
        </div>
        {choice && <div style={{ marginTop: 10, display: 'flex', gap: 7, alignItems: 'center' }}>
          <button type="button" style={{ ...buttonStyle, background: 'var(--accent)', color: '#fff' }} disabled={disabled} onClick={submit}>
            {busy ? t('invitation.sending', { defaultValue: 'Sending…' }) : t('invitation.send', { defaultValue: 'Send {{response}} response', response: labels[choice].toLowerCase() })}
          </button>
          <button type="button" style={buttonStyle} disabled={busy} onClick={() => setChoice(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
        </div>}
      </>}
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger, #c34949)' }}>{error}</div>}
      {uncertainRequest && <div role="status" style={{ marginTop: 6, fontSize: 12 }}>{t('invitation.checkFirst', { defaultValue: 'Delivery has not been confirmed. Check the saved status before trying again.' })}</div>}
      {(error || state === 'uncertain' || state === 'pending' || state === 'failed') && <button type="button" style={{ ...buttonStyle, marginTop: 8 }} disabled={loading || busy} onClick={refresh}>{t('invitation.check', { defaultValue: 'Check response status' })}</button>}
    </section>
  );
}

export default function InvitationResponsePanel({ message, body, onArchive }) {
  return message?.id && hasCalendarInvitation(body) ? <ResponsePanel key={message.id} message={message} onArchive={onArchive} /> : null;
}
