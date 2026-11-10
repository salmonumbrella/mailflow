// A bounded expression parser. Never drop an invalid branch: doing so could turn
// a narrow query into a mailbox-wide search, especially under OR or negation.
export class SearchQueryError extends Error {}

const OPERATOR = /^(from|to|cc|bcc|subject|has|is|after|before|newer|older|newer_than|older_than|in|category|filename|label|size|larger|smaller):(.+)$/i;

export function lexSearchExpression(raw) {
  const source = String(raw || '');
  if (source.length > 500) throw new SearchQueryError('Search query too long');
  const tokens = [];
  let token = '', quoted = false;
  const flush = () => { if (token) tokens.push(token); token = ''; };
  for (const char of source) {
    if (char === '"') { quoted = !quoted; token += char; }
    else if (!quoted && /[\s(){}]/.test(char)) { flush(); if (!/\s/.test(char)) tokens.push(char); }
    else token += char;
  }
  if (quoted) throw new SearchQueryError('Close the quotation marks in your search.');
  flush();
  return { tokens, hasGroups: tokens.some(token => ['(', ')', '{', '}'].includes(token)), hasOr: tokens.includes('OR') };
}

export function parseSearchExpression(raw) {
  const { tokens } = lexSearchExpression(raw);
  if (!tokens.length) return null;
  let index = 0, leaves = 0;
  const combine = (type, children) => children.length === 1 ? children[0] : { type, children };
  const atom = depth => {
    if (depth > 15) throw new SearchQueryError('Search groups are nested too deeply.');
    let value = tokens[index++];
    if (!value || ['OR', 'AND', ')', '}'].includes(value)) throw new SearchQueryError('Add a search term on each side of an operator.');
    if (value === '-') return { type: 'not', child: atom(depth + 1) };
    if (value === '(' || value === '{') {
      const close = value === '(' ? ')' : '}';
      const node = expression(close, value === '{', depth + 1);
      if (tokens[index++] !== close) throw new SearchQueryError('Close the search group with a matching bracket.');
      return node;
    }
    const negate = value.startsWith('-');
    if (negate) value = value.slice(1);
    if (!value) throw new SearchQueryError('Add a term after the minus sign.');
    const scope = /^(from|to|cc|subject|has|is|category|filename):$/i.exec(value);
    if (scope && ['(', '{'].includes(tokens[index])) {
      const group = atom(depth + 1);
      const qualify = child => {
        if (child.type === 'term') return { type: 'filter', key: scope[1].toLowerCase(), value: child.value.toLowerCase().trim() };
        if (child.type === 'not') return { ...child, child: qualify(child.child) };
        if (child.children) return { ...child, children: child.children.map(qualify) };
        return child;
      };
      const node = qualify(group);
      return negate ? { type: 'not', child: node } : node;
    }
    if (/^(from|to|cc|bcc|subject|has|is|after|before|newer|older|newer_than|older_than|in|category|filename|label|size|larger|smaller):$/i.test(value)) throw new SearchQueryError('Search operators need a value.');
    if (++leaves > 50) throw new SearchQueryError('Use at most 50 search terms.');
    const match = OPERATOR.exec(value);
    let node;
    if (match) {
      let argument = match[2];
      if (argument.startsWith('"') && argument.endsWith('"')) argument = argument.slice(1, -1);
      if (!argument.trim()) throw new SearchQueryError('Search operators need a value.');
      const key = match[1].toLowerCase();
      node = { type: 'filter', key, value: key === 'label'
        ? argument.normalize('NFC').toLowerCase().normalize('NFC').trim() : argument.toLowerCase().trim() };
    } else {
      const phrase = value.startsWith('"') && value.endsWith('"');
      if (phrase) value = value.slice(1, -1);
      if (!value) throw new SearchQueryError('Enter text inside the quotation marks.');
      node = { type: 'term', value, phrase };
    }
    return negate ? { type: 'not', child: node } : node;
  };
  const expression = (close, any, depth) => {
    const groups = [], conjunction = [];
    while (index < tokens.length && tokens[index] !== close) {
      if (tokens[index] === ')' || tokens[index] === '}') throw new SearchQueryError('Search brackets do not match.');
      if (tokens[index] === 'OR') {
        if (!conjunction.length) throw new SearchQueryError('Add a search term before OR.');
        groups.push(combine('and', conjunction.splice(0)));
        index++;
        conjunction.push(atom(depth));
      } else if (tokens[index] === 'AND') {
        if (!conjunction.length) throw new SearchQueryError('Add a search term before AND.');
        index++;
        conjunction.push(atom(depth));
      } else {
        if (any && conjunction.length) groups.push(combine('and', conjunction.splice(0)));
        conjunction.push(atom(depth));
      }
    }
    if (!conjunction.length) throw new SearchQueryError('Search groups cannot be empty.');
    groups.push(combine('and', conjunction));
    return combine('or', groups);
  };
  return expression(null, false, 0);
}
