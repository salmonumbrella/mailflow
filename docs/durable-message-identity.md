# Durable message identity

The identity foundation supplies durable message identities for native MailFlow metadata.
The native label membership slice described below builds on it. Provider label synchronization
and compose-label handoff remain unimplemented.

## Verified identity

A message entity outlives the disposable `messages` cache UUID. Its scope is an account and
that account's storage generation. A location additionally includes folder path,
UIDVALIDITY and UID. Provider keys are exact strings in distinct `imap-objectid` and
`gmail-x-gm-msgid` namespaces, selected from the current IMAP session's capabilities.
OBJECTID takes precedence, matching ImapFlow's FETCH implementation. Hostname, RFC
Message-ID, subject, thread key, old `provider_msgid`, and identical content are never
identity proof.

The five durable tables in migration 0079 are `message_entities`, `entity_provider_keys`,
`entity_locations`, `mailbox_identity_epochs`, `mail_identity_operations`. The existing account gains a
`storage_generation` field. Cache identity references
are nullable until verified. They have complete-tuple and same-account/generation foreign
keys. No durable table references `messages` or `folders`.

## Engine integration and concurrency

`messageIdentity.js` serializes identity writes with the account row lock. It does not
hold a database transaction open during provider calls. The engine reads a durable epoch
revision before SELECT, observes the fresh selected epoch with compare-and-swap, then
requires that generation and revision for every cache write. Backfill keeps the original
verified epoch across reconnects; stale batches cannot change it back. Empty mailboxes
still process epoch transitions.

The cache write and entity binding commit together. A historical cache row without a
captured epoch is not certified by a new envelope: its old body is discarded before that
UID's freshly fetched metadata is inserted. Existing unverified rows participate in
bounded reconciliation rather than being skipped indefinitely. Provider identity
conflicts retain durable evidence and refuse reassignment.

A cache guard prevents legacy folder/UID updates from carrying identity through a guessed
move. A confirmed journal mapping may translate a MOVE source binding to the exact
destination epoch. Without that proof the moved cache row is provisional; the original
entity survives. Native identity fields are excluded from the Message-ID-based in-memory
`movedRowCarry` mechanism.

## App-controlled provider operations

MOVE, COPY and APPEND write durable intents before making a provider call. Each source in
a batch has its own operation record. An exact COPYUID/APPENDUID response supplies both
destination UID and UIDVALIDITY. A response without the full mapping remains unresolved;
source UID is never substituted, and content matching is not durable identity proof.

A confirmed MOVE retains the source entity. If destination sync won the race, only an
untouched provisional entity (`metadata_version = 0`) may become a durable alias of the
proved source. Conflicting provider keys or user metadata block reconciliation rather
than overwrite a decision. Future membership writers must use the same account lock and
advance the metadata version on every label, importance or star-color change.
`resolveCanonicalEntity(transactionClient, {accountId, storageGeneration}, entityId)`
resolves a historical entity ID under that account lock. A proved merge also updates
operation source/destination pointers and flattens aliases, so a subsequent prepared MOVE
does not revive an obsolete entity. This milestone does not implement merging label decisions.

A generic COPY has its own entity. If a subsequent verified provider-key FETCH proves that
a COPY destination is a projection of the source, the exact COPY journal permits the
provisional destination to alias the source. Merely advertising Gmail support or using a
Google hostname is insufficient.

A prepared intent can represent a process crash before or after provider work. Transport
uncertainty is retained as `outcome_unknown`. Confirmed but unbindable operations are
`unresolved`. No background worker replays these operations. No message body, credential,
or raw exception text is stored in journal evidence. This preserves uncertainty; it does
not manufacture proof after a missing response.

## Account changes and recovery status

Ordinary password changes and token refresh retain generation. Changing the effective
mailbox selector requires an explicit same-mailbox versus replacement decision and an
expected-generation check. A replacement clears only disposable caches and creates a new
generation. Old entities, keys, locations and intents remain available for recovery.
Declaring the same mailbox does not retroactively certify cached coordinates.

The owned account identity-status endpoint reports current bound entities, entities with
no live cached location, unverified cache rows, unresolved operations and prior-generation
entities. These are cache/recovery counts, not whole-server message totals. A cache-only
purge or setup-only restore can temporarily increase unresolved counts until a verified
same-epoch location or provider key is fetched again.

