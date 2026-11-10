export function splitRecipientTokens(value) {
  return (String(value || '').match(/(?:"[^"]*"|[^,;\r\n])+/g) || [])
    .map(token => token.trim()).filter(Boolean);
}

export function mergeRecipientTokens(existing, additions) {
  const emailOf = token => (token.match(/<([^>]+)>/)?.[1] || token).trim().toLowerCase();
  const seen = new Set(existing.map(emailOf));
  return [...existing, ...additions.filter(token => {
    const key = emailOf(token);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}
