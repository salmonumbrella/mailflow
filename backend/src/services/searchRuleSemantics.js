import { buildSearchRuleLeafSql } from './searchLeafSql.js';

export const SEARCH_RULE_SEMANTICS = 'search_v1';
export function validateSearchRuleCondition(condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition) ||
      condition.semantics !== SEARCH_RULE_SEMANTICS ||
      Object.keys(condition).some(key => !['field', 'operator', 'value', 'semantics'].includes(key))) return false;
  const { field, operator, value } = condition;
  if (field === 'from' || field === 'subject') return ['contains', 'not_contains'].includes(operator) &&
    typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.toLowerCase().trim();
  if (field === 'has_attachment') return ['is', 'is_not'].includes(operator) && value === 'true';
  return field === 'is_read' && ['is', 'is_not'].includes(operator) && ['true', 'false'].includes(value);
}

const RAW_FIELDS = ['from_email', 'from_name', 'subject', 'has_attachments', 'is_read'];
// Copy raw persisted values, never fallback to parsed/defaulted display fields.
// An absent property means unavailable evidence, not SQL NULL.
export function captureSearchRuleFields(row) {
  if (!row || RAW_FIELDS.some(key => !Object.hasOwn(row, key))) return null;
  if (RAW_FIELDS.slice(0, 3).some(key => row[key] !== null && typeof row[key] !== 'string') ||
      RAW_FIELDS.slice(3).some(key => row[key] !== null && typeof row[key] !== 'boolean')) return null;
  return Object.freeze(Object.fromEntries(RAW_FIELDS.map(key => [key, row[key]])));
}

// The executor can be a pool query or the current transaction's bound query.
// There is intentionally no source-row lookup: asynchronous preparation cannot
// substitute a later sender/subject/flag state into an already captured decision.
export async function evaluateSearchRuleConditions(execute, conditions, rawFields) {
  if (!Array.isArray(conditions) || conditions.length > 200 || conditions.some(c => !validateSearchRuleCondition(c))) {
    throw Object.assign(new Error('Unsupported saved-search condition'), { code: 'invalid_search_condition', status: 400 });
  }
  if (!conditions.length) return [];
  const raw = captureSearchRuleFields(rawFields);
  if (!raw) throw Object.assign(new Error('Captured raw search fields are unavailable'), { code: 'search_evidence_unavailable', status: 409 });
  const params = RAW_FIELDS.map(key => raw[key]);
  const bind = value => { params.push(value); return `$${params.length}`; };
  const predicates = conditions.map((condition, index) => {
    const { field, operator, value } = condition;
    const key = field === 'has_attachment' ? 'has' : field === 'is_read' ? 'is' : field;
    const argument = field === 'has_attachment' ? 'attachment' : field === 'is_read' ? (value === 'true' ? 'read' : 'unread') : value;
    const leaf = buildSearchRuleLeafSql(key, argument, bind);
    const negative = operator === 'not_contains' || operator === 'is_not';
    // Native searches normalize ordinary SQL NULL leaves to false before
    // composing; native identity leaves alone retain unknown under negation.
    return `${negative ? 'NOT ' : ''}COALESCE((${leaf}),false) AS condition_${index}`;
  });
  const { rows: [row] } = await execute(`SELECT ${predicates.join(',')} FROM
    (VALUES ($1::text,$2::text,$3::text,$4::boolean,$5::boolean))
    AS m(from_email,from_name,subject,has_attachments,is_read)`, params);
  if (!row || conditions.some((_, index) => typeof row[`condition_${index}`] !== 'boolean')) {
    throw new Error('Saved-search evaluation returned invalid evidence');
  }
  return conditions.map((_, index) => row[`condition_${index}`]);
}
