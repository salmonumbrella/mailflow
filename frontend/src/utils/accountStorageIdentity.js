// Compare the mailbox selectors, never credentials or display/sending settings.
export const STORAGE_SELECTOR_FIELDS = ['imap_host', 'imap_port', 'auth_user'];

export function normalizeStorageHost(host) {
  return String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
}

export function accountStorageSelectors(account) {
  const oauth = account.oauth_provider === 'google' || account.oauth_provider === 'microsoft';
  return {
    host: normalizeStorageHost(account.imap_host),
    port: Number(account.imap_port),
    user: String(account.auth_user || (oauth ? account.email_address : '') || '').trim(),
  };
}

export function storageSelectorsChanged(before, updates) {
  const a = accountStorageSelectors(before);
  const b = accountStorageSelectors({ ...before, ...updates });
  return a.host !== b.host || !Object.is(a.port, b.port) || a.user !== b.user;
}
