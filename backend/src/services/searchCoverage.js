import { query } from './db.js';
import { isIdentityBootstrapComplete } from './archiveCoverage.js';
import { searchIndexEligibility } from './searchIndexEligibility.js';
import { SOURCE_CONTRACT_GENERATION } from './searchIndexIdentity.js';

function count(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid search coverage count');
  return n;
}

// This read describes current cached membership, not the contents of an unseen
// provider mailbox. Legacy body_text and completed job receipts certify neither.
export async function getSearchCoverage(accountIds, { userId, profileForAccount } = {}) {
  if (!userId || typeof profileForAccount !== 'function') throw new Error('Search coverage needs an owner and existing provider profiles');
  if (!Array.isArray(accountIds) || accountIds.length > 50) throw new Error('Search coverage accepts at most50 accounts');
  if (!accountIds.length) return [];
  const { rows: accounts } = await query(`SELECT id,enabled,imap_host,oauth_provider FROM email_accounts
    WHERE id=ANY($1::uuid[]) AND user_id=$2 ORDER BY id`, [[...new Set(accountIds)], userId]);
  const result = [];
  // Serial reads avoid multiplying account-wide aggregates on the shared host.
  for (const account of accounts) {
    const profile = profileForAccount(account);
    const ready = await isIdentityBootstrapComplete(account.id, profile);
    const eligibility = await searchIndexEligibility(account.id, profile);
    const { rows: [row] } = await query(`WITH live AS (
        SELECT m.id,m.provider_msgid,m.search_generation_id,
          CASE WHEN $3 AND NULLIF(m.provider_msgid,'') IS NOT NULL THEN 'provider:'||m.provider_msgid
            ELSE 'physical:'||m.folder||':'||f.uid_validity::text||':'||m.uid::text END AS source_key
        FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
        WHERE m.account_id=$1 AND NOT m.is_deleted AND NOT f.no_select AND f.uid_validity IS NOT NULL
          AND ((NOT m.is_archive_residue AND f.path=ANY($4::text[])) OR (m.is_archive_residue AND f.path=$5))
      ), sources AS (
        SELECT l.source_key,count(*) AS copies,
          bool_and(g.account_id=$1 AND g.source_key=concat('["7b",',to_json(l.source_key)::text,',',to_json($6::text)::text,']')
            AND g.id IS NOT NULL) AS verified
        FROM live l LEFT JOIN search_text_generations g ON g.id=l.search_generation_id GROUP BY l.source_key
      ), states AS (
        SELECT s.*,j.state,j.unsupported_reason,j.observed_download_bytes,j.structure_overrun_bytes
        FROM sources s LEFT JOIN search_index_jobs j ON j.account_id=$1 AND j.source_key=s.source_key AND j.source_generation=$6::bigint
      ), terminal AS (
        SELECT unsupported_reason AS reason,count(*)::int AS sources,
          sum(observed_download_bytes)::text AS "observedDownloadBytes",sum(structure_overrun_bytes)::text AS "structureOverrunBytes"
        FROM states WHERE NOT verified AND state='unsupported' GROUP BY unsupported_reason
      ) SELECT a.enabled,coalesce(c.paused,false) AS paused,
        (SELECT count(*) FROM messages m WHERE m.account_id=$1 AND NOT m.is_deleted) AS metadata_rows,
        (SELECT count(*) FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
          WHERE m.account_id=$1 AND NOT m.is_deleted AND NOT f.no_select AND f.uid_validity IS NULL
            AND ((NOT m.is_archive_residue AND f.path=ANY($4::text[])) OR (m.is_archive_residue AND f.path=$5))) AS unknown_epoch_rows,
        (SELECT count(*) FROM states) AS sources,(SELECT coalesce(sum(copies),0) FROM states) AS physical_rows,
        (SELECT count(*) FROM states WHERE source_key LIKE 'physical:%') AS physical_sources,
        (SELECT count(*) FROM states WHERE verified) AS verified,
        (SELECT count(*) FROM states WHERE NOT verified AND state='unsupported') AS unsupported,
        (SELECT count(*) FROM states WHERE NOT verified AND state='failed') AS failed,
        (SELECT coalesce(jsonb_agg(t ORDER BY t.reason),'[]'::jsonb) FROM terminal t) AS unsupported_details,
        (SELECT jsonb_build_object('queued',count(*) FILTER(WHERE state='queued'),
          'running',count(*) FILTER(WHERE state='running'),'complete',count(*) FILTER(WHERE state='complete'),
          'failed',count(*) FILTER(WHERE state='failed'),'unsupported',count(*) FILTER(WHERE state='unsupported'))
          FROM search_index_jobs WHERE account_id=$1) AS job_counts,
        (SELECT jsonb_build_object('folder',f.path,'uidValidity',f.uid_validity::text,
          'phase',ac.phase,'scanCursor',ac.scan_cursor::text,'sweepCursor',ac.sweep_cursor::text,
          'lastError',ac.last_error,'currentEpoch',coalesce(ac.uid_validity=f.uid_validity,false))
          FROM folders f LEFT JOIN archive_coverage ac ON ac.account_id=f.account_id AND ac.folder=f.path
          WHERE f.account_id=$1 AND f.path=$5) AS archive,
        coalesce((SELECT bytes::text FROM background_download_debits WHERE account_id=$1
          AND day=(now() AT TIME ZONE 'UTC')::date),'0') AS daily_bytes,
        (now() AT TIME ZONE 'UTC')::date::text AS budget_day,statement_timestamp() AS observed_at
      FROM email_accounts a LEFT JOIN search_index_accounts c ON c.account_id=a.id WHERE a.id=$1 AND a.user_id=$2`,
    [account.id, userId, ready, eligibility.normalPaths, eligibility.archiveFolder, SOURCE_CONTRACT_GENERATION]);
    // Recheck ownership/deletion at the aggregate, after the helper reads.
    if (!row) continue;
    const body = { sources: count(row.sources), physicalRows: count(row.physical_rows),
      verified: count(row.verified), unsupported: count(row.unsupported), failed: count(row.failed) };
    body.pending = body.sources - body.verified - body.unsupported - body.failed;
    body.cachedComplete = body.verified === body.sources && count(row.unknown_epoch_rows) === 0;
    result.push({ accountId: account.id, enabled: row.enabled, paused: row.paused,
      status: !row.enabled ? 'disabled' : row.paused ? 'paused' : body.failed ? 'failed'
        : body.unsupported ? 'unsupported' : body.cachedComplete ? 'cached-bodies-verified' : 'catching-up',
      scope: 'cached-eligible-messages', complete: false, providerMessageCount: null, estimateMs: null,
      metadata: { physicalRows: count(row.metadata_rows), unknownEpochRows: count(row.unknown_epoch_rows) },
      identity: { mode: ready ? count(row.physical_sources) ? 'mixed' : 'provider' : 'physical',
        physicalSources: count(row.physical_sources), bootstrapComplete: profile.labelStore ? ready : null },
      body, jobCounts: row.job_counts, unsupported: row.unsupported_details, archive: row.archive,
      // A bound reservation is charged even on a later refusal. This is the
      // existing durable debit, not an observed-wire-byte or quota guarantee.
      budget: { day: row.budget_day, chargedBytes: row.daily_bytes, limitBytes: null }, observedAt: row.observed_at });
  }
  return result;
}
