import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import GmailQuickSettings from './GmailQuickSettings.jsx';
import { isVisibleSettingsOpener } from '../utils/gmailSettingsFocus.js';

const GmailSettings = lazy(() => import('./GmailSettings.jsx'));
const validTab = tab => ['general', 'labels', 'filters'].includes(tab) ? tab : 'general';

// One shell owner survives resizing and never replaces an active full-settings editor.
export default function GmailSettingsHost({ onShowShortcutHelp }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState(null);
  const targetRef = useRef(null);
  const publish = next => {
    targetRef.current = next;
    setTarget(next);
    window.dispatchEvent(new CustomEvent('mailflow:gmail-quick-settings-changed', { detail: { open: next?.kind === 'quick' } }));
  };
  const close = (restore = true) => {
    const previous = targetRef.current;
    publish(null);
    const activeDialog = document.activeElement?.closest('[role="dialog"], [role="alertdialog"]');
    const ownDialog = activeDialog?.closest('#mailflow-gmail-quick-settings, .mf-gmail-settings');
    if (restore && isVisibleSettingsOpener(previous?.opener) && (!activeDialog || ownDialog)) previous.opener.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const open = event => {
      const state = useStore.getState();
      if (!state.user || state.isLocked || state.layout !== 'gmail') return;
      // Fence same-tick events, before React has committed the first surface.
      if (targetRef.current?.kind === 'full') return;
      if (event.type === 'mailflow:toggle-gmail-quick-settings' || event.type === 'mailflow:open-gmail-quick-settings') {
        if (targetRef.current && event.type === 'mailflow:open-gmail-quick-settings') return;
        if (targetRef.current) { closeRef.current(); return; }
        publish({ kind: 'quick', opener: event.detail?.opener || document.activeElement });
        return;
      }
      const native = event.type === 'mailflow:manage-native-labels';
      const accountId = event.detail?.accountId;
      if (native && !state.accounts.some(account => account.id === accountId && account.enabled !== false)) return;
      const opener = targetRef.current?.opener || document.activeElement;
      publish({ kind: 'full', opener, tab: native ? 'labels' : validTab(event.detail?.tab),
        accountId: native ? accountId : undefined, create: native && event.detail?.create === true });
    };
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id || state.isLocked !== previous.isLocked || state.layout !== previous.layout) closeRef.current(false);
    });
    const events = ['mailflow:manage-native-labels', 'mailflow:open-gmail-settings', 'mailflow:toggle-gmail-quick-settings', 'mailflow:open-gmail-quick-settings'];
    events.forEach(name => window.addEventListener(name, open));
    return () => {
      unsubscribe();
      events.forEach(name => window.removeEventListener(name, open));
      window.dispatchEvent(new CustomEvent('mailflow:gmail-quick-settings-changed', { detail: { open: false } }));
    };
  }, []);
  if (!target) return null;
  if (target.kind === 'quick') return <GmailQuickSettings onClose={() => close()} onShowShortcutHelp={onShowShortcutHelp ? () => { close(); onShowShortcutHelp(); } : undefined} />;
  return <Suspense fallback={<p role="status">{t('gmail.header.loading_settings', 'Loading settings…')}</p>}>
    <GmailSettings onClose={() => close()} restoreFocus={false} initialTab={target.tab} initialAccountId={target.accountId} initialCreateLabel={target.create} />
  </Suspense>;
}
