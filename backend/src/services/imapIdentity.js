// SEARCH HEADER matches substrings. Destructive/retargeted operations need exactly
// one live RFC identity, verified while the caller holds the selected mailbox lock.
export function normalizeMessageId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().replace(/^<([^<>]*)>$/, '$1');
  return /^[^<>\s@]+@[^<>\s@]+$/.test(id) ? id : null;
}

export async function uniqueMessageUid(client, messageId) {
  const expected = normalizeMessageId(messageId);
  if (!expected) return null;
  const candidates = await client.search({ header: { 'Message-ID': expected } }, { uid: true });
  if (!Array.isArray(candidates)) throw new Error('Message-ID SEARCH did not return UIDs');
  const uids = [...new Set(candidates.map(Number))];
  if (uids.some(uid => !Number.isSafeInteger(uid) || uid <= 0)) return null;
  let found = null;
  for (let start = 0; start < uids.length; start += 100) {
    const chunk = uids.slice(start, start + 100);
    for await (const message of client.fetch(chunk.join(','), { uid: true, envelope: true }, { uid: true })) {
      if (!chunk.includes(Number(message.uid)) || normalizeMessageId(message.envelope?.messageId) !== expected) continue;
      if (found !== null && found !== Number(message.uid)) return null;
      found = Number(message.uid);
    }
  }
  return found;
}
