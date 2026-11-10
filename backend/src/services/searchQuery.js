// Tokenize before extracting operators so quoted body text such as
// "from:alice invoice" cannot accidentally become a sender filter.
export function parseSearchQuery(raw) {
  const filters = [], terms = [];
  const tokens = String(raw || '').match(/(?:[^\s"]|"[^"]*")+/g) || [];
  for (const token of tokens) {
    const match = /^(-?)(from|to|subject|has|is|after|before|in):("([^"]*)"|(\S+))$/i.exec(token);
    if (match) {
      const value = (match[4] ?? match[5] ?? '').toLowerCase().trim();
      if (value) filters.push({ key: match[2].toLowerCase(), value, negate: match[1] === '-' });
      continue;
    }
    let value = token;
    if (!value || value === '-') continue;
    const negate = value.startsWith('-');
    if (negate) value = value.slice(1);
    const phrase = value.startsWith('"') && value.endsWith('"');
    if (phrase) value = value.slice(1, -1);
    if (value) terms.push({ value, negate, ...(phrase ? { phrase: true } : {}) });
  }
  return { filters, terms };
}
