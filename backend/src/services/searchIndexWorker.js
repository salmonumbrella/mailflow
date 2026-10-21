import { query, withTransaction } from './db.js';
import { isIdentityBootstrapComplete } from './archiveCoverage.js';
import { searchIndexEligibility, eligibleSearchIndexTarget } from './searchIndexEligibility.js';
import { searchSourceKey, searchSourceVersion } from './searchIndexIdentity.js';
import { reserveBackgroundBudget, recordBackgroundRefusal } from './backgroundDownloadBudget.js';
import { publishSearchGeneration } from './searchIndex.js';
import { claimSearchIndexJob, guardSearchIndexJob, heartbeatSearchIndexJob, pendingSearchBodyBytes,
  pruneSearchIndexLocators, settleSearchIndexJob } from './searchIndexJobs.js';

const RETRY_MS = 60000;
const sourceVersion = searchSourceVersion;
const failedDelay = attempts => Math.min(3600000, RETRY_MS * 2 ** Math.min(6, attempts));

async function currentTargets(claim, identityReady, eligibility) {
  const { rows: [source] } = await query(`SELECT m.id,m.folder,m.uid::text,f.uid_validity::text AS "uidValidity",
      m.provider_msgid,m.is_archive_residue,f.no_select,f.special_use
    FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
    WHERE m.account_id=$1 AND m.id=$2 AND m.folder=$3 AND m.uid=$4 AND f.uid_validity=$5 AND NOT m.is_deleted`,
  [claim.account_id, claim.message_id, claim.folder, claim.uid, claim.uid_validity]);
  const eligible = row => !row.no_select && eligibleSearchIndexTarget(row,eligibility);
  if (!source || !eligible(source) || searchSourceKey({ ...source,uid_validity:source.uidValidity },identityReady)!==claim.source_key) return [];
  if (!identityReady || !source.provider_msgid) return [source];
  const { rows } = await query(`SELECT m.id,m.folder,m.uid::text,f.uid_validity::text AS "uidValidity",m.is_archive_residue,f.no_select,f.special_use
    FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
    WHERE m.account_id=$1 AND m.provider_msgid=$2 AND NOT m.is_deleted
      AND f.uid_validity IS NOT NULL ORDER BY m.id`, [claim.account_id, source.provider_msgid]);
  return rows.filter(eligible);
}

// Reconcile a lost acknowledgement from live, exact-version pointers only.
// The saved job generation_id is bookkeeping and cannot certify this read.
async function alreadyPublished(claim, targets) {
  return withTransaction(async client => {
    if (!await guardSearchIndexJob(client, claim)) return null;
    const { rows } = await client.query(`SELECT m.id,m.search_generation_id
      FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
      JOIN search_text_generations g ON g.id=m.search_generation_id AND g.account_id=m.account_id
      JOIN jsonb_to_recordset($2::jsonb) AS t(id uuid,uid bigint,folder text,"uidValidity" bigint)
        ON m.id=t.id AND m.uid=t.uid AND m.folder=t.folder AND f.uid_validity=t."uidValidity"
      WHERE m.account_id=$1 AND NOT m.is_deleted AND g.source_key=$3 ORDER BY m.id FOR UPDATE OF m FOR SHARE OF f`,
    [claim.account_id, JSON.stringify(targets), sourceVersion(claim)]);
    if (rows.length !== targets.length || !rows.length || rows.some(row => row.search_generation_id !== rows[0].search_generation_id)) return null;
    return rows[0].search_generation_id;
  });
}

async function obsolete(claim) {
  const settled = await settleSearchIndexJob(claim, { status: 'cancelled', reason: 'stale-identity', deferAt: Date.now() + RETRY_MS });
  if (settled) await pruneSearchIndexLocators(claim.account_id, {
    sourceKey: claim.source_key, leaseEpoch: claim.lease_epoch, runEpoch: claim.run_epoch,
  });
}

