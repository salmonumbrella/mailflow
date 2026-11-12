export const MAX_SAVED_SPLITS = 12;

export function validateSavedSplits(value) {
  if (!Array.isArray(value) || value.length > MAX_SAVED_SPLITS) return null;
  const ids = new Set();
  const labels = new Set();
  const clean = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id)
      || typeof item.label !== 'string' || typeof item.query !== 'string') return null;
    const label = item.label.trim();
    const query = item.query.trim();
    // eslint-disable-next-line no-control-regex -- reject unrenderable saved names and queries
    if (!label || label.length > 60 || !query || query.length > 500 || /[\x00-\x1f\x7f]/.test(label + query)
      || ids.has(item.id) || labels.has(label.toLowerCase())) return null;
    ids.add(item.id);
    labels.add(label.toLowerCase());
    clean.push({ id: item.id, label, query });
  }
  return clean;
}

export function savedSplitPreferences(prefs = {}) {
  return {
    savedSplits: validateSavedSplits(prefs.savedSplits ?? []) ?? [],
    hideEmptySplits: prefs.hideEmptySplits === true,
    savedSplitsRevision: Number.isSafeInteger(prefs.savedSplitsRevision) && prefs.savedSplitsRevision >= 0 ? prefs.savedSplitsRevision : 0,
  };
}
