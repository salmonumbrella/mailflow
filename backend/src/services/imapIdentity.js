// SEARCH HEADER matches substrings. Destructive/retargeted operations need exactly
// one live RFC identity, verified while the caller holds the selected mailbox lock.
export function normalizeMessageId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().replace(/^<([^<>]*)>$/, '$1');
  return /^[^<>\s@]+@[^<>\s@]+$/.test(id) ? id : null;
}

const validUid = value => (typeof value === 'number' || typeof value === 'string')
  && /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 4294967295;

export async function uniqueMessageUids(client, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length > 500) throw new Error('Message-ID verification request exceeds limit');
  const expected = [...new Set(messageIds.map(normalizeMessageId).filter(id => id && id.length <= 500 && !/\p{Cc}/u.test(id)))];
  const candidates = new Set();
  for (let start = 0; start < expected.length; start += 20) {
    const terms = expected.slice(start, start + 20).map(id => ({ header: { 'Message-ID': id } }));
    const found = await client.search(terms.length === 1 ? terms[0] : { or: terms }, { uid: true });
    if (!Array.isArray(found) || found.length > 2000 || found.some(uid => !validUid(uid))) {
      throw new Error('Message-ID SEARCH returned invalid or excessive UIDs');
    }
    for (const uid of found) candidates.add(Number(uid));
    if (candidates.size > 2000) throw new Error('Message-ID verification candidate limit exceeded');
  }
  const uids = [...candidates], wanted = new Set(expected), matches = new Map(), seen = new Map();
  for (let start = 0; start < uids.length; start += 100) {
    const chunk = uids.slice(start, start + 100);
    for await (const message of client.fetch(chunk.join(','), { uid: true, envelope: true }, { uid: true })) {
      if (!validUid(message.uid) || !chunk.includes(Number(message.uid))) throw new Error('Message-ID FETCH returned an unexpected UID');
      const uid = Number(message.uid), id = normalizeMessageId(message.envelope?.messageId);
      if (seen.has(uid) && seen.get(uid) !== id) throw new Error('Message-ID FETCH returned conflicting headers');
      seen.set(uid, id);
      if (wanted.has(id)) {
        if (!matches.has(id)) matches.set(id, uid);
        else if (matches.get(id) !== uid) matches.set(id, null);
      }
    }
  }
  return matches;
}

export async function uniqueMessageUid(client, messageId) {
  const matches = await uniqueMessageUids(client, [messageId]);
  return matches.get(normalizeMessageId(messageId)) ?? null;
}