async function runClaim(account, claim, { signal, fetchMessageBody, identityReady, eligibility, foregroundPending, profile, enqueueRows }) {
  const lease = new AbortController();
  const combined = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
  let timer, pendingHeartbeat;
  const stopHeartbeat = async () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (pendingHeartbeat) await pendingHeartbeat;
  };
  const defer = (reason, deferAt = Date.now() + RETRY_MS) => settleSearchIndexJob(claim, { status: 'retry', reason, deferAt });
  let published;
  try {
    const targets = await currentTargets(claim, identityReady, eligibility);
    if (!targets.length) { await obsolete(claim); return { processed: true }; }
    const existing = await alreadyPublished(claim, targets);
    if (existing) published = { published: true, generationId: existing };
    else {
      if (combined.aborted || foregroundPending?.()) {
        await settleSearchIndexJob(claim, { status: 'cancelled', reason: 'cancelled', deferAt: Date.now() + RETRY_MS });
        return { deferred: true };
      }
      if (!await heartbeatSearchIndexJob(claim)) return { stale: true };
      timer = setInterval(() => {
        if (pendingHeartbeat) return;
        pendingHeartbeat = heartbeatSearchIndexJob(claim)
          .then(current => { if (!current) lease.abort(); })
          .catch(() => { lease.abort(); })
          .finally(() => { pendingHeartbeat = null; });
      }, 30000);
      timer.unref();
      const extraction = await fetchMessageBody(account, claim.uid, claim.folder, {
        purpose: 'search', signal: combined, uidValidity: claim.uid_validity,
        reservedBodyBytes: pendingSearchBodyBytes(claim),
        admit: reservation => combined.aborted || foregroundPending?.()
          ? Promise.resolve({ allowed: false, deferAt: Date.now() + RETRY_MS })
          : reserveBackgroundBudget(account.id, account.imap_host, reservation),
      });
      await stopHeartbeat(); // Do not contend with our own publication's job lock.
      if (combined.aborted) {
        await settleSearchIndexJob(claim, { status: 'cancelled', reason: 'cancelled', deferAt: Date.now() + RETRY_MS });
        return { deferred: true };
      }
      if (extraction.status === 'deferred' || extraction.status === 'unsupported' || extraction.status === 'cancelled') {
        await settleSearchIndexJob(claim, extraction);
        return { processed: extraction.status === 'unsupported', deferred: extraction.status !== 'unsupported' };
      }
      if (extraction.reason === 'stale-identity') { await obsolete(claim); return { processed: true }; }
      if (extraction.status === 'provider-refused' || extraction.status === 'backoff') {
        if (extraction.status === 'provider-refused') recordBackgroundRefusal(account.imap_host);
        await defer(extraction.reason || extraction.status, extraction.deferAt ?? Date.now() + Math.max(RETRY_MS, extraction.retryAfterMs || 0));
        return { deferred: true };
      }
      if (extraction.reason === 'budget-failed' || extraction.reason === 'bound-changed') {
        await defer(extraction.reason, extraction.deferAt);
        return { deferred: true };
      }
      if (extraction.complete !== true) {
        await settleSearchIndexJob(claim, { status: 'failed', reason: extraction.reason || 'incomplete',
          deferAt: Date.now() + failedDelay(claim.attempts) });
        return { deferred: true };
      }
      published = await publishSearchGeneration({ accountId: account.id, sourceKey: sourceVersion(claim), targets,
        extraction, guard: client => guardSearchIndexJob(client, claim) });
    }
  } catch (error) {
    await stopHeartbeat();
    if (error.code === '55P03') await defer('lock-timeout');
    else if (combined.aborted || error.name === 'AbortError') {
      await settleSearchIndexJob(claim, { status: 'cancelled', reason: 'cancelled', deferAt: Date.now() + RETRY_MS });
    } else await settleSearchIndexJob(claim, { status: 'failed', reason: 'index-failed', deferAt: Date.now() + failedDelay(claim.attempts) });
    return { deferred: true };
  } finally { await stopHeartbeat(); }
  if (published.published) {
    // Keep this outside the failure handler: a lost ack must leave the durable
    // claim for exact-pointer reconciliation, not rewrite a committed success.
    const current=await settleSearchIndexJob(claim, { status: 'complete', generationId: published.generationId });
    if(!current)return{stale:true};
    // After the completion COMMIT, rederive current membership. A copy which
    // arrived during extraction/publication must not wait for a date wrap.
    // This remains inside the lifecycle's tracked/drained batch promise.
    const reverify=await enqueueRows(account,[claim.message_id],{profile,signal:combined});
    return { processed: true, deferred:reverify.deferred || reverify.changed>0 };
  }
  if (published.status === 'stale-job') return { stale: true }; // Absolutely no job write.
  if (published.status === 'stale-identity') await obsolete(claim);
  else await defer(published.status || 'incomplete');
  return { deferred: true };
}

// Existing IMAP scheduling supplies this consumer and its bound fetch method.
// This function does not acquire a session, parse mail, or implement admission.
export async function runSearchIndexBatch(account, { signal, fetchMessageBody, labelStore = false, profile = { labelStore }, foregroundPending, enqueueRows } = {}) {
  if (typeof fetchMessageBody !== 'function') throw new Error('Search index batch needs the existing search extractor');
  if (typeof enqueueRows !== 'function') throw new Error('Search index batch needs lifecycle-bound enqueueRows');
  if (signal?.aborted || foregroundPending?.()) return { processed: 0 };
  const identityReady = await isIdentityBootstrapComplete(account.id,profile);
  const eligibility = await searchIndexEligibility(account.id,profile);
  await pruneSearchIndexLocators(account.id);
  let processed = 0;
  for (let n = 0; n < 20 && !signal?.aborted && !foregroundPending?.(); n++) {
    const claim = await claimSearchIndexJob(account.id);
    if (!claim) break;
    const result = await runClaim(account, claim, { signal, fetchMessageBody, identityReady, eligibility, foregroundPending, profile, enqueueRows });
    if (result.processed) processed++;
    if (result.deferred || result.stale) break;
  }
  return { processed };
}
