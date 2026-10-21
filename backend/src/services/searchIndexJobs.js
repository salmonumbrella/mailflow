import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';

const LEASE_MS = 120000;
const STRUCTURE_RESERVATION = 264192;

// Account -> control -> job -> message/folder is shared by every caller.
// A missing account is never re-created by a delayed worker.
async function lockAccount(client, accountId, { write = false, create = false, userId } = {}) {
  await client.query("SET LOCAL lock_timeout = '2s'");
  const mode = write ? 'UPDATE' : 'SHARE';
  const { rows: [account] } = await client.query(`SELECT enabled FROM email_accounts WHERE id=$1
    ${userId == null ? '' : 'AND user_id=$2'} FOR SHARE`, userId == null ? [accountId] : [accountId, userId]);
  if (!account) return null;
  if (create) await client.query('INSERT INTO search_index_accounts(account_id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
  const { rows: [control] } = await client.query(`SELECT * FROM search_index_accounts WHERE account_id=$1 FOR ${mode}`, [accountId]);
  return control ? { ...control, enabled: account.enabled } : null;
}

const claimParams = claim => [claim.account_id, claim.source_key, claim.lease_token, claim.lease_epoch, claim.run_epoch];
const CLAIM_WHERE = `j.account_id=$1 AND j.source_key=$2 AND j.lease_token=$3 AND j.lease_epoch=$4
  AND j.run_epoch=$5 AND j.state='running' AND j.lease_expires_at>now()
  AND EXISTS (SELECT 1 FROM email_accounts a JOIN search_index_accounts c ON c.account_id=a.id
    WHERE a.id=j.account_id AND a.enabled AND NOT c.paused AND c.run_epoch=$5)`;

function boundedInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function leaseDuration(value) {
  if (!boundedInteger(value, 'lease duration')) throw new Error('Invalid lease duration');
  return value;
}

// sourceKey/generation are supplied by the reviewed identity consumer, not
// inferred from RFC Message-ID. Same identity/generation preserves terminal work.
export async function enqueueSearchIndexJob(accountId, source, { client } = {}) {
  const enqueue = async client => {
    const control = await lockAccount(client, accountId, { write: true, create: true });
    if (!control?.enabled) return false;
    const { rowCount } = await client.query(`INSERT INTO search_index_jobs AS j
      (account_id,source_key,message_id,folder,uid,uid_validity,source_generation,message_date)
      SELECT m.account_id,$2,m.id,m.folder,m.uid,f.uid_validity,$7,m.date
      FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
      WHERE m.account_id=$1 AND m.id=$3 AND m.folder=$4 AND m.uid=$5 AND f.uid_validity=$6 AND NOT m.is_deleted
      ON CONFLICT(account_id,source_key) DO UPDATE SET
        message_id=EXCLUDED.message_id,folder=EXCLUDED.folder,uid=EXCLUDED.uid,uid_validity=EXCLUDED.uid_validity,
        source_generation=EXCLUDED.source_generation,message_date=EXCLUDED.message_date,state='queued',generation_id=NULL,
        lease_token=NULL,lease_expires_at=NULL,lease_epoch=j.lease_epoch+1,attempts=0,defer_at=NULL,last_error=NULL,
        pending_folder=NULL,pending_uid=NULL,pending_uid_validity=NULL,pending_body_bytes=NULL,
        unsupported_reason=NULL,unsupported_folder=NULL,unsupported_uid=NULL,unsupported_uid_validity=NULL,
        unsupported_source_generation=NULL,observed_download_bytes=NULL,structure_overrun_bytes=NULL
      WHERE EXCLUDED.source_generation>=j.source_generation AND
        (j.message_id,j.folder,j.uid,j.uid_validity,j.source_generation) IS DISTINCT FROM
        (EXCLUDED.message_id,EXCLUDED.folder,EXCLUDED.uid,EXCLUDED.uid_validity,EXCLUDED.source_generation)`,
    [accountId, source.sourceKey, source.messageId, source.folder, source.uid, source.uidValidity, source.sourceGeneration]);
    return rowCount > 0;
  };
  return client ? enqueue(client) : withTransaction(enqueue);
}

// Producer transitions share the same account/control serialization and the
// existing enqueue implementation; no caller holds this across an IMAP read.
export async function withSearchIndexAccount(accountId, fn, { userId } = {}) {
  return withTransaction(async client => {
    const control = await lockAccount(client, accountId, { write: true, create: true, userId });
    if (!control?.enabled || control.paused) return 0;
    return fn(client, control);
  });
}

export async function claimSearchIndexJob(accountId, { leaseMs = LEASE_MS } = {}) {
  leaseDuration(leaseMs);
  return withTransaction(async client => {
    const control = await lockAccount(client, accountId, { write: true });
    if (!control?.enabled || control.paused) return null;
    const { rows: active } = await client.query(`SELECT 1 FROM search_index_jobs
      WHERE account_id=$1 AND state='running' AND lease_expires_at>now()`, [accountId]);
    if (active.length) return null;
    const { rows: [job] } = await client.query(`SELECT * FROM search_index_jobs WHERE account_id=$1 AND
      ((state='running' AND lease_expires_at<=now()) OR (state IN ('queued','failed') AND (defer_at IS NULL OR defer_at<=now())))
      ORDER BY (state='running') DESC,(pending_body_bytes IS NOT NULL) DESC,
        priority_at DESC NULLS LAST,message_date DESC NULLS LAST,source_key LIMIT 1 FOR UPDATE`, [accountId]);
    if (!job) return null;
    const { rows: [claim] } = await client.query(`UPDATE search_index_jobs SET state='running',lease_token=$3,
      lease_epoch=lease_epoch+1,lease_expires_at=now()+$4*interval '1 millisecond',run_epoch=$5
      WHERE account_id=$1 AND source_key=$2 RETURNING *`,
    [accountId, job.source_key, randomUUID(), leaseMs, control.run_epoch]);
    return claim;
  });
}

// Called first INSIDE the publisher's transaction, never around an IMAP read.
// False is read-only; the publisher must not acknowledge a stale job.
export async function guardSearchIndexJob(client, claim) {
  const control = await lockAccount(client, claim.account_id);
  if (!control?.enabled || control.paused) return false;
  const { rows } = await client.query(`SELECT j.source_generation FROM search_index_jobs j
    WHERE ${CLAIM_WHERE} AND j.source_generation=$6 FOR UPDATE OF j`, [...claimParams(claim), claim.source_generation]);
  return rows.length === 1;
}

export async function heartbeatSearchIndexJob(claim, { leaseMs = LEASE_MS } = {}) {
  leaseDuration(leaseMs);
  return withTransaction(async client => {
    await lockAccount(client, claim.account_id);
    const { rowCount } = await client.query(`UPDATE search_index_jobs j SET lease_expires_at=now()+$6*interval '1 millisecond'
      WHERE ${CLAIM_WHERE}`, [...claimParams(claim), leaseMs]);
    return rowCount === 1;
  });
}

export function pendingSearchBodyBytes(job) {
  if (job.pending_folder !== job.folder || String(job.pending_uid) !== String(job.uid)
    || String(job.pending_uid_validity) !== String(job.uid_validity) || job.pending_body_bytes == null) return undefined;
  return boundedInteger(Number(job.pending_body_bytes), 'pending body bound');
}

// The integration layer maps extraction failures to these explicit bookkeeping
// outcomes. Completion is acknowledged only after guarded publication succeeds.
export async function settleSearchIndexJob(claim, outcome) {
  if (outcome.status === 'stale-job') return false;
  if (!['deferred', 'retry', 'cancelled', 'failed', 'unsupported', 'complete'].includes(outcome.status)) throw new Error('Invalid search job outcome');
  const terminal = outcome.status === 'unsupported';
  const complete = outcome.status === 'complete';
  const state = terminal ? 'unsupported' : complete ? 'complete' : outcome.status === 'failed' ? 'failed' : 'queued';
  const deferAt = terminal || complete ? null : new Date(outcome.deferAt ?? Date.now() + 60000);
  if (deferAt && !Number.isFinite(deferAt.getTime())) throw new Error('Invalid search job deferral');
  const pending = outcome.status === 'deferred' && outcome.bodyBytes != null;
  const identity = outcome.identity;
  if (pending && (!identity || identity.accountId !== claim.account_id || identity.folder !== claim.folder
    || String(identity.uid) !== String(claim.uid) || String(identity.uidValidity) !== String(claim.uid_validity))) throw new Error('Stale pending body identity');
  const bodyBytes = pending ? boundedInteger(outcome.bodyBytes, 'body bound') : null;
  const observed = terminal ? boundedInteger(outcome.downloadBytes ?? 0, 'observed download bytes') : null;
  const overrun = terminal ? outcome.reason === 'structure-too-large'
    ? boundedInteger(outcome.structureOverrunBytes ?? Math.max(0, observed - STRUCTURE_RESERVATION), 'structure overrun') : 0 : null;
  if (terminal && !outcome.reason) throw new Error('Unsupported search job needs a reason');
  if (complete && !outcome.generationId) throw new Error('Completed search job needs a generation');
  const clearPending = terminal || complete || outcome.reason === 'bound-changed';
  return withTransaction(async client => {
    await lockAccount(client, claim.account_id);
    const { rowCount } = await client.query(`UPDATE search_index_jobs j SET state=$6,defer_at=$7,last_error=$8,
      attempts=attempts+$9,lease_token=NULL,lease_expires_at=NULL,
      generation_id=CASE WHEN $6='complete' THEN $10::uuid ELSE generation_id END,
      pending_folder=CASE WHEN $11 THEN $12 WHEN $13 THEN NULL ELSE pending_folder END,
      pending_uid=CASE WHEN $11 THEN $14::bigint WHEN $13 THEN NULL ELSE pending_uid END,
      pending_uid_validity=CASE WHEN $11 THEN $15::bigint WHEN $13 THEN NULL ELSE pending_uid_validity END,
      pending_body_bytes=CASE WHEN $11 THEN $16::bigint WHEN $13 THEN NULL ELSE pending_body_bytes END,
      unsupported_reason=CASE WHEN $6='unsupported' THEN $8 END,
      unsupported_folder=CASE WHEN $6='unsupported' THEN folder END,
      unsupported_uid=CASE WHEN $6='unsupported' THEN uid END,
      unsupported_uid_validity=CASE WHEN $6='unsupported' THEN uid_validity END,
      unsupported_source_generation=CASE WHEN $6='unsupported' THEN source_generation END,
      observed_download_bytes=$17,structure_overrun_bytes=$18
      WHERE ${CLAIM_WHERE}`, [...claimParams(claim), state, deferAt, outcome.reason || null,
      outcome.status === 'failed' ? 1 : 0, outcome.generationId || null, pending, identity?.folder || null, clearPending,
      identity?.uid ?? null, identity?.uidValidity ?? null, bodyBytes, observed,
      overrun]);
    return rowCount === 1;
  });
}

// These are account control operations, not worker outcomes. The control row's
// UPDATE lock excludes publishers and fenced writes without excluding identity reads.
async function changeRun(accountId, action, { userId } = {}) {
  return withTransaction(async client => {
    const control = await lockAccount(client, accountId, { write: true, create: true, userId });
    if (!control) return null;
    if (action === 'retry') {
      await client.query("UPDATE search_index_jobs SET state='queued',attempts=0,defer_at=NULL,last_error=NULL WHERE account_id=$1 AND state='failed'", [accountId]);
      return control;
    }
    const { rows: [next] } = await client.query(`UPDATE search_index_accounts SET run_epoch=run_epoch+1,
      paused=CASE WHEN $2='pause' THEN true WHEN $2='resume' THEN false ELSE paused END WHERE account_id=$1 RETURNING *`, [accountId, action]);
    await client.query("UPDATE search_index_jobs SET state='queued',lease_token=NULL,lease_expires_at=NULL WHERE account_id=$1 AND state='running'", [accountId]);
    return next;
  });
}

export async function setSearchCoverageAction(accountId, action, options) {
  if (!['pause', 'resume', 'retry'].includes(action)) throw new Error('Invalid search coverage action');
  return changeRun(accountId, action, options);
}

// Bookkeeping is useful before catch-up finishes. These counts are job states;
// verified body coverage must independently inspect live generation pointers.
export async function readSearchIndexJobState(accountId, { userId } = {}) {
  return withTransaction(async client => {
    const { rows: [row] } = await client.query(`SELECT coalesce(c.paused,false) AS paused,
      jsonb_build_object('queued',count(*) FILTER (WHERE j.state='queued'),
        'running',count(*) FILTER (WHERE j.state='running'),'complete',count(*) FILTER (WHERE j.state='complete'),
        'failed',count(*) FILTER (WHERE j.state='failed'),'unsupported',count(*) FILTER (WHERE j.state='unsupported')) AS counts
      FROM email_accounts a LEFT JOIN search_index_accounts c ON c.account_id=a.id
      LEFT JOIN search_index_jobs j ON j.account_id=a.id
      WHERE a.id=$1 ${userId == null ? '' : 'AND a.user_id=$2'} GROUP BY a.id,c.paused`,
    userId == null ? [accountId] : [accountId, userId]);
    return row ? { paused: row.paused, jobCounts: row.counts } : null;
  });
}

export const invalidateSearchIndexRun = accountId => changeRun(accountId, 'disconnect');

// Caller must quiesce/drain workers before TRUNCATE and call this after imported
// rows, in the same restore transaction. Tokens fence even lower restored epochs.
export async function resetSearchIndexLeasesAfterRestore(client) {
  await client.query(`UPDATE search_index_jobs SET lease_token=NULL,lease_expires_at=NULL,
    state=CASE WHEN state='running' THEN 'queued' ELSE state END`);
}

// No message locks: this must not add message -> job edges opposite to the
// publisher. A completed settlement may request cleanup only of its exact epoch.
export async function pruneSearchIndexLocators(accountId, { sourceKey, leaseEpoch, runEpoch } = {}) {
  return withTransaction(async client => {
    const control = await lockAccount(client, accountId, { write: true });
    if (!control?.enabled || control.paused || (runEpoch != null && String(control.run_epoch) !== String(runEpoch))) return 0;
    const { rowCount } = await client.query(`WITH obsolete AS (
        SELECT j.account_id,j.source_key,j.lease_token,j.lease_epoch,j.run_epoch,j.source_generation
        FROM search_index_jobs j WHERE j.account_id=$1
          AND ($2::text IS NULL OR j.source_key=$2) AND ($3::bigint IS NULL OR j.lease_epoch=$3)
          AND (j.state<>'running' OR j.lease_expires_at<=now())
          AND NOT (j.state='unsupported' AND j.source_key LIKE 'provider:%')
          AND NOT EXISTS (SELECT 1 FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
            WHERE m.account_id=j.account_id AND m.id=j.message_id AND m.folder=j.folder AND m.uid=j.uid
              AND f.uid_validity=j.uid_validity AND NOT m.is_deleted)
        ORDER BY j.source_key LIMIT 50 FOR UPDATE OF j
      ) DELETE FROM search_index_jobs j USING obsolete o
      WHERE j.account_id=o.account_id AND j.source_key=o.source_key
        AND j.lease_token IS NOT DISTINCT FROM o.lease_token AND j.lease_epoch=o.lease_epoch
        AND j.run_epoch=o.run_epoch AND j.source_generation=o.source_generation
        AND (j.state<>'running' OR j.lease_expires_at<=now())
        AND EXISTS (SELECT 1 FROM search_index_accounts c WHERE c.account_id=j.account_id AND c.run_epoch=$4 AND NOT c.paused)`,
    [accountId, sourceKey ?? null, leaseEpoch ?? null, control.run_epoch]);
    return rowCount;
  });
}
