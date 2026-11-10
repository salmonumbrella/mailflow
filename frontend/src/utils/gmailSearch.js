// Keep every unedited token, including operators this builder does not understand.
export const tokenizeSearch = query => String(query || '').match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
const unquote = value => value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
export const quoteSearch = value => /\s/.test(value) ? `"${value.replaceAll('"', '')}"` : value;
export const emptySearchFields = () => ({ from: '', to: '', subject: '', words: '', without: '', folder: '', attachment: false, after: '', before: '', date: '', dateWithin: '7', extra: '' });

export function searchQueryToFields(query) {
  const fields = emptySearchFields();
  if (/(?:^|\s)(?:OR|AND)(?:\s|$)|[(){}]/.test(query)) return { ...fields, extra: query };
  const words = [], without = [], extra = [];
  for (const token of tokenizeSearch(query)) {
    const match = /^(from|to|subject|in|after|before):(.+)$/i.exec(token);
    if (match) {
      const key = match[1].toLowerCase() === 'in' ? 'folder' : match[1].toLowerCase();
      if (!fields[key]) fields[key] = unquote(match[2]); else extra.push(token);
    } else if (token === 'has:attachment' && !fields.attachment) fields.attachment = true;
    else if (/[:(){}]|^OR$/.test(token)) extra.push(token);
    else if (token.startsWith('-')) without.push(token.slice(1));
    else words.push(token);
  }
  return { ...fields, words: words.join(' '), without: without.join(' '), extra: extra.join(' ') };
}

export function searchFieldsToQuery(fields) {
  const tokens = [];
  for (const key of ['from', 'to', 'subject']) if (fields[key].trim()) tokens.push(`${key}:${quoteSearch(fields[key].trim())}`);
  if (fields.words.trim()) tokens.push(fields.words.trim());
  tokens.push(...tokenizeSearch(fields.without).map(word => `-${word.replace(/^-/, '')}`));
  if (fields.folder) tokens.push(`in:${quoteSearch(fields.folder)}`);
  if (fields.attachment) tokens.push('has:attachment');
  if (fields.date) {
    const date = new Date(`${fields.date}T00:00:00Z`);
    if (Number.isNaN(+date)) throw new Error('Choose a valid date.');
    const days = Number(fields.dateWithin) || 1;
    tokens.push(`after:${new Date(+date - days * 86400000).toISOString().slice(0, 10)}`);
    tokens.push(`before:${new Date(+date + (days + 1) * 86400000).toISOString().slice(0, 10)}`);
  } else {
    if (fields.after) tokens.push(`after:${fields.after}`);
    if (fields.before) tokens.push(`before:${fields.before}`);
  }
  if (fields.extra.trim()) tokens.push(fields.extra.trim());
  return tokens.join(' ');
}

// Never silently broaden a saved rule by throwing away unsupported criteria.
// MailFlow's rule matcher searches To but search also includes Cc, so that operator
// cannot safely be converted until the engine has the same recipient semantics.
export function searchQueryToRule(query) {
  const conditions = [];
  if (/[(){}%_]/.test(query)) throw new Error('This search cannot be converted to an exact MailFlow rule. Use MailFlow Rules to configure its conditions.');
  for (const token of tokenizeSearch(query)) {
    const match = /^(-?)(from|subject):(.+)$/i.exec(token);
    if (match) conditions.push({ field: match[2].toLowerCase(), operator: match[1] ? 'not_contains' : 'contains', value: unquote(match[3]) });
    else if (token === 'has:attachment') conditions.push({ field: 'has_attachment', operator: 'contains', value: '' });
    else if (/^is:(read|unread)$/.test(token)) conditions.push({ field: 'read_status', operator: 'equals', value: token.slice(3) });
    else throw new Error(`MailFlow cannot yet save “${token}” as an exact filter condition. Use From, Subject, Has attachment, or is:read / is:unread, or open MailFlow Rules for other conditions.`);
  }
  if (!conditions.length) throw new Error('Add at least one search condition.');
  return conditions;
}

export function rememberSearch(history, query) {
  const clean = query.trim();
  return clean ? [clean, ...history.filter(item => item !== clean)].slice(0, 10) : history;
}

// Change only top-level refinements. Removing a leaf inside an OR/group would
// change the meaning of the user's expression instead of filtering its results.
function refinementTokens(query) {
  const tokens = [];
  let token = '', depth = 0, quoted = false;
  for (const char of query.trim()) {
    if (char === '"') quoted = !quoted;
    if (!quoted && '({'.includes(char)) depth++;
    if (!quoted && ')}'.includes(char)) depth--;
    if (!quoted && depth === 0 && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = '';
    } else token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function hasSearchRefinement(query, operator, value) {
  const tokens = refinementTokens(query);
  if (tokens.includes('OR') || tokens.includes('AND')) return false;
  return tokens.some(token => token.toLowerCase() === `${operator}:${value}`);
}

export function refineSearchQuery(query, operator, value) {
  let tokens = refinementTokens(query);
  if (tokens.includes('OR') || tokens.includes('AND')) tokens = [`(${query.trim()})`];
  tokens = tokens.filter(token => !token.toLowerCase().startsWith(`${operator}:`));
  if (value) tokens.push(`${operator}:${quoteSearch(value)}`);
  return tokens.join(' ');
}
