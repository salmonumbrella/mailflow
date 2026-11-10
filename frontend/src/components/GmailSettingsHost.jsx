import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';

const GmailSettings = lazy(() => import('./GmailSettings.jsx'));

// One host lives in the Gmail shell, not the desktop-only header. Keeping it mounted
// across a resize preserves unsaved settings and uncertain definition recovery.
export default function GmailSettingsHost() {
  const { t } = useTranslation();
  const [target, setTarget] = useState(null);
  const targetRef = useRef(null);
  useEffect(() => {
    const open = event => {
      // The ref also fences two events in one tick, before React commits the first dialog.
      if (targetRef.current) return;
      const native = event.type === 'mailflow:manage-native-labels';
      const accountId = event.detail?.accountId;
      if (native && !useStore.getState().accounts.some(account => account.id === accountId && account.enabled !== false)) return;
      const next = native ? { accountId, tab: 'labels', create: event.detail.create === true } : {};
      targetRef.current = next;
      setTarget(next);
    };
    window.addEventListener('mailflow:manage-native-labels', open);
    window.addEventListener('mailflow:open-gmail-settings', open);
    return () => {
      window.removeEventListener('mailflow:manage-native-labels', open);
      window.removeEventListener('mailflow:open-gmail-settings', open);
    };
  }, []);
  if (!target) return null;
  return <Suspense fallback={<p role="status">{t('gmail.header.loading_settings', 'Loading settings…')}</p>}>
    <GmailSettings onClose={() => { targetRef.current = null; setTarget(null); }} initialTab={target.tab} initialAccountId={target.accountId} initialCreateLabel={target.create} />
  </Suspense>;
}
