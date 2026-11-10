import { SearchQueryError } from './searchExpression.js';
import { normalizeName } from './nativeLabelDefinitions.js';
import { nativeLabelLiveJoins } from './nativeLabelReadModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function nativeLabelTerms(tree) {
  if (!tree) return [];
  if (tree.type === 'filter') return tree.key === 'label' ? [tree.value] : [];
  if (tree.type === 'not') return nativeLabelTerms(tree.child);
  return tree.children?.flatMap(nativeLabelTerms) || [];
}

function failure(code, message, candidates) {
  const error = new SearchQueryError(message);
  error.code = code;
  if (candidates) error.candidates = candidates;
  throw error;
}

// Definitions use Unicode NFC and JavaScript's locale-independent lowercasing.
// Normalize path components by the same policy; never use SQL lower() or suffixes.
function normalizedReference(value) {
  try { return value.split('/').map(part => normalizeName(part).normalizedName).join('/'); }
  catch { failure('label_not_found', 'Label not found in the selected accounts. Choose a current label or its ID.'); }
}

// The caller must resolve and execute inside the same REPEATABLE READ snapshot,
// OR hold every selected account's FOR UPDATE lock throughout resolution and
// persistence. All definition writers acquire that account lock before changing
// tree_revision or labels. The latter is the locked snapshot contract used by
// server-authoritative rule conversion; never resolve then save on another client.
// Cap each account's definitions, and the total, rather than accepting an unbounded
// result from corrupt/unsupported imports. No truncated set can imply uniqueness.
export async function resolveNativeLabelSearch(userId, accountIds, tree, execute) {
  const values = [...new Set(nativeLabelTerms(tree))];
  if (!values.length) return null;
  const { rows } = await execute(`SELECT a.id AS account_id,a.storage_generation,
      COALESCE(s.tree_revision,0)::text AS tree_revision,
      COALESCE((SELECT jsonb_agg(l) FROM (SELECT id,name,full_path FROM mail_labels
        WHERE account_id=a.id ORDER BY id LIMIT 501) l),'[]'::jsonb) AS labels
    FROM email_accounts a LEFT JOIN mail_label_state s ON s.account_id=a.id
    WHERE a.user_id=$1 AND a.enabled=true AND a.id=ANY($2::uuid[])
    ORDER BY a.id LIMIT 201`, [userId, accountIds]);
  if (rows.length > 200 || rows.some(row => row.labels.length > 500))
    failure('label_scope_too_large', 'Select fewer accounts before searching native labels.');
  const accounts = rows.map(row => ({ accountId: row.account_id, storageGeneration: row.storage_generation, treeRevision: row.tree_revision }));
  const labels = rows.flatMap(row => row.labels.map(label => ({ labelId: label.id, accountId: row.account_id,
    storageGeneration: row.storage_generation, treeRevision: row.tree_revision, path: label.full_path, name: label.name })));
  const resolvedReferences = values.map(value => {
    const normalized = UUID.test(value) ? value.toLowerCase() : normalizedReference(value);
    const matches = labels.filter(label => UUID.test(value) ? label.labelId === normalized
      : normalizedReference(value.includes('/') ? label.path : label.name) === normalized);
    if (!matches.length) failure('label_not_found', 'Label not found in the selected accounts. Choose a current label or its ID.');
    if (matches.length > 1) failure('ambiguous_label', 'More than one label matches. Select an account, full path, or label ID.',
      matches.map(({ labelId, accountId, path }) => ({ labelId, accountId, path })));
    const reference = { ...matches[0] };
    delete reference.name;
    return { value, ...reference };
  });
  return { accounts, resolvedReferences, byValue: new Map(resolvedReferences.map(ref => [ref.value, ref])) };
}

// A scalar correlated subquery preserves unavailable identity as NULL instead of
// erasing its row. Thus an independently true ordinary OR branch can still match.
// These are physical search rows; unlike label feeds no entity deduplication occurs.
const identityFrom = () => `FROM messages label_source ${nativeLabelLiveJoins('label_source')}
  WHERE label_source.id=m.id AND label_source.account_id=m.account_id
    AND label_source.is_deleted=false`;
export const nativeLabelIdentityAvailableSql = () => `EXISTS (SELECT 1 ${identityFrom()})`;
export function nativeLabelCondition(reference, bind) {
  if (!reference) failure('label_not_found', 'Resolve native labels in the selected account scope before searching.');
  const account = bind(reference.accountId), generation = bind(reference.storageGeneration), label = bind(reference.labelId);
  return `(SELECT EXISTS (SELECT 1 FROM native_label_memberships membership
    WHERE membership.account_id=entity.account_id AND membership.storage_generation=entity.storage_generation
      AND membership.entity_id=entity.id AND membership.account_id=${account}::uuid
      AND membership.storage_generation=${generation}::uuid AND membership.label_id=${label}::uuid)
    ${identityFrom()})`;
}
