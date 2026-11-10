# Native label search

`label:<UUID>`, `label:"Parent/Child"`, and a scope-unique `label:"Child"` search
local account-owned labels. Names and every path component use the definitions'
NFC, trim, locale-independent Unicode lowercase, NFC normalization. Paths are exact,
not suffixes. A UUID is the stable reference through rename or reparenting.

The selected enabled account, or the user's unified participating accounts, bounds
resolution. Missing, foreign, disabled, deleted and out-of-scope references all return
400 `label_not_found`. Ambiguous references return 400 `ambiguous_label` with only
owned candidate IDs, accounts and full paths. This intentionally differs from the
prototype's empty-result handling: an invalid negative branch cannot become a match
for all mail. No invalid branch is dropped, including within NOT or OR. A bounded
resolver refuses more than 200 accounts or 500 definitions per account rather than
silently resolving a truncated set.

A label predicate matches **direct membership**, not descendant labels. Identity is
known only with an exact current-generation cache row, present entity location, current
folder UIDVALIDITY, and canonical entity. A flattened alias reads its canonical
entity's membership. Unavailable identity yields SQL NULL, including under negation.
AND, OR, nested NOT and size predicates preserve SQL three-valued logic. Ordinary
text subexpressions are normalized to false when combined with unknown metadata.
Verified rows from other selected accounts are nonmembers, so a unified `-label:`
query may include them. Ownership and deletion guards stay outside the expression.

Definition resolution, current account selection, query results, coverage and native
message hydration use one REPEATABLE READ read-only transaction. This is a consistent
snapshot for **one response**, not a provider synchronization claim or a pagination
snapshot retained across requests. Search retains physical cache rows and existing
folder/trash behavior; the dedicated label feed instead deduplicates canonical entities
and excludes Spam/Trash by default.

Responses with label criteria include `labelIndex` independently from `sizeIndex`:

- `state`: `partial` or `complete-for-cache`.
- `scope`: `selected-folder-synchronized-cache` or `selected-accounts-synchronized-cache`.
- `total`, `known`, `unavailable`: physical nondeleted cache-row counts in that scope,
  with the existing search trash policy, outside the matching Boolean expression.
- `providerComplete:false`, `directMembershipOnly:true`.
- `accounts`: accountId, storageGeneration and decimal-string treeRevision.
- `resolvedReferences`: original normalized value, labelId, accountId,
  storageGeneration, treeRevision and current path.

Coverage is present for empty matches and later pages. An empty cache can be
complete-for-cache and still says nothing about all provider mail.

## API-token boundary

The existing Read token scope continues to receive ordinary authorized mail search
and its existing native message metadata enrichment. The new definition-resolution
criteria are session-only: any parsed `label:` leaf, including negation and nested
OR, returns 403 `native_label_scope_required` before definition resolution. It returns
no candidate or coverage data. Dedicated native-label endpoints remain closed to API
tokens. Enabling those criteria/endpoints needs a deliberate token scope contract;
this slice does not change the token allowlist or remove existing mail enrichment.

## Verification and limits

`routes/search.labels.postgres.test.js` executes the actual route and migrations on a
disposable PostgreSQL database. It covers scope, ownership, unknown Boolean semantics,
NFC, full paths, direct membership, aliases, epochs, generations, physical-row/feed
differences, rename/delete, parameters, concurrent deletion snapshots, empty/later-page
coverage and token scope. Existing size and stopword PostgreSQL regressions are retained.
Browser and live-provider acceptance remain separate. Native-label saved-rule conditions
and exact search-to-rule conversion are not enabled by this search implementation.
