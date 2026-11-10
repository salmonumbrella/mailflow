# Muted conversations

Muted conversations are local, owner/account-scoped MailFlow preferences. They are not a provider-specific Gmail mute command.

The reader offers Mute/Unmute and the Superhuman workspace includes a Muted view. Shift+M uses the same native action when that binding is not overridden. Muting records the preference first, then attempts to archive only the captured conversation's current Inbox copies. The archive endpoint independently checks the mute revision, original owner/account/thread and Inbox membership before any provider operation. A failed archive leaves the conversation honestly marked muted and reports the failure. Unmuting does not move mail back to the Inbox.

Incoming messages still sync and remain unread. Matching conversation notifications are suppressed, including explicitly notified mail rules. No future message is automatically archived by this feature. A database lookup failure suppresses alerts for that sync batch, while still refreshing mail; it does not replay missed alerts later. A notice that was already sent before the mute request cannot be withdrawn.

## Persistence and boundaries

Migration `0079_muted_threads.sql` stores account-owned stable RFC message identifiers, a boolean preference, revision and timestamps. It has user/account cascading foreign keys and is included in setup and full backups. It stores no bodies or recipient-activity data. Restoring a backup restores the preference as of that snapshot.

Mutable cache row IDs and subject/sender similarity are not conversation identity. Requests resolve the owner's current live thread and compare immutable Message-ID, reply and reference identifiers. CAS revisions and an account lock prevent overlapping stale mutations from silently winning; unmuting an observed merged thread clears all matching records.

Limits are explicit: 100 current cache members and 512 distinct identifiers per mutation, 5,000 preference records per account, and 100 list rows per page. Oversized/identityless conversations fail rather than falling back to subject matching. The Muted view resolves current live cache representatives and does not reveal message bodies. Permanently expunged mail with no surviving linked identifier cannot be displayed; if all known anchors disappear and a surviving thread is reparented without any of those references, continuity cannot be inferred. No universal persistence-through-arbitrary-rethreading claim is made.

## Verification

Disposable PostgreSQL tests cover ownership, same-subject nonmatching mail, account separation, absent-record races, CAS, reparenting/merges, moves, surviving replies after old cache expunge, future alert filtering, bounded lists, malformed/disabled/deleted targets, archive guards and cascade deletion. Real middleware tests enforce anonymous/locked-session/CSRF/API-token denial. Native sync tests verify that muted mail refreshes without alerts and that lookup failures fail closed. Frontend tests cover stale owner/account/message responses, captured archive targets, partial failures, pagination and actual native navigation.

No production mailbox was used to test this feature.
