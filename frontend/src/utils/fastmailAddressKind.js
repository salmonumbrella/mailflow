// Display evidence only. This must never decide whether a sender may send mail.
function normalizeAddress(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  // Concrete mailbox addresses only: no display names, wildcards or header text.
  return /^[^\s@<>*]+@[^\s@<>*]+\.[^\s@<>*]+$/.test(email) ? email : null;
}

export function classifyFastmailAddress({ account, email, inventory }) {
  const address = normalizeAddress(email);
  if (!address || !account?.id || account.enabled !== true
    || inventory?.provider !== 'fastmail' || inventory.accountId !== account.id
    || typeof account.fastmail_config_revision !== 'string' || !account.fastmail_config_revision
    || inventory.configRevision !== account.fastmail_config_revision) return 'unknown';

  if (address === normalizeAddress(account.email_address)) return 'primary';
  if (inventory.maskedStatus !== 'ready' || !Array.isArray(inventory.maskedEmails)) return 'unknown';
  const includes = entries => Array.isArray(entries)
    && entries.some(entry => normalizeAddress(entry?.email) === address);
  if (includes(inventory.maskedEmails)) return 'masked';
  if (includes(account.aliases)
    || (inventory.identityStatus === 'ready' && includes(inventory.identities))) return 'alias';
  return 'unknown';
}
