# Native signature library

MailFlow's named signatures are local account-owned settings, not Gmail provider settings.
Migration `0080_signature_library.sql` adds `mail_signature_state`, `mail_signatures`, and
`mail_signature_defaults`. All three belong in setup and full backups. They reference accounts,
aliases, and each other, never disposable message cache rows. Same-account signature foreign keys
are deferred so restore batches do not depend on signature/default row order.

## Storage and editing

- `GET /api/signatures/:accountId` loads the owned library, importing legacy account and alias
  signatures once under the account lock. Repeated reads keep stable IDs and do not import duplicates.
- `PUT /api/signatures/:accountId` saves the complete library with its expected revision. The server
  validates ownership, sender membership, unique normalized names, formats, and all default targets
  before writing. The transaction updates records/defaults, removes omitted records, mirrors legacy
  values, and advances the revision together.
- A record has a UUID, name, content, and `isPlainText`. Rich content is sanitized server-side;
  literal content is retained as text and escaped when inserted into a rich message or mirrored into
  a legacy HTML column. Limits are 100 records, 80-character names, 500,000 characters per record,
  and 2,000,000 content characters per library.
- Defaults are independent for each configured sender and for new versus reply/forward messages.
  An explicit No signature remains empty. Deleting a record clears its selected defaults in the
  settings draft; Save Changes applies the deletion. Cancel makes no library write.
- A stale revision returns HTTP 409. If a save response is lost, retrying its old revision cannot
  repeat the mutation. Reload signatures reads the committed result; it asks before discarding
  unsaved local edits. Reads and acknowledged saves reconcile the exact legacy projection into
  frontend account state so unrelated account edits cannot restore stale content.

## Legacy compatibility

Legacy account and alias signature writes call the library service inside their database
transaction. Before the library is initialized these hooks do nothing. Afterwards the existing
single-signature controls update the relevant sender's library defaults. Null aliases still
inherit account edits and clears. Editing one sender through a legacy control forks a shared
record when necessary to preserve other explicit senders. Editing a named record in the library
intentionally affects future messages using that record across the account.

Library saves mirror new-message defaults into legacy signature columns. Explicit None clears
that sender's fallback; deleted records cannot return through legacy state. The legacy account-wide
on/off switch remains account-wide. A library None clears the retained legacy fallback, whereas
turning a signature off with the legacy switch retains its record for an explicit re-enable.

## Composer snapshots

The composer copies content from the selected sender's defaults once, then keeps its own snapshot.
Refreshing, editing, or deleting a library record never changes an open message or a reopened draft.
Signature changes affect only the separate signature block; the typed message body is untouched.
Replacing an edited signature or changing its sender asks first. A default-dependent send/save waits
for library loading rather than sending a stale fallback. A late response cannot cross account
boundaries or replace a signature the user has already edited.

Draft/send/scheduled-message payloads continue using the existing content snapshot and plaintext
format handling, not a live library ID. Explicit literal draft signatures retain their original
characters and line breaks. Rich settings editing is disabled during a pending Save Changes.

## Focused verification

Backend tests:
- `src/services/signatureLibrary.postgres.test.js` (requires a disposable
  `MAILFLOW_TEST_DATABASE_URL`)
- `src/routes/signatures.test.js`, `accounts.signature.test.js`, `accounts.aliases.test.js`
- Existing ownership, API-token, draft, outgoing-mail, and scheduled-message tests

Frontend tests:
- `src/components/ComposeModal.signatureToggle.test.js`
- `src/components/GmailSettings.render.test.js`
- Existing compose reply-draft, image-proxy, more-menu, draft-signature, and scheduled-view tests
