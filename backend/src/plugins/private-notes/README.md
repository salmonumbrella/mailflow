# Private thread notes

This opt-in plugin stores owner-private plain-text notes in revisioned plugin storage. It never
sends mail, shares notes, or changes message flags. Its reader footer is registered through the
neutral `message-reader-footer` slot.

## Identity and continuity

Requests accept only an owned cached message ID. The server derives the owner and account, then
uses the message's RFC Message-ID as the immutable note anchor. A mutable `thread_id` is used
for discovery, never as the sole location of a note.

`getOwnedThreadIdentities` reads the selected owned account's current thread members, including
retained deleted cache rows. Message-IDs, roots, In-Reply-To and References discover relevant
anchors. Root alias records link the discovered note anchors and tombstones durably, so deleting
the original noted message does not discard the conversation's notes. A save/delete commits the
note and its root links atomically. A read that discovers healed or merged roots repairs only
private plugin metadata before returning; a failed or repeatedly conflicted repair is reported.

A snapshot version hashes ordered storage keys and revisions. Every mutation checks that version
and atomically compares all underlying revisions, including absent anchors. Concurrent creates
on different anchors cannot both accept the same snapshot. Request IDs are idempotent across
merged roots. Deletion erases all matching plaintext copies and preserves their hashes/IDs as
retry tombstones.

## Bounds

- Notes: 1–4000 characters, with normal line breaks/tabs but no other control characters.
- Thread identity read: at most 100 distinct header tuples. Individual identity fields are at
  most 4096 characters and References at most 16384 characters.
- Discovery closure: at most 200 immutable anchor keys, including links and absent records.
- Aggregate state: at most 500 notes/tombstones and 240 KiB of serialized records.
- Atomic writes: at most 20 changed records, with at most 200 guarded keys.

Oversized conversations fail explicitly rather than showing an incomplete subset. Notes without
an RFC Message-ID cannot be saved because their cache row ID may change on a move. Tombstones
count toward the lifetime note limit so old retries cannot resurrect deleted content.

## Remaining identity limit

If sync reparents an old self-rooted message and then permanently removes that message **before
any notes read/write observes the new membership**, and surviving messages do not mention the old
anchor in References/In-Reply-To, no surviving evidence connects that immutable anchor to the new
thread. Its stored note is not deleted, but it cannot be discovered from that new thread. Fully
covering this requires durable thread-identity history in core or a sync hook that records every
root transition. This plugin deliberately does not modify the mail engine to infer that history.

## Tests

`routes.test.js` covers ownership, bounded text, idempotency, merge/delete conflicts and scope
closure. `routes.review.test.js` contains independent root-healing/expunge/privacy regressions.
`routes.postgres.test.js` exercises the actual ownership queries, storage transactions, merged
roots, concurrent alias growth, expunge, rollback and cross-owner/account isolation on a
disposable database. The frontend mounted tests cover escaped text, failed-input retention,
conflicts, session/lock changes and sender-context navigation.
