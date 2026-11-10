# Superhuman native integration validation

## Scope and environment

- Starting commit: `bdeab4bc801f604c50306d1b83e16047796db101`; local branch `feat/superhuman-experience`.
- Node 22.23.4, npm 11.9.0, Linux x86_64; PostgreSQL 17.11 extracted from official Debian packages into a temporary directory.
- Disposable PostgreSQL only, bound to loopback with UTC session time zone. No production database, mailbox or provider credentials.
- The expanded implementation adds authenticated routes, owner-scoped plugin capabilities, migrations `0077`, `0078` and `0079`, and native sending/scheduling/backup integration. Dependency manifests, lockfiles and existing mail HTML sanitizers are unchanged. Repository deployment examples are reviewed as source only; no running deployment was changed.

## Executed aggregate checks

Backend, with a fresh disposable database and real migrations:

```sh
TZ=UTC MAILFLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/mailflow_test npm test -- --maxWorkers=2
```

**4,722 passed, 3 skipped**, across 286 files (285 passed, one skipped). The three skips are upstream: two obsolete Microsoft placeholder-app cases and one explicitly skipped concurrent Watch-label-copy race. No test was deleted, skipped or weakened to obtain a pass. An earlier expanded run exposed an incomplete new-route inventory in the API-token allowlist test; the inventory was updated without expanding token permissions, and both the focused 13-test suite and this final aggregate passed.

Additional backend checks passed:

- `npm run lint` with zero warnings.
- `npm run lint:plugins`.
- `node --check src/index.js`.

Frontend command `npm test -- --test-concurrency=4`: **5,020/5,020 passed**, zero failures, skips or cancellations, across 520 suites. Full frontend `npm run lint` passed with zero warnings and the production `npm run build` passed. Existing large-chunk advisories remain; no build budgets were raised.

The complete locale suite also passed independently: **2,371/2,371**, covering 11 locales, source coverage, hardcoded UI strings and placeholder parity. All new English keys have translations in every supported locale, including the 307 added in the backend-feature and final parity passes. Documented duplicate-value exceptions cover technical examples and genuinely identical words, not missing translations.

Fixture safety/API tests: **12/12 passed** with `node --test scripts/superhuman-fixture-server.test.mjs`. The optional standalone browser runner also passes `node --check scripts/superhuman-browser-smoke.mjs`.

## Feature and independent-review evidence

The final aggregates include focused regression tests for:

- Independent theme/layout opt-in, unchanged default/mobile layouts, compact rows, native category/query/count routing, keyboard highlight without opening or marking read, and native reader/Back behavior.
- Context-sensitive commands, custom shortcuts, effective account shortcuts, accessible focus/IME handling and native button activation. Hidden bulk selection cannot redirect a reader action, and delayed replies cannot cross owner/account/navigation/compose changes.
- Saved split owner/CAS persistence and SQL/compiler parity, competing preference writes, live/count-only refresh, error state and stale-request handling.
- Snippet CRUD, count/version races, searchable picker and safe TipTap/plain-text insertion preserving authored content, signature and quotation. Availability validates future dates, timezones and DST gaps/folds; canned replies only insert text.
- Local calendar owner/CAS CRUD, day/week/month date math, 12/24-hour display, all-day/multiday/overlap display, event templates, settings conflicts, bounded range/pagination, durable deletion cleanup and calendar-to-manual-availability entry.
- Private notes with current account/thread authorization, atomic note/root-link writes, reparenting/moves, merged roots, duplicate request IDs, deletion without retaining plaintext, and stale UI guards. Sender context uses exact addresses, saved contacts and bounded native account search.
- Invitation parsing from stored MIME, ownership/attendee/organizer checks, sequence/cancellation protection, native SMTP mocks, explicit confirmation and archive-after-success, concurrent duplicate claims and setup/full backup restore behavior.
- Native mute owner/CAS identity persistence, incoming alert suppression, same-account guarded Inbox archival and Muted view. Ten real PostgreSQL tests, actual sync filtering regressions, auth-chain denial checks and mounted/real-App keyboard/race tests pass. Independent backend review found no blocker; unnecessary list body-column fetching and an inaccurate recovery comment were corrected.
- Standalone snippets compose from their optional authored subject and plain-text body, preserving native From/signature. Usage records only explicit actions; real PostgreSQL concurrency tests cover deduplication and editing.
- Explicit Intro and Send + Archive use native compose and held-send behavior. The archive endpoint independently validates durable sent status, SMTP acceptance and original Inbox targets. A real TipTap capture conflict failed before its fix and passes afterward; 305 compose/frontend and 131 backend focused tests passed.
- Default-off open activity, strict public HTTPS configuration, per-message consent, bounded private storage, cookie-free public GIF responses, retention, account/owner scope and scheduled retries. Independent negative controls reproduced and fixed stale scheduled consent and pre-SMTP failure classification.
- A real-component App integration scenario through the actual App, Zustand store, API client, palette, list, reader, composer and plugin registration. It exercises core triage plus saved splits, snippets, calendar activation/event creation, notes, sender context and activity navigation against fictional local APIs. Only WebSocket delivery is stubbed.

