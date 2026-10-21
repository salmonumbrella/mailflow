// Count surfaces observe physical INBOX rows. Other folders, including Google
// labels, require certification; RFC Message-ID/cache presence is not membership.
export function inboxReadMembers(messages) {
  const seen = new Set();
  return (messages || []).filter(message => {
    if (!message || message.folder !== 'INBOX' || message.is_deleted === true
      || !message.id || !message.account_id) return false;
    const key = JSON.stringify([message.account_id, message.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