External generic moves and UIDVALIDITY resets without stable provider identity cannot
always be matched. The same message header or identical bytes may belong to independent
deliveries. Old metadata is retained rather than guessed onto new mail. This first slice
also does not implement durable locator/epoch migration for app-initiated or external folder
renames. The app rename route guards the generation of its local cache/path updates, but a
changed-path cache binding becomes provisional unless separately proved. Original entities
and old locations remain unresolved; a fresh stable-provider-key FETCH can rebind them.
Generic app-rename metadata continuity and user-directed reassociation controls require
their own proved operation/recovery integration and are not claimed here.

## Tests and acceptance limits

`messageIdentity.postgres.test.js` applies the real migrations in a disposable database.
It covers current-epoch recovery, provider namespace and account isolation, exact large
provider IDs, direct constraints with the cache guard disabled, contradictory evidence,
MOVE destination-sync-first and actual concurrent transactions, COPY semantics, reset
versus stale writers, APPENDUID, unknown outcomes, and generation replacement. Engine and
account route suites exercise the real adapters separately. PostgreSQL suites are opt-in
through `MAILFLOW_TEST_DATABASE_URL`; a skipped suite is not acceptance.

Local checks can run against an isolated PostgreSQL 17 instance. The supported CI target
remains Node 22 and PostgreSQL 16. No live-provider operation or browser acceptance test
was performed for this milestone. Native label membership and cache-backed UI are the following local slice described below;
rule and composer handoffs remain subsequent milestones.

## Stale asynchronous work and pending account jobs

Generation and epoch checks protect flags, deletion reconciliation, LIST pruning, integrity
checkpoints, backfill counters, snippet success/failure writes, and STATUS samples as well as
message insertion. IMAP clients carry their creation generation; a fresh account row cannot
relabel an old connection. Local folder-rename updates share the account lock. Provider
success followed by a bookkeeping failure remains success with pending identity recovery;
known-stale destination mappings never authorize a local MOVE/COPY/APPEND cache write.

Snoozes capture a canonical entity and account generation under the account lock, advancing
its metadata version. Headers are conversation hints, never snooze identity. Legacy NULL
entities, prior generations, missing current locations and pending wake claims are held and
reported in identity status. Live view/count/manual/sweep joins require the same entity's
exact present location in the current mailbox epoch. Cache absence never deletes a decision.
A same-generation UIDVALIDITY reset cannot transfer a snooze to an unrelated delivery.

Wake work preserves the originally selected source tuple across every await. The durable
claim is committed before MOVE. An acknowledged move uses its exact journal mapping for
cache/count changes, and only its proved destination snapshot may receive an unread STORE.
No-map responses never search by header or guess a UID. Missing mapping, transport uncertainty,
and post-ack cache/count/flag bookkeeping failures retain a held claim rather than replay
MOVE. A successful initial snooze can become live after verified destination sync, while
an initial uncertain MOVE remains held. Recovery UI/reassociation and automatic completion
of held claims are not implemented. Folder rename continuity remains subject to the earlier
limitations. Setup and full backups retain bound and legacy snooze decisions, including
pending states, and reject backups omitting this durable table or its fields.

Replacement is refused while nonterminal scheduled messages or enabled account-specific rules
exist. The user must cancel/resolve schedules and disable those rules first. Generation
provenance and account-locking triggers serialize creation, claim/resume, and rule enable
against replacement. Delayed work prepared for the old generation is rejected rather than
adopted. Disabled old rules and terminal old schedules remain stored; enabling/resuming them
cannot silently bind them to the new mailbox. Global user rules retain their existing scope.
SMTP success/outcome bookkeeping remains permitted without authorizing another send.

Automated moves may pass an `expectedSource` snapshot to `moveMessage`. Preparation checks
its cache UUID, entity, generation, folder, UIDVALIDITY and UID in the same transaction that
journals intent. Unverified sources and sources changed while AI or a queue was running fail
closed; no content/header similarity substitutes for that proof.

