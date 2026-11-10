import { lexSearchExpression, parseSearchExpression, SearchQueryError } from './searchExpression.js';
import { resolveNativeLabelSearch } from './nativeLabelSearch.js';
export { captureSearchRuleFields, evaluateSearchRuleConditions, validateSearchRuleCondition } from './searchRuleSemantics.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = (code, message, status = 400) => { throw Object.assign(new SearchQueryError(message), { code, status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function parseNativeLabelRuleSearch(query) {
  if (typeof query !== 'string') failure('invalid_source_search', 'Provide the complete raw search query.');
  let metadata, tree;
  try { metadata = lexSearchExpression(query); tree = parseSearchExpression(query); }
  catch (error) {
    if (error instanceof SearchQueryError) { error.status = 400; error.code ||= 'invalid_source_search'; }
    throw error;
  }
  if (!tree) failure('unsupported_rule_search', 'A saved search needs at least one condition.');
  if (metadata.hasGroups || metadata.hasOr) failure('unsupported_rule_search', 'Groups and OR searches cannot be saved as a native-label rule.');
  const leaves = tree.type === 'and' ? tree.children : [tree];
  if (leaves.length > 50) failure('unsupported_rule_search', 'Use at most 50 search conditions.');
  for (const node of leaves) {
    const leaf = node.type === 'not' ? node.child : node;
    if (leaf.type !== 'filter' || !(['label', 'from', 'subject'].includes(leaf.key) ||
        (leaf.key === 'has' && ['attachment', 'attachments'].includes(leaf.value)) ||
        (leaf.key === 'is' && ['read', 'unread'].includes(leaf.value)))) {
      failure('unsupported_rule_search', 'Only flat label, From, Subject, attachment, and read-state conditions can be saved. No search terms were removed.');
    }
  }
  return { tree, leaves };
}

// Caller must already be in a transaction, and retain it through INSERT/UPDATE.
// Reacquiring the account lock is harmless when persistence has locked all old
// and new account scopes first. Never invoke from a rule-first locked context.
export async function convertNativeLabelRuleSearchInTransaction(client, {
  userId, sourceSearch, displayedScope, clientConditions, conditionLogic,
}) {
  if (clientConditions !== undefined || (conditionLogic !== undefined && conditionLogic !== 'AND'))
    failure('ambiguous_source_search', 'Send the raw search without client-generated conditions or alternate logic.');
  if (!object(sourceSearch) || Object.keys(sourceSearch).some(key => !['query', 'accountId', 'expectedStorageGeneration', 'expectedTreeRevision'].includes(key)) ||
      !UUID.test(sourceSearch.accountId || '') || !UUID.test(sourceSearch.expectedStorageGeneration || '') ||
      typeof sourceSearch.expectedTreeRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(sourceSearch.expectedTreeRevision) ||
      BigInt(sourceSearch.expectedTreeRevision) > 9223372036854775807n)
    failure('invalid_source_search', 'Choose one account and current storage generation and label tree revision.');
  if (!object(displayedScope) || Object.keys(displayedScope).some(key => !['accountId', 'folder'].includes(key)) ||
      !Object.hasOwn(displayedScope, 'accountId') ||
      (displayedScope.accountId !== null && displayedScope.accountId !== sourceSearch.accountId) ||
      !['', 'INBOX'].includes(displayedScope.folder))
    failure('search_scope_conflict', 'Review the selected account and Inbox search scope before saving.');
  const { tree, leaves } = parseNativeLabelRuleSearch(sourceSearch.query);
  const { rows: [account] } = await client.query('SELECT id,user_id,storage_generation,enabled FROM email_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [sourceSearch.accountId, userId]);
  if (!account?.enabled) failure('not_found', 'Owned enabled account not found.', 404);
  if (account.storage_generation !== sourceSearch.expectedStorageGeneration)
    failure('storage_generation_conflict', 'The mailbox changed. Preview the search again.', 409);
  const { rows: [state] } = await client.query('SELECT tree_revision::text AS tree_revision FROM mail_label_state WHERE account_id=$1', [account.id]);
  if ((state?.tree_revision || '0') !== sourceSearch.expectedTreeRevision)
    failure('tree_revision_conflict', 'The label tree changed. Preview the search again.', 409);
  let resolved;
  try { resolved = await resolveNativeLabelSearch(userId, [account.id], tree, client.query.bind(client)); }
  catch (error) {
    if (error instanceof SearchQueryError) error.status = 400;
    throw error;
  }
  const conditions = leaves.map(node => {
    const negative = node.type === 'not', leaf = negative ? node.child : node;
    if (leaf.key === 'label') return { field: 'native_label', operator: negative ? 'not_has' : 'has', value: resolved.byValue.get(leaf.value).labelId };
    const semantics = 'search_v1';
    if (leaf.key === 'from' || leaf.key === 'subject') return { field: leaf.key, operator: negative ? 'not_contains' : 'contains', value: leaf.value, semantics };
    return { field: leaf.key === 'has' ? 'has_attachment' : 'is_read', operator: negative ? 'is_not' : 'is',
      value: leaf.key === 'has' || leaf.value === 'read' ? 'true' : 'false', semantics };
  });
  return { conditions, conditionLogic: 'AND', accountId: account.id, expectedStorageGeneration: account.storage_generation,
    sourceSearch: { ...sourceSearch }, displayedScope: { ...displayedScope }, resolvedReferences: resolved?.resolvedReferences || [],
    scopeNotice: displayedScope.accountId === null
      ? 'This rule narrows the unified search to the selected account and runs only on Inbox messages.'
      : 'This rule runs only on Inbox messages in the selected account.' };
}
