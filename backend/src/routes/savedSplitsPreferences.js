import { query } from '../services/db.js';
import { savedSplitPreferences, validateSavedSplits } from '../utils/savedSplits.js';

export async function getSavedSplits(req, res) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]);
  res.json(savedSplitPreferences(result.rows[0]?.preferences));
}

export async function putSavedSplits(req, res) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { savedSplits, hideEmptySplits, savedSplitsRevision } = req.body || {};
  const clean = validateSavedSplits(savedSplits);
  if (!clean || typeof hideEmptySplits !== 'boolean' || !Number.isSafeInteger(savedSplitsRevision)
    || savedSplitsRevision < 0 || savedSplitsRevision >= 2147483647) {
    return res.status(400).json({ error: 'Provide up to 12 unique splits (name: 1–60, query: 1–500 characters), a hide-empty boolean, and the current revision.' });
  }
  const next = { savedSplits: clean, hideEmptySplits, savedSplitsRevision: savedSplitsRevision + 1 };
  // Merge just this subdocument under a row-level compare-and-swap. Theme, snippets and
  // other preference saves cannot be lost, and an older editor cannot overwrite a newer one.
  const result = await query(`UPDATE users
    SET preferences = COALESCE(preferences, '{}'::jsonb) || $2::jsonb
    WHERE id = $1 AND COALESCE((preferences->>'savedSplitsRevision')::bigint, 0) = $3
    RETURNING id`, [req.session.userId, JSON.stringify(next), savedSplitsRevision]);
  if (!result.rows.length) return res.status(409).json({ error: 'Saved splits changed in another window. Reload them before saving again.' });
  res.json(next);
}
