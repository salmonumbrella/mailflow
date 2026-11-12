export const OPEN_ACTIVITY_NOTICE = 'Image loads are not proof that a person read your email. Proxies, prefetching, forwards and your own Sent view can cause loads; blocked images can hide them. Counts are rate-limited. No recipient, IP, location or device is identified. Activity expires after 30 days.';

export function initialOpenActivityChoice(composeData) {
  // Ordinary IMAP drafts never contain this setting or a pixel. Reopening one starts off.
  // Only an explicitly opted-in scheduled send keeps the prior choice visibly checked.
  return Boolean(composeData?.scheduled?.id && composeData?.trackOpens === true);
}

export function openActivityStatus(activity, t = (_key, fallback, values = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name] ?? '')) {
  if (!activity) return '';
  if (activity.status !== 'sent') return ({
    prepared: t('openActivity.status.prepared', "Prepared, not sent"), sending: t('openActivity.status.sending', "Delivery not yet confirmed"), cancelled: t('openActivity.status.cancelled', "Send cancelled"),
    failed: t('openActivity.status.failed', "Send failed"), uncertain: t('openActivity.status.uncertain', "Delivery outcome uncertain"),
  })[activity.status] || t('openActivity.status.unconfirmed', "Delivery not confirmed");
  if (!activity.loadCount) return t('openActivity.status.noLoads', "No image loads recorded");
  const count = activity.loadCount >= 1000 ? '1000+' : activity.loadCount;
  return activity.loadCount === 1 ? t('openActivity.status.load', "{{count}} image load recorded", { count }) : t('openActivity.status.loads', "{{count}} image loads recorded", { count });
}

export function outgoingActivityCandidate(message, accounts = []) {
  if (!message?.id || !message?.account_id) return false;
  const account = accounts.find(item => item.id === message.account_id);
  if (!account) return false;
  const sender = String(message.from_address || '').toLowerCase();
  return sender && [account.email_address, ...(account.aliases || []).map(alias => alias.email)]
    .some(address => address && address.toLowerCase() === sender)
    || /^(?:sent|sent items|sent mail|\[gmail\]\/sent mail)$/i.test(message.folder || '')
    || Boolean(account.folder_mappings?.sent && message.folder === account.folder_mappings.sent);
}
