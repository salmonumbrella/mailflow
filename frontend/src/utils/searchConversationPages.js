// A changed sibling can legitimately re-emit a group after the snapshot fence.
// Keep its first physical match and position; request guards choose read state.
export function appendSearchPage(existing, incoming, { grouped = false, rawMessages = incoming } = {}) {
  const physicalKey = message => JSON.stringify([message.account_id ?? '', message.id]);
  const rawByPhysical = new Map(rawMessages.map(message => [physicalKey(message), message]));
  const seen = new Map();
  const result = [];
  for (const message of [...existing, ...incoming]) {
    const key = grouped && message.thread_id
      ? JSON.stringify(['group', message.thread_id])
      : JSON.stringify(['message', message.account_id ?? '', message.id]);
    if (!seen.has(key)) {
      seen.set(key, result.length);
      result.push(message);
    } else {
      const index = seen.get(key);
      const first = result[index];
      // A fresh guarded flag for the same physical row may converge remote unread.
      // Another physical match never replaces the first group's representative.
      const raw = rawByPhysical.get(physicalKey(message));
      if (first.id === message.id && first.account_id === message.account_id &&
          typeof message.is_read === 'boolean' && raw && message.is_read === raw.is_read) {
        const updated = { ...first, is_read: message.is_read };
        if (Object.hasOwn(raw, 'representative_is_read')) updated.representative_is_read = raw.representative_is_read;
        else delete updated.representative_is_read;
        result[index] = updated;
      }
    }
  }
  return result;
}

// Reconcile again at synchronous publication: another intent can start while a
// duplicate-only continuation awaits its next response. Keep each issued token.
export function guardSearchPages(existing, pages, { grouped = false, scope = null, guardMessages }) {
  return pages.reduce((messages, { data, readToken }) => appendSearchPage(messages,
    guardMessages(data.messages, readToken)
      .map(message => scope ? { ...message, search_scope: scope } : message),
    { grouped, rawMessages: data.messages }), existing);
}

// A bounded server page may contain only groups already returned on an earlier page.
// Continue up to three real requests; an empty addition never implies exhaustion.
export async function extendSearchPages(existing, {
  cursor = '', grouped = false, scope = null, fetchPage, guardMessages, isCurrent,
}) {
  let messages = existing;
  const pages = [];
  let hasMore = true;
  for (let round = 0; round < 3; round += 1) {
    const { data, readToken } = await fetchPage(cursor);
    if (!isCurrent()) return null;
    const incoming = guardMessages(data.messages, readToken)
      .map(message => scope ? { ...message, search_scope: scope } : message);
    pages.push({ data, readToken });
    const next = appendSearchPage(messages, incoming, { grouped, rawMessages: data.messages });
    const nextCursor = data.nextCursor;
    // Flat/v1 supplies nextCursor only; grouped/v2 has an explicit exhaustion flag.
    hasMore = grouped ? data.hasMore === true : nextCursor != null && nextCursor !== '';
    if (hasMore && (typeof nextCursor !== 'string' || !nextCursor || nextCursor === cursor)) {
      throw new Error('Search pagination needs a refresh');
    }
    cursor = nextCursor || null;
    const added = next.length > messages.length;
    messages = next;
    if (added || !hasMore) break;
  }
  // messages is only a continuation preview; publish by guardSearchPages so
  // previously guarded flags cannot overwrite a newer intent during an await.
  return { messages, pages, cursor, hasMore };
}
