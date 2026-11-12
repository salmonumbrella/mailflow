import { useTranslation } from 'react-i18next';
import { htmlLang } from '../utils/browserLanguage.js';
import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { OPEN_ACTIVITY_NOTICE, openActivityStatus, outgoingActivityCandidate } from '../utils/openActivity.js';

export default function MessageOpenActivity({ message }) {
  const owner = useStore(state => state.user?.id);
  const accounts = useStore(state => state.accounts);
  return owner && outgoingActivityCandidate(message, accounts)
    ? <OwnedMessageActivity key={`${owner}:${message.account_id}:${message.id}`} owner={owner} messageId={message.id} /> : null;
}

function OwnedMessageActivity({ owner, messageId }) {
  const { t, i18n } = useTranslation();
  const [activity, setActivity] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/open-activity/message/${encodeURIComponent(messageId)}`).then(result => {
      if (live && useStore.getState().user?.id === owner) setActivity(result.activity || null);
    }).catch(() => {});
    return () => { live = false; };
  }, [owner, messageId]);
  if (!activity) return null;
  return <details style={{ margin: '10px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
    <summary style={{ cursor: 'pointer' }}>{t('openActivity.messageStatus', "Open activity: {{status}}", { status: openActivityStatus(activity, t) })}</summary>
    <p>{t('openActivity.notice', OPEN_ACTIVITY_NOTICE)}</p>
    {activity.lastLoadedAt && <p>{t('openActivity.lastRecorded', "Last recorded image load: {{date}}", { date: new Date(activity.lastLoadedAt).toLocaleString(htmlLang(i18n.language)) })}</p>}
  </details>;
}
