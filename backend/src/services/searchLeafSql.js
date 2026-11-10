const escapeLike = value => value.replace(/[\\%_]/g, '\\$&');

// Exact shared SQL for the bounded saved-search language. Keep the alias fixed:
// both physical search rows and captured VALUES rows are named m. bind must
// parameterize every value; no JavaScript approximation of PostgreSQL ILIKE.
export function buildSearchRuleLeafSql(key, value, bind) {
  if (key === 'from') { const p = bind(`%${escapeLike(value)}%`); return `(m.from_email ILIKE ${p} OR m.from_name ILIKE ${p})`; }
  if (key === 'subject') return `m.subject ILIKE ${bind(`%${escapeLike(value)}%`)}`;
  if (key === 'has' && ['attachment', 'attachments'].includes(value)) return 'm.has_attachments = true';
  if (key === 'is' && value === 'read') return 'm.is_read = true';
  if (key === 'is' && value === 'unread') return 'm.is_read = false';
  return null;
}