Independent review records:

- [Persisted mail features](superhuman-expanded-review.md): four reproduced P2 issues fixed, 50 frontend and 101 backend checks, with negative controls and PostgreSQL concurrency evidence.
- [Open activity](superhuman-open-activity-review.md): two P1 and one P2 findings fixed; six independent PostgreSQL regressions pass, plus route, configuration and UI checks.
- Calendar, notes and invitations received a separate read-only review and targeted regressions, including real PostgreSQL races. The remaining note-continuity edge is documented in the private-notes README, not represented as universally solved.
- Localization includes real-i18n mounted regressions: translated split autofocus and ptBR/zhCN date formatting. Restoring the old English ARIA selector makes the autofocus negative control fail.

## Browser and visual QA

A real desktop browser route was established using the shared workspace. The fictional fixture assets and official Node binary run on the browser computer; the browser does not need access to live mail or a signed-in mail account. The earlier checkout-loopback and standalone Chromium startup obstacles no longer block this route.

The baseline/head and final delta browser passes exercised native workspace opt-in, reader/reply, search/accounts, archive/undo/snooze, snippets and dirty-discard behavior, saved searches, local calendar CRUD/views, notes and disabled-by-default activity controls. The final delta additionally passed standalone snippets with authored subject/native From/signature and usage; U/V/M and saved-search Tab behavior; mute → guarded archive → Muted view → open → unmute without moving back; Intro's To→Bcc button; reply-only Send + Archive eligibility/disclosure (no send attempt); calendar 12/24-hour display and timezone-qualified manual availability. A fictional two-message thread with reading-pane conversation threading verified P/N selection, expansion and scrolling without changing conversation.

Executed CSS viewports were 1168×735 at normal zoom, 584×367 at 200% zoom and 389×245 at 300% zoom. Narrow inbox/reader/compose had no horizontal document overflow. These are responsive-width/short-height checks, not touch devices or portrait-phone emulation. The browser's L shortcut opened the native copy/label palette, but the fictional account provided no label actions; mounted tests separately verify those actions. Intro's reserved browser shortcut was covered by the real-editor regression, while the browser pass used its explicit button. No live send/SMTP acceptance or public pixel was exercised.

Screenshots, exact scenario details and build fingerprints are supplied in the visual QA archive. The final delta index SHA-256 is `75e9df7761c0672e4e905c9fbe5cefcd39ff70da388afa58060f7a1f9506ec52`. Fixture recipient/search/resolver deficiencies found during review were corrected in the fixture, not misreported as application defects, and all twelve fixture tests pass.

Reproducible preview after `cd frontend && npm ci && npm run build`:

```sh
node scripts/superhuman-fixture-server.mjs --port 4173
```

Run from the repository root, then open `http://127.0.0.1:4173`. The server rejects sends and unsupported operations, does not forward to providers, uses fictional `.example` data, and resets memory on restart. Tests cover loopback binding, cross-origin write rejection, static path/symlink containment and isolated state. Its minimal search subset exists for visual fixtures; production grammar and SQL use the independently tested native implementation.

An optional standalone runner requires an already installed Playwright and Chromium, a fresh profile and a loopback request allowlist:

```sh
node scripts/superhuman-browser-smoke.mjs \
  --playwright /path/to/playwright/index.mjs \
  --executable /path/to/chromium \
  --before /path/to/baseline/frontend/dist \
  --after frontend/dist \
  --output /tmp/mailflow-superhuman-review
```

This particular CLI runner was syntax checked, not successfully executed end to end here. The separate managed-browser review is the executed visual evidence. Neither screenshots nor mocked SMTP establish live delivery or pixel-perfect reproduction.

## Baseline and operational limits

The pristine baseline remains in a separate detached worktree. Its frontend aggregate had one existing lock-test timing failure that passed alone; earlier backend runs had timing-sensitive image/cache failures. No production budgets or timeouts were relaxed. The final backend aggregate above supersedes those intermediate failures.

The supplied `mail-view/superhuman` reference passed its 36 tests, TypeScript and production build. Those results describe the reference, not target acceptance. Production dependency audits earlier in this work returned no high/critical findings; existing moderate advisories remain. No dependency was upgraded as part of this feature work.

No live IMAP/SMTP, invitation delivery, public HTTPS pixel, push delivery, provider calendar sync or native mobile application was exercised. Calendar is owner-local; templates are not public booking pages. See [parity checklist](superhuman-parity-checklist.md), [invitation behavior](native-invitation-responses.md), [activity privacy and deployment requirements](open-activity.md), [muted conversations](muted-conversations.md), [compose actions](native-compose-actions.md), and `backend/src/plugins/private-notes/README.md` for exact limitations. Caddy/nginx executables were not available for runtime configuration validation; nginx structure and mount-order checks passed, while infrastructure error-log privacy still requires deployment qualification.

No real mailbox was connected or mutated. No message was sent. No push, pull request, merge or deployment occurred. Changes are delivered as local commits, a patch and a verified Git bundle for review; shared mail-engine, scheduling, preferences, plugin and UI seams need conflict review before combining with concurrent Gmail work.
