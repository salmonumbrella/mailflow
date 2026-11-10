import { query } from './db.js';

// UIDs the server lists but will not hand over.
//
// The folder integrity check counts a UID as missing when the server reports it and we have
// no row for it. That is correct, except when the server will never produce the message: it
// schedules a backfill, the backfill asks for exactly those UIDs, nothing comes back, and
// the next pass finds the same gap. A production iCloud account ran that loop 35 times in
// five hours over the same five UIDs, and would have run it forever.
//
// These are not phantom SEARCH results. The integrity check throws if SEARCH and the flag
// FETCH disagree, so the server is consistent that they exist; it just cannot return them.
//
// So: count how many times each UID has been asked for and refused, and once that passes a
// threshold, stop counting it as missing. Give up on the message, not on the mailbox.

// One miss is not enough. A batch can come back short because a connection dropped mid-fetch
// or the server was busy, and writing those off after a single attempt would quietly abandon
// retrievable mail. Three consecutive refusals is a server that means it.
export const UNFETCHABLE_ATTEMPT_THRESHOLD = 3;

// Servers do get fixed, and a UID written off today may be retrievable next week. Entries
// older than this are ignored, so the mailbox is retried rather than written off permanently.
export const UNFETCHABLE_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Record that these UIDs were requested and not returned. Called per backfill batch with
 * whatever the server omitted, so a UID that fails repeatedly climbs toward the threshold
 * while one that succeeds next time is cleared by clearUnfetchable.
 */
export async function recordUnfetchable(accountId, folder, uids, uidValidity, client = { query }) {
  if (!uids?.length) return;
  // A record with no epoch cannot be scoped, and an unscoped record suppresses a UID under
  // every future generation: after a renumbering that UID number belongs to a different
  // message, which we would then silently never fetch. Better to forget the ghost than to
  // risk skipping real mail, so if the server did not tell us the UIDVALIDITY, record nothing.
  if (uidValidity == null) return;
  await client.query(
    `INSERT INTO unfetchable_uids (account_id, folder, uid, uid_validity)
     SELECT $1, $2, unnest($3::bigint[]), $4
     ON CONFLICT (account_id, folder, uid) DO UPDATE
       -- A renumbered mailbox restarts the count: these are different messages now.
       SET attempts = CASE WHEN unfetchable_uids.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
                           THEN 1 ELSE unfetchable_uids.attempts + 1 END,
           last_attempt_at = now(),
           uid_validity = EXCLUDED.uid_validity`,
    [accountId, folder, uids.map(String), uidValidity == null ? null : String(uidValidity)]
  );
}

/**
 * UIDs that have been refused often enough, and recently enough, to stop counting as missing.
 * Scoped to the current uidvalidity: after a renumbering the stored UIDs describe messages
 * that no longer exist and must not suppress a real gap.
 */
export async function suppressedUids(accountId, folder, uidValidity) {
  // Without a current epoch there is nothing to match against, and matching everything is
  // the failure mode above. Suppress nothing: re-requesting a ghost costs one FETCH.
  if (uidValidity == null) return new Set();
  const { rows } = await query(
    `SELECT uid FROM unfetchable_uids
      WHERE account_id = $1 AND folder = $2
        AND attempts >= $3
        AND last_attempt_at > now() - ($4::bigint || ' milliseconds')::interval
        -- Exact epoch match only. The previous version also matched when either side was
        -- NULL, which made those rows wildcards across generations.
        AND uid_validity = $5`,
    [accountId, folder, UNFETCHABLE_ATTEMPT_THRESHOLD, String(UNFETCHABLE_RETRY_AFTER_MS),
     uidValidity == null ? null : String(uidValidity)]
  );
  return new Set(rows.map(r => Number(r.uid)));
}

/** A UID that finally arrived is not unfetchable. Clears any record so the count restarts. */
export async function clearUnfetchable(accountId, folder, uids, client = { query }) {
  if (!uids?.length) return;
  await client.query(
    'DELETE FROM unfetchable_uids WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::bigint[])',
    [accountId, folder, uids.map(String)]
  );
}

/**
 * Decide whether the folder still has a real gap, given what the server lists, what we hold,
 * and what has been written off. Pure, so the rule is testable without a database.
 */
export function hasRealGap(serverUids, localUids, suppressed) {
  for (const uid of serverUids) {
    if (!localUids.has(uid) && !suppressed.has(uid)) return true;
  }
  return false;
}