`setFlag(account, uid, folder, flag, value, { expectedSource } = {})` captures a verified
source before entering the per-account flag queue, including for callers without an explicit
snapshot. Both the persistent and pooled STORE paths validate the captured generation,
epoch/revision and source UUID/entity after mailbox selection and refresh. Stale proof fails
without STORE or fallback/retry. Successful STORE is not replayed because later bookkeeping
or account state changed. Unverified cache rows must be freshly verified before a queued
flag mutation can be sent.

Failed flag retries retain the producer's original verified source snapshot through
`_enqueueFlagPush(accountId, messageId, flag, value, { expectedSource })`. Entries without
proof are refused, not repaired by looking up whichever row now occupies that UID. Marker
rebump, local value reassertion and marker clearing all share the account/source identity
transaction; retry STORE receives the same snapshot. Identity failures discard the stale
retry. A newer queued toggle invalidates older callbacks. This slice fails closed if the
captured source moved; it does not relocate retry intent by Message-ID or cache UUID alone.

## Direct destructive route boundaries

Copy, move, archive, delete, manual spam and initial snooze requests preserve the first
owned message projection's verified cache UUID, entity, generation, folder, UIDVALIDITY
and UID through provider calls. Bulk operations carry one such snapshot per UID. Missing
or stale proof is a conflict, never a request to look up the replacement UID's new row.
Post-command local MOVE writes use the matching durable journal and account lock. Only a
current exact destination mapping permits destination cache writes; confirmed source-only
cleanup uses the original source tuple and source epoch. Unknown outcomes remain pending.
Source and destination count changes share the same transaction, and a destination already
filed by sync is not counted twice. Trash moves rotate the cache UUID so replaying the old
DELETE cannot expunge the newly trashed row. A cache or count write failure after provider
acknowledgement is reported as pending recovery rather than a failed provider mutation.

Bulk MOVE and permanent-delete accept `expectedSources`, one original verified row for every
requested UID. Default UID-only calls capture the batch before connection/selection waits.
Preparation validates every row under one account transaction, so a bad second row cannot
leave a partially prepared batch. Exact provider mappings support proved cache updates;
unmapped acknowledged MOVE and uncertain attempted deletion return pending UID sets, without
heuristic relocation, source-absence guesses or automatic mutation replay.

Folder empty captures its account and epoch before selection, revalidates after SEARCH and
before each chunk/retry, and returns the epoch context even for an already empty mailbox.
Folder rename/delete recheck a known durable epoch with STATUS after deselection. Containers
without a verified selectable epoch have only the generation fence; this does not manufacture
mailbox-object proof for a recreated same-generation path. Successful folder actions return
captured context so route bookkeeping can refuse newer-generation/epoch cache rows. Post-COPY
plugin refresh failure is bookkeeping uncertainty, not grounds to repeat an acknowledged COPY.

## Native label membership slice

Migration 0082 adds `native_label_memberships` and `native_label_mutations`. Memberships
reference account/generation/entity and account/label composite keys, never disposable
message or folder rows. Labels remain local account-owned definitions. No IMAP command,
legacy folder-backed label operation, GTD operation or provider synchronization is part of
this writer. Provider labels, search/rule assignment and compose handoff remain separate.

All supported writes use `nativeLabelMemberships.js`. The lock order is account FOR UPDATE,
label state/definitions, then canonical entities and memberships. Definition changes and
subtree deletion use the same account-first order. The mutation resolves historical aliases,
checks ownership/current generation/live exact cached location and every expected metadata
version, then commits the entire account batch. An explicit add/remove decision increments
metadata_version once per distinct canonical entity even when its set is unchanged. This
prevents a later provisional merge from erasing an intentional no-op removal. A database
guard rejects direct membership writes onto version-zero or alias entities; it is a
merge-safety backstop, not a replacement for the service's authorization, lock ordering,
version checks, idempotency or version advancement. Direct SQL membership editing is not a
supported writer API. No metadata decisions are silently unioned during reconciliation.

POST `/api/labels/memberships/query` accepts `{accountId, storageGeneration, targets}` where
each target is `{entityId}`. POST `/api/labels/memberships` additionally requires a UUID
`mutationId`, `addLabelIds`, `removeLabelIds`, and an `expectedMetadataVersion` decimal string
on each target. There must be 1–200 distinct requested entities, at most 100 labels in each
delta, at least one decision, and no label in both deltas. Account, generation, entity and
label identifiers are UUIDs. A target is an explicit message entity, not a whole conversation
inferred from a thread head or matching headers.

