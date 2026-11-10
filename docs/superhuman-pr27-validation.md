# Draft PR 27 follow-up validation

This record supplements [the original build validation](superhuman-validation.md). The review began at PR head `20895b5a7b58beb1ffc3eb13237e46ff710f0219` on `salmonumbrella/mailflow:feat/superhuman-experience`. Its source tree exactly matched the previously tested native Superhuman build. The PR remains a draft; no merge, deployment, Gmail-branch change, or real mailbox mutation is part of this work.

## Reproduced defects and fixes

- **Invitation revision safety:** an opened master-series cancellation or newer revision now blocks an older occurrence RSVP, including a cancellation observed during SMTP preparation. The final claim locks both occurrence and master-series state in a consistent order. Equal unchanged master requests and independently newer occurrences remain eligible. Tests cover both API behavior and real PostgreSQL concurrency.
- **Muted References continuity:** the Muted view and incoming notification filter now recognize exact RFC References anchors after cached ancestors disappear. Tests reject substring, case-folded and cross-account matches and cover bounded malformed input.
- **Hidden mail commands:** while an auxiliary view is visible, the command palette no longer exposes enabled actions against a background selected message. Mail navigation leaves the auxiliary view rather than silently changing mail behind it.
- **Foreground keyboard ownership:** background calendar, activity and muted views yield to composers, message windows, admin panels and dialogs. Escape and calendar availability shortcuts no longer close or replace a foreground compose session.
- **Fresh label/copy picker:** opening the native picker from a freshly loaded unified inbox now loads the selected account's folders instead of displaying an empty result until the folder drawer has been opened. Loading, failure/retry and stale-response handling are explicit.

Negative controls restore the original affected implementation and reproduce the corresponding regression failures. Tests use fictional state and disposable local databases, not provider mailboxes.

## Backend verification

Node 22.23.4 and PostgreSQL 17.11, UTC, disposable loopback-only database. The complete final suite passed **4,736 tests**, with **3 inherited skips**, across 285 passing test files and one skipped file. Within that aggregate, the 39 PostgreSQL files passed 350 tests with the existing concurrent Watch-copy race skipped. The other two skips are obsolete Microsoft placeholder-app cases. Source hashes and patches were unchanged across the run, and the disposable server stopped afterward.

Commands from `backend/`, after creating a disposable database:

```sh
TZ=UTC MAILFLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mailflow_test \
  npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/backend-vitest.json
npm run lint
npm run lint:plugins
node --check src/index.js
npm audit --omit=dev --audit-level=high
```

All exited zero. The production audit reports five existing moderate advisories and no high/critical findings. No dependency manifest or lockfile changed.

## Frontend verification

The final complete suite passed **5,027/5,027 tests**, with zero failures, cancellations or skips, across 520 suites. Lint, production build and the production audit passed. The audit reports two existing moderate React Router advisories and no high/critical findings. Existing large-chunk build advisories remain; no warning threshold or test timeout was relaxed.

Commands from `frontend/`, using Node 22:

```sh
npm test -- --test-concurrency=4
npm run lint
npm run build
npm audit --omit=dev --audit-level=high
```

The focused corrective suite passed 73 tests, and an independent review reran 20 focused tests successfully. Six negative-control assertions fail with the original affected UI implementation. The new native App integration uses its own small fictional folder/copy overrides and does not depend on the unpublished fixture extension. The original published fixture also passes all 12 tests:

```sh
node --test scripts/superhuman-fixture-server.test.mjs
git diff --check
```

The final frontend production `index.html` SHA-256 is `53fe74593ba83dc5a052e3a69986683e326b9eec7de2f755fd76630a97ba42c7`. Independent final code review found no actionable blocker. This does not replace the separate runtime/provider limitations below.

## Real-browser follow-up

Managed Chromium exercised the production frontend with an isolated fictional API server and no provider credentials. The follow-up first reproduced the hidden-mail palette and uncached-folder defects against the published head, then verified the corrected production build:

- Activity, Calendar and Muted command palettes disable background-message mutations. Inbox, Search and account Inbox navigation leave the auxiliary screen.
- Fresh unified inbox → reader → L loads the ordinary Projects folder without opening the drawer. Native copy retains the original and creates the destination copy. The preceding published-head pass also verified copying both messages of a fictional conversation.
- Escape with non-editable composer-button focus no longer closes Activity or Muted behind the composer; Calendar keyboard actions leave the foreground composer and underlying week intact.
- A single fixture-only folder lookup failure shows an error. Tab visibly focuses Retry; native Enter activates it without a pointer click, loads Projects and returns focus to command search. The fixture failure override was then removed.

The preceding published-head pass also covered calendar-template validation/create/edit/cancel/delete, snippet validation and literal HTML-looking text, From/signature preservation, invalid availability timezones, duplicate split names and narrow inbox/reader/compose flows. Evidence distinguishes that earlier build from the final corrective build. The ordinary-folder fixture extension is local-only and is explicitly distinguished from application code. No live message or delivery was attempted.

## Publication and hosted CI boundary

The existing CI workflow only selects pull requests targeting `main`, while this draft targets `staging/upstream-bdeab4b`. Therefore an absence of hosted checks is not a CI pass.

A separate local infrastructure commit added that staging target and extended the fictional copy fixture. Attempting to publish those four files through GitHub MCP returned `403 insufficient_scope: Additional scopes required: workflow`, with an uncertain write outcome. The observed PR head stayed unchanged. That write was not automatically retried or routed through alternate credentials. This source-only corrective update excludes all four files from that attempted write. Hosted CI configuration remains a separate permission blocker.

## Unchanged limits

No live IMAP, SMTP, invitation delivery, public tracking pixel or provider calendar sync was exercised. SMTP and invitation tests use mocks plus durable state in disposable PostgreSQL. Local calendar and manual availability are not provider synchronization or public booking pages. Narrow-width checks use the existing mobile mail fallback; auxiliary desktop rail destinations are not claimed to be available in that compact navigation. The original delivery and deployment qualifications continue to apply.
