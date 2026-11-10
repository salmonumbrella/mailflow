// API revisions are decimal strings: never coerce them through JavaScript numbers.
export function labelTree(labels) {
  const children = new Map();
  const ids = new Set(labels.map(label => label.id));
  for (const label of labels) {
    const parent = ids.has(label.parentId) ? label.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(label);
  }
  const seen = new Set();
  const rows = [];
  function visit(parent, depth) {
    for (const label of (children.get(parent) || []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(label.id)) continue;
      seen.add(label.id); rows.push({ ...label, depth }); visit(label.id, depth + 1);
    }
  }
  visit(null, 0);
  return rows;
}

export function labelParentOptions(labels, id) {
  const excluded = new Set(id ? [id] : []);
  for (const row of labelTree(labels)) if (excluded.has(row.parentId)) excluded.add(row.id);
  return labelTree(labels).filter(label => !excluded.has(label.id));
}

export function labelDraft(label) {
  return { name: label?.name || '', parentId: label?.parentId || '', color: label?.color ?? null,
    textColor: label?.textColor ?? null, visibility: label?.visibility || 'show', messageVisible: label?.messageVisible !== false };
}

export function definitiveLabelFailure(error, recovering = false) {
  // Only these native service conflicts are reached after consulting the mutation ledger.
  // Unknown/intermediary 4xx and pre-ledger validation/ownership failures cannot settle a lost response.
  if (recovering) return error.status === 409 && [
    'mutation_conflict', 'mutation_expired', 'stale_tree_revision', 'stale_label_revision', 'duplicate_name',
  ].includes(error.code);
  return error.status >= 400 && error.status < 500 && error.status !== 408;
}

const key = accountId => `mailflow:pending-native-label:${accountId}`;
export function readPendingLabelMutation(accountId) {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key(accountId)) || 'null');
    return value?.payload?.accountId === accountId && ['create', 'update', 'delete'].includes(value.kind)
      && typeof value.payload.mutationId === 'string' ? value : null;
  } catch { return null; }
}
export function savePendingLabelMutation(accountId, operation) {
  try {
    if (operation) window.sessionStorage.setItem(key(accountId), JSON.stringify(operation));
    else window.sessionStorage.removeItem(key(accountId));
    return true;
  } catch { return false; }
}
