# Independent review: persisted mail features

Reviewed the working tree on `feat/superhuman-experience`, starting from core commit `40c55147`. Scope: native saved Split Inbox preferences and counts, snippets, manual availability, and canned replies. All external requests in tests used mocked APIs or local disposable services and fictional data. No mail provider, real mailbox, send, push, PR, or deployment was used.

## Outcome

No P0/P1 finding was confirmed in this scope. Four P2 behaviors were reproduced, fixed, and independently rechecked. The review introduced 19 regression/security/concurrency tests. The only implementation change made by this reviewer was the coordinator-authorized count-only refresh listener in `MessageList.jsx`; the coordinator applied the other fixes.

### Resolved findings

1. **Saved split rows stayed stale while counts refreshed after newly synced mail.** A split changed from one matching message to two, its tab showed two, but its row list remained at one. `MessageList.jsx:608–615` now reruns active saved split searches on `mailflow:refresh`. Ad-hoc searches remain stable snapshots. Regression: `SavedSplits.review.render.test.js`, “an active saved split refreshes rows when its matching count refreshes.”
2. **Count-only refresh could still show a zero-result unread split with a nonmatching message.** `mailflow:counts_refresh`, emitted when pending flag counts expire, updated the tab but not its rows. `MessageList.jsx:628–635` now refreshes only an active saved split for that event and removes the listener on cleanup. Regression: “count-only refresh after flag changes refreshes an active unread split.”
3. **IME Escape discarded unsaved split edits.** The dialog's capture listener treated composition cancellation as closing the entire dialog. `SavedSplitsDialog.jsx:25–27` now ignores composition/keyCode 229 and already-consumed events. Regression: “IME Escape does not dismiss unsaved saved-split edits.”
4. **General preference hydration could replace a successful split save with an older revision.** Reads started during the write reused its epoch and could resolve before or after it. `store/savedSplits.js:26–27,53–56` now ignores hydration during saving and advances the epoch when the write settles. Both response orderings are covered by `savedSplits.review.test.js`.

### Negative controls

The four defects failed before their fixes. Additionally, temporary test-loader transforms removed the IME/epoch/live-refresh protections without editing the shared implementation: five assertions failed as expected, while the ad-hoc search preservation control passed. Removing only the new count-only event subscription also reproduced that failure. Temporary negative-control files were removed.

## Checks passed

- **50 frontend tests**, no skips: existing split, snippet, and availability tests plus 12 independent new tests.
- **101 backend tests**, including eight real PostgreSQL tests: 97 in a combined search/splits/snippets/auth-chain/allowlist run, plus four new real middleware-chain checks.
- Focused frontend lint for the changed `MessageList.jsx` and three new frontend test files; focused backend lint for both new backend test files. Zero warnings.

New test files:

- `frontend/src/components/SavedSplits.review.render.test.js`
- `frontend/src/store/savedSplits.review.test.js`
- `frontend/src/components/ComposeModal.snippets.review.render.test.js`
- `backend/src/routes/persistedMail.review.test.js`
- `backend/src/services/mailFeatures.review.postgres.test.js`

The PostgreSQL checks used a separate disposable PostgreSQL 17 directory and TCP port, leaving the coordinator's database untouched. An initial attempt to start its Unix socket was not supported by the sandbox; the supported TCP-only configuration ran successfully and was stopped afterward.

## Verified behavior

- The real API middleware chain rejects anonymous and locked reads/writes/counts, rejects browser writes without the CSRF header, and rejects new routes for a valid all-scopes API token even with a valid browser cookie present.
- Session ownership controls both preference and snippet mutations. Supplying another user's ID does not change the owner; another user cannot read these records.
- True pooled PostgreSQL concurrency preserves simultaneous snippet creates, a winning split CAS write, and an unrelated preference update. Exactly one of eight competing split writes wins. Concurrent edit/delete has one winner and cannot resurrect a deleted snippet. A deliberately failed database write rolls back and does not consume a snippet version.
- Existing PostgreSQL tests verify split count/search parity for owner/account scope, opted-out accounts, folders, negation, deleted rows, and trash exclusion. Counts remain explicitly local synced-cache counts.
- Rich insertion preserves selected text, structured list/blockquote content, independent signature and quoted mail; HTML-looking snippet text stays literal. Empty rich drafts and multiple line breaks work. Rich insertion is undoable. Plain-text cursor insertion and mobile flows remain covered by the existing tests.
- Failed save/delete and conflicts remain visible and retryable. Conflict reload is explicit and the next update uses the new version. Pending old-owner saves are discarded through an A→B→A remount.
- Snippet edit/picker Send shortcuts do not send mail; IME Escape does not close the snippet editor. Manual availability validates dates, zones and DST ambiguity and only inserts draft text. Canned replies only insert text.

## Limits

This is a focused review, not a claim that the whole repository's suites, build, or release gates passed. The coordinator owns final aggregate checks. Browser UI, real platform IME, native Android Back, and pixel/layout inspection were not run because a usable browser was unavailable. No live email delivery, synchronization, or production database was exercised.
