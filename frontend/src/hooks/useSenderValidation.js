import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';

export function useSenderValidation(account, alias, selectedAliasId = alias?.id) {
  const userId = useStore(state => state.user?.id);
  const generation = useStore(state => state.countGeneration);
  const locked = useStore(state => state.isLocked);
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const [result, setResult] = useState();
  const accountId = account?.id, aliasId = selectedAliasId;
  const email = aliasId ? alias?.email : account?.email_address;
  const revision = account?.fastmail_config_revision;
  const supported = account?.enabled === true && account?.fastmail_verification_supported === true;
  const configured = account?.fastmail_api_token_configured === true;
  // A UI-only quiet default for the resolved account's actual primary address.
  // This confers no provider permission; the backend classifier is unchanged.
  const primarySelected = typeof email === 'string' && !!email.trim()
    && typeof account?.email_address === 'string'
    && email.trim().toLowerCase() === account.email_address.trim().toLowerCase();
  const key = JSON.stringify([userId, generation, locked, accountId, aliasId, email, revision, supported, configured, primarySelected]);

  useEffect(() => {
    let cancelled = false;
    const marker = {};
    const clearWarning = () => {
      for (const notification of useStore.getState().notifications) {
        if (notification.senderValidation === marker) useStore.getState().removeNotification(notification.id);
      }
    };
    setResult(undefined);
    if (!userId || locked || !accountId || !supported) return;
    const current = () => {
      const state = useStore.getState();
      return !cancelled && !state.isLocked && state.user?.id === userId && state.countGeneration === generation;
    };
    const warn = status => {
      if (status === 'allowed') return;
      const message = status === 'missing' ? translate.current('compose.senderValidation.missing') : status === 'unavailable'
        ? translate.current('compose.senderValidation.unavailable')
        : translate.current('compose.senderValidation.unknown');
      useStore.getState().addNotification({ type: 'error', title: message, body: email,
        senderValidation: marker, allowWrap: true, persistent: true });
    };
    if (!configured) {
      if (current() && !primarySelected) warn('unknown');
      return () => { cancelled = true; clearWarning(); };
    }
    api.getSenderIdentities(accountId, aliasId).then(inventory => {
      if (!current()) return;
      const matches = inventory.provider === 'fastmail' && inventory.accountId === accountId && inventory.configRevision === revision
        && inventory.sender?.email === email;
      if (!matches) { warn('unknown'); return; }
      setResult({ key, inventory });
      warn(inventory.sender.status);
    }).catch(error => { if (current()) warn(error.status === 404 ? 'missing' : 'unknown'); });
    return () => { cancelled = true; clearWarning(); };
  }, [key, userId, generation, locked, accountId, aliasId, email, revision, supported, configured, primarySelected]);

  return result?.key === key ? result.inventory : undefined;
}
