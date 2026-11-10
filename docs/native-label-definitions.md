# Native MailFlow label definitions

MailFlow labels are local, account-owned PostgreSQL data. They are separate from IMAP
folders and the legacy folder-backed GTD label API. Creating, editing, nesting, styling,
showing/hiding or deleting a native label makes no provider call and cannot delete mail.
Disabled accounts can still manage these local definitions.

This release implements definition management only. Message assignment, counts, chips,
label feeds, unread-driven sidebar display, and provider synchronization are not included.
Every response reports `assignmentSupported: false`, `counts: null`, and
`coverage: "not_indexed"`. Saving `visibility: "unread"` or `messageVisible` persists a
preference; it does not claim the corresponding message feed or display exists yet.

## API

All routes are session-authenticated, run behind the existing CSRF and screen-lock gates,
and remain unavailable to API tokens. IDs are UUIDs and revisions are decimal strings
(they must not be converted to JavaScript numbers).

- `GET /api/labels?accountId=<uuid>` returns `{labels, treeRevision, ...capabilities}`.
- `POST /api/labels` accepts `{accountId, mutationId, name}` plus optional definition fields.
- `PATCH /api/labels/:id` accepts `{accountId, mutationId, expectedRevision}` and the changed
  fields. It updates only those fields, preserving other preferences and immutable IDs.
- `POST /api/labels/:id/delete-preview` accepts `{accountId}` and returns the label,
  descendants, `deletedLabelIds`, `treeRevision`, and `removesMessages: false`.
- `DELETE /api/labels/:id` accepts `{accountId, mutationId, expectedTreeRevision,
  confirmSubtree: true}`. Obtain the revision from a fresh preview and explicitly confirm
  the named subtree. Any intervening tree change returns 409 and requires a fresh preview.

A label DTO has `id`, `accountId`, `parentId`, `name`, `path`, `color`, `textColor`,
`visibility`, `messageVisible`, `revision`, and `counts: null`.
Creation/edit responses return `{label, treeRevision, ...capabilities}`; deletion returns
`{deletedLabelIds, treeRevision, ...capabilities}`. Successful create/replay returns 201;
other successful requests return 200. Failures use `{error, code}` with 400 for validation,
404 for an inaccessible account/label/parent, or 409 for a collision or stale revision.

Definition fields:

- `name`: trim and normalize to NFC, 1–100 Unicode code points; no slash, control,
  formatting or surrogate code points. Sibling uniqueness uses NFC of Unicode lowercase,
  independent of the PostgreSQL locale. This is lowercasing, not a full Unicode case fold.
- `parentId`: an owned label in the same account, or null for a root. Cycles are rejected.
  Maximum depth is 20, maximum full path is 1,000 code points, and maximum label count is
  500 per account. Rename/reparent recomputes descendant paths atomically.
- `color`, `textColor`: six-digit hex colors (`#RRGGBB`) or null. Reset both to null to
  restore defaults. Colors are never accepted as CSS expressions.
- `visibility`: `show`, `hide`, or `unread`; `messageVisible`: boolean. They are independent.

## Concurrency and recovery

Each mutation locks and rechecks the account owner, then locks its `mail_label_state` row.
All tree changes and the committed replay response share one transaction. Each changed
label/path increments its revision; only a real tree/metadata change increments the tree
revision. An unchanged edit can still be replayed but causes no invalidation.

Use one fresh `mutationId` for a user action and reuse it unchanged after an uncertain HTTP
result. Replaying a committed request returns its original result even after newer edits or
label deletion. Reusing the ID with a different canonical request yields `mutation_conflict`.
Response bodies expire after 30 days and are cleared lazily on subsequent mutations. Small
key/hash tombstones remain, so old destructive requests cannot execute again. An expired
request returns `mutation_expired`; refresh state before submitting a new action.

After commit, the owner receives `labels_changed` with `accountId` and `treeRevision`.
Push failure cannot undo or disguise a committed change. Refetch on reconnect/focus and
on relevant invalidations rather than treating a previous replay response as fresh state.

## Backup and verification

Migration `0077_native_label_definitions` adds `mail_labels`, `mail_label_state`, and
`mail_label_mutations`. All are setup data included in both setup/full backups. The
same-account parent foreign key is deferred, so child-first batches restore safely in the
existing restore transaction. No table refers to messages or folders. Cache-only removal
cannot remove definitions or mutation history.

The existing backup version safety policy remains: an older-schema backup must be restored
on its original MailFlow version and then migrated forward. This feature does not silently
reinterpret old backup formats or bypass that guard.

Unit and HTTP tests cover input, ownership checks, CSRF, screen lock, token denial, snapshot
DTOs, path updates, atomic writes and replay behavior. `labels.postgres.test.js` runs against
CI's PostgreSQL 16 service and tests real uniqueness/FKs, cross-account scope, race outcomes,
revision precision, subtree deletion, retries/expiration and nested setup/full restore.
Guard triggers reject any message/folder write from every definition endpoint. Provider
method spies also remain untouched. Without `MAILFLOW_TEST_DATABASE_URL`, those PostgreSQL
cases are skipped, not verified.