Both return `{accountId, storageGeneration, targets}`. Each response target carries
`requestedEntityId`, canonical `entityId`, decimal-string `metadataVersion`, `available`, and
`labelIds`; a mutation also returns `mutationId`. A query can describe retained metadata with
`available:false`; a new mutation requires a live verified, non-deleted cached source in the
current epoch. This is a cache availability requirement, not a claim that mail vanished from
the server. Exact alias targets are deduplicated only after every expected version is checked.
Errors include 409 `stale_generation`, `stale_metadata_version`, `identity_unavailable`,
`mutation_conflict`, and `mutation_expired`, plus 400 invalid input and 404 ownership/label/entity
failures. A rejected batch leaves no changes or successful mutation record.

The journal stores the request hash and exact generation-tagged response atomically with the
changes. An exact retry returns that historical response before current generation, label or
version checks; it never re-executes after intervening edits, deletion, cache purge or account
replacement. Clients must refresh and must not apply historical responses to a different
current account/generation. Expired responses are removed after 30 days but their used-key
hash tombstones remain permanently, so an old retry cannot become a new assignment. A changed
request with a reused mutation ID fails. Successful new mutations send an owner-scoped
`label_memberships_changed` notification with accountId, storageGeneration and canonical
entityIds after commit. Replays do not push; push failure cannot reverse committed success.

Subtree deletion previews disclose membership and distinct-entity counts per storage
generation, including retained generations. Deletion increments affected entity versions
once and removes definitions/memberships only; it does not move or delete any mail or folder.
Both new tables belong to setup and full backups. Same-schema restores reject omitted tables
or columns, preserve journal tombstones and exact large versions, and keep their guard active.
All native-label routes remain excluded from API-token access until explicit token scope
contracts are introduced. Existing session authentication, CSRF and screen lock still apply.

Real PostgreSQL tests cover concurrency, alias resolution, explicit no-op protection, stale
batch rollback, scoped FK/guard failures, definition deletion across generations, exact replay,
cache purge/rebinding, and setup/full restore with omission rejection. Browser and live-provider
acceptance remain outstanding; passing these tests does not complete the Gmail parity checklist.

### Native label Undo

A confirmed forward membership response advertises `undoSupported:true`. POST
`/api/labels/memberships/undo` accepts `{accountId, storageGeneration, originalMutationId,
mutationId}`; the last field is a new UUID identifying the Undo request. The server, not the
client, supplies the inverse. The forward journal stores a private per-target membership
preimage and exact post-forward metadata versions in `undo_state`, tagged with explicit
`operation_kind='apply'`. Ordinary DTOs never expose that state. Mixed original memberships
therefore remain mixed after Undo, including alias-deduplicated batches and explicit no-ops.

New Undo requests require an unexpired, confirmed forward record with a preimage. They check
owned/current generation, original requested-to-canonical mapping, live verified sources,
all exact post-forward versions, and existence of the involved definitions. If any target
has changed, the whole Undo fails without overwriting any later decision. Account replacement,
expired/missing preimages and Undo-of-Undo are refused. An uncertain forward request must be
resolved by retrying that exact forward request before offering Undo, never by guessing its
outcome. Identity conflicts use `undo_identity_changed`; unavailable original records use
`undo_unavailable`. Other existing membership errors retain their meanings.

Undo advances each canonical entity version once, restores only the necessary set differences,
and preserves untouched membership rows. Its response uses the ordinary membership DTO plus
`originalMutationId` and `undoSupported:false`. A committed Undo has its own journal entry and
exact historical replay, even after subsequent edits or replacement; a fresh Undo request
never bypasses freshness checks. Replays do not publish notifications. Expiry clears private
preimages together with response bodies while retaining used-key tombstones. Setup/full backup
roundtrips preserve `undo_state` and `operation_kind`; omission of either column fails restore.
Real PostgreSQL tests also exercise restoring a backup and then successfully undoing its
confirmed forward change after verified cache recovery.
