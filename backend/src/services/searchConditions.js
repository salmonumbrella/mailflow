import { parseSearchExpression, SearchQueryError } from './searchExpression.js';

// Postgres refuses to build a tsvector larger than ~1MB of packed lexemes
// (SQLSTATE 54000), so an oversized body would 500 the whole search. Cap the
// text fed to to_tsvector at 600k chars — matching msgvault's maxFTSBodyChars
// (internal/store/dialect_pg.go) — so one huge email can't crash the query.
// Exported because slice 02's search_fts trigger caps the same way.
export const FTS_BODY_CHAR_CAP = 600000;

// Builds the per-term free-text OR-condition: a term matches if it appears in
// the sender, the subject, the stored search_vector, or the length-capped body.
// Extracted so the body cap is a single, testable source of truth.
export function freeTextTermCondition(likeIdx, ftsIdx) {
  return `(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.search_vector @@ plainto_tsquery('english', $${ftsIdx})
        OR CASE WHEN numnode(plainto_tsquery('english', $${ftsIdx})) > 0
          THEN to_tsvector('english', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('english', $${ftsIdx})
          ELSE to_tsvector('simple', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('simple', $${ftsIdx})
        END
      )`;
}

const escapeLike = value => value.replace(/[\\%_]/g, '\\$&');
const negate = sql => `NOT COALESCE((${sql}), false)`;
const CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);

function searchDate(value) {
  // Date.parse silently normalizes February 31 and interprets short numbers as
  // years. Reject those rather than run a different search from the one typed.
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(value);
  if (!match) throw new SearchQueryError('Use a date in YYYY-MM-DD format.');
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== iso) throw new SearchQueryError('Choose a valid date.');
  return date.toISOString();
}

function relativeDate(value, now) {
  const match = /^(\d+)(d|m|y)$/.exec(value);
  if (!match || +match[1] > 10000) throw new SearchQueryError('Relative dates use a number followed by d, m, or y.');
  const date = new Date(now);
  const amount = +match[1];
  if (match[2] === 'd') date.setUTCDate(date.getUTCDate() - amount);
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (match[2] === 'm') date.setUTCMonth(date.getUTCMonth() - amount);
    else date.setUTCFullYear(date.getUTCFullYear() - amount);
    const last = new Date(date.getTime());
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, last.getUTCDate()));
  }
  return date.toISOString();
}

// Values are always parameters. The caller retains account ownership and
// is_deleted predicates OUTSIDE this expression so OR can never bypass them.
export function buildSearchConditions(raw, { folder = '', firstParam = 2, now = Date.now() } = {}) {
  const tree = parseSearchExpression(raw);
  const params = [];
  let explicitFolder = false, includesTrash = false;
  const bind = value => { params.push(value); return `$${firstParam + params.length - 1}`; };
  const compile = (node, positive = true) => {
    if (node.type === 'not') return negate(compile(node.child, !positive));
    if (node.type === 'and' || node.type === 'or') return `(${node.children.map(child => compile(child, positive)).join(node.type === 'and' ? ' AND ' : ' OR ')})`;
    if (node.type === 'term') {
      const like = bind(`%${escapeLike(node.value)}%`);
      if (node.phrase) return `(m.from_name ILIKE ${like} OR m.from_email ILIKE ${like} OR m.subject ILIKE ${like} OR m.body_text ILIKE ${like})`;
      const fts = bind(node.value);
      return freeTextTermCondition(Number(like.slice(1)), Number(fts.slice(1)));
    }
    const { key, value } = node;
    if (['label', 'size', 'larger', 'smaller', 'bcc'].includes(key)) throw new SearchQueryError(`${key}: is not available in MailFlow’s search index.`);
    if (key === 'from') { const p = bind(`%${escapeLike(value)}%`); return `(m.from_email ILIKE ${p} OR m.from_name ILIKE ${p})`; }
    if (key === 'subject') return `m.subject ILIKE ${bind(`%${escapeLike(value)}%`)}`;
    if (key === 'to' || key === 'cc') {
      const p = bind(`%${escapeLike(value)}%`);
      return key === 'cc' ? `m.cc_addresses::text ILIKE ${p}` : `(m.to_addresses::text ILIKE ${p} OR m.cc_addresses::text ILIKE ${p})`;
    }
    if (key === 'has' && ['attachment', 'attachments'].includes(value)) return 'm.has_attachments = true';
    if (key === 'is') {
      if (value === 'read') return 'm.is_read = true';
      if (value === 'unread') return 'm.is_read = false';
      if (value === 'starred') return 'm.is_starred = true';
    }
    if (['after', 'before', 'newer', 'older'].includes(key)) return `m.date ${['after', 'newer'].includes(key) ? '>=' : '<'} ${bind(searchDate(value))}`;
    if (key === 'newer_than' || key === 'older_than') return `m.date ${key === 'newer_than' ? '>=' : '<'} ${bind(relativeDate(value, now))}`;
    if (key === 'category') {
      if (!CATEGORIES.has(value)) throw new SearchQueryError('Use a MailFlow category: primary, newsletter, promotion, automated, or social.');
      return `COALESCE(m.category, 'primary') = ${bind(value)}`;
    }
    if (key === 'filename') return `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END) attachment WHERE attachment->>'filename' ILIKE ${bind(`%${escapeLike(value)}%`)})`;
    if (key === 'in') {
      if (positive) { explicitFolder = true; if (value !== 'all') includesTrash = true; }
      if (value === 'all' || value === 'anywhere') return 'true';
      const literal = `(m.folder ILIKE ${bind(escapeLike(value))} OR m.folder ILIKE ${bind(`%/${escapeLike(value)}`)})`;
      const aliases = { sent: ['sent', '\\Sent'], trash: ['trash', '\\Trash'], drafts: ['drafts', '\\Drafts'], draft: ['drafts', '\\Drafts'], spam: ['spam', '\\Junk'], junk: ['spam', '\\Junk'] };
      const alias = aliases[value];
      if (!alias) return literal;
      // Standard roles work for localized/provider names without guessing their
      // spelling. Full explicit paths still use only the literal path matcher.
      return `(${literal} OR EXISTS (SELECT 1 FROM folders search_folder WHERE search_folder.account_id = m.account_id AND search_folder.path = m.folder AND (search_folder.special_use = ${bind(alias[1])} OR search_folder.path = a.folder_mappings->>${bind(alias[0])})))`;
    }
    throw new SearchQueryError(`Unsupported search operator: ${key}:${value}`);
  };
  const conditions = tree ? [compile(tree)] : [];
  if (!explicitFolder && folder.trim()) conditions.push(`m.folder = ${bind(folder.trim())}`);
  return { conditions, params, excludeTrash: !includesTrash && (explicitFolder || !folder.trim()) };
}
