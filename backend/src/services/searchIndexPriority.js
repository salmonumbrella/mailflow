import { isIdentityBootstrapComplete } from './archiveCoverage.js';
import { searchIndexEligibility } from './searchIndexEligibility.js';
import { SOURCE_CONTRACT_GENERATION } from './searchIndexIdentity.js';
import { withSearchIndexAccount } from './searchIndexJobs.js';

// A search owner supplies only its authorized positive metadata matches. This
// changes queued priority, never claims a lease, opens a body or starts a worker.
export async function prioritizeSearchMessages(accountId, messageIds, { userId, profile, isOpen, signal } = {}) {
  if (!userId || typeof isOpen !== 'function' || !profile) throw new Error('Search priority needs owner, profile and lifecycle');
  if (!Array.isArray(messageIds) || messageIds.length > 50) throw new Error('Search priority accepts at most50 message IDs');
  const stopped = () => signal?.aborted || !isOpen(accountId);
  const deferred = () => ({ changed: 0, deferred: true, reason: 'stopped' });
  if (stopped()) return deferred();
  if (!messageIds.length) return { changed: 0, deferred: false, reason: null };
  const ready = await isIdentityBootstrapComplete(accountId, profile);
  const eligibility = await searchIndexEligibility(accountId, profile);
  if (stopped()) return deferred();
  const result = await withSearchIndexAccount(accountId, async (client, control) => {
    if (stopped()) return deferred();
    const { rowCount } = await client.query(`WITH hits AS (
        SELECT DISTINCT CASE WHEN $3 AND NULLIF(m.provider_msgid,'') IS NOT NULL THEN 'provider:'||m.provider_msgid
          ELSE 'physical:'||m.folder||':'||f.uid_validity::text||':'||m.uid::text END AS source_key
        FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
        WHERE m.account_id=$1 AND m.id=ANY($2::uuid[]) AND NOT m.is_deleted AND NOT f.no_select AND f.uid_validity IS NOT NULL
          AND ((NOT m.is_archive_residue AND f.path=ANY($4::text[])) OR (m.is_archive_residue AND f.path=$5))
      ), wanted AS (
        SELECT j.source_key,j.priority_at IS NOT NULL AS existing,j.message_date
        FROM search_index_jobs j JOIN hits h ON h.source_key=j.source_key
        WHERE j.account_id=$1 AND j.state='queued' AND j.source_generation=$6::bigint
      ), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY existing ORDER BY message_date DESC NULLS LAST,source_key) AS n FROM wanted
      ), capacity AS (
        SELECT greatest(0,200-count(*)) AS available FROM search_index_jobs
        WHERE account_id=$1 AND state='queued' AND priority_at IS NOT NULL
      ) UPDATE search_index_jobs j SET priority_at=now()
      FROM ranked r,capacity s WHERE j.account_id=$1 AND j.source_key=r.source_key AND (r.existing OR r.n<=s.available)
        AND j.state='queued' AND j.source_generation=$6::bigint
        AND EXISTS(SELECT 1 FROM search_index_accounts c JOIN email_accounts a ON a.id=c.account_id
          WHERE c.account_id=j.account_id AND c.run_epoch=$7 AND NOT c.paused AND a.enabled AND a.user_id=$8)`,
    [accountId, [...new Set(messageIds)], ready, eligibility.normalPaths, eligibility.archiveFolder,
      SOURCE_CONTRACT_GENERATION, control.run_epoch, userId]);
    return { changed: rowCount, deferred: false, reason: null };
  }, { userId });
  return result || deferred();
}
