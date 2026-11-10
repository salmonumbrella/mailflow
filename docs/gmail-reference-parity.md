# Gmail presentation: implementation and acceptance

Reference: [mail-view Gmail at 661e8abd](https://github.com/R44VC0RP/mail-view/tree/661e8abdd168992f63deb74a951f72ad00390467/gmail).

This opt-in layout preserves MailFlow accounts, mail identities, server operations, selected palette and font. It is not Gmail or a Google integration. Native layouts remain the default. Superhuman is a separate change and is not included.

## Current acceptance status

**Incomplete reference parity. Not ready for final acceptance.** Passing unit and jsdom tests are not a visual or live-provider pass. The checklist below keeps every reference surface visible; an unchecked entry is not evidence of missing native functionality, but does require individual acceptance.

Implemented adaptations include persistent global search, single-view reading, scan-line rows with checkbox/star controls, range selection, persistent mixed-state select-all and six selection presets, inline native replies, recipient paste/token handling and native contact picker, Gmail-shaped search and filter creation with account-scoped historical execution, and Klinger-style GTD sections. New settings, header/support/account/app surfaces and navigation use native operations where supported and explicitly explain unavailable Google features.

## Important native differences and unfinished work

- Native MailFlow labels support durable nesting, colors, visibility, rename/reparent, message assignment, cache-backed feeds/counts and safe label-only subtree deletion. Provider synchronization and composer/Sent handoff remain unfinished. Native label search, account-specific apply/remove actions and direct-membership rule conditions are implemented. IMAP folders remain clearly separate because deleting a folder can delete mail. Importance and colored stars still require durable message metadata.
- MailFlow categories are Primary, Newsletter, Promotion, Automated and Social. Google Forums/Updates are not silently mapped to them.
- Search supports measured RFC822 byte size with explicit unknown/partial-cache coverage. Older cached mail may remain unmeasured until a fresh FETCH; no repair worker or provider-completeness claim exists. Native label search resolves owned UUIDs, exact full paths and unique short names, with explicit ambiguity errors and unknown identity semantics. Importance and relevance ranking remain unfinished. Saved filter conversion supports exact flat conjunctions of supported search leaves, including native labels, and rejects unsupported size, grouping and OR expressions intact; supported conditions can use account-scoped native label actions. Historical execution remains an explicitly selected account's Inbox. Unknown starts are checked, not blindly replayed.
- Named account-owned signatures now support rich/plain bodies, per-sender defaults and explicit compose selection. Existing draft snapshots are preserved. Vacation responder, passcode/confidential delivery, Google Drive, mail merge, shared presence and Google account services are unavailable unless separately integrated. Notices or local reference simulations do not provide those services.
- Reader sender details and quoted-content expansion, composer More/formatting controls and persistent default fullscreen are now implemented. Authentication claims remain limited to actual stored headers, and attachment variants and several reference-only dialogs still require individual acceptance.
- GTD uses real MailFlow classification. The section feed contains at most fifty loaded thread heads; compact pages do not claim full-server pagination.
- Rules-tab HTTP callbacks now retain their original user/account/form scope. The existing all-rules WebSocket completion payload has no user/session/run identity; exact event correlation across session transitions remains a separate protocol follow-up.
- Live-browser geometry, real provider actions, keyboard-only accessibility, 390/768/1024px layouts, large fonts, forced colors and final screenshots remain unverified.

## Second implementation checkpoint

Native toolbar actions now include account-safe archive/spam/delete/move/read/star, bounded snooze, selection-aware menus, permanent-delete confirmation and Undo. Sender filters use the real message account. Reader details load safely and per-message deletion preserves conversation identity without injecting hidden replies into the list. Quoted-content expansion preserves original forwarding and print content.

Composer controls now include persistent default fullscreen, confirmed per-draft plain text, browser spellcheck, isolated printing, undo/redo, lists/quotes/indentation and remove formatting. Plain-text mode and literal signatures persist through native draft and scheduled-send paths. Edited or removed quoted text is not resurrected on mode changes or send/save. These are implemented and regression-tested surfaces, not a claim that all 203 acceptance items are complete.

## Third implementation checkpoint

Native label definitions are real account-owned PostgreSQL state, separate from destructive folders. The manager includes tree editing, foreground/background colors, independent visibility and revision-confirmed subtree deletion. Successful mutations have durable idempotent replay. Uncertain responses retain an exact recovery token across reload and middleware failures. Definitions currently report no assignment support and no counts; this is not completed label parity.

Message size now comes only from authoritative IMAP RFC822.SIZE, survives confirmed relocation, and remains NULL when unknown. Local APPEND conflicts clear potentially stale measurements. Search uses strict size comparisons, exact binary typed suffixes and decimal form units, preserves SQL unknown semantics under NOT/AND/OR, and reports scoped synchronized-cache coverage. Adding advanced criteria preserves existing Boolean grouping. Size filters are explicitly refused by saved-rule conversion rather than widened.

## Fourth implementation checkpoint

A native durable message-identity foundation now separates mailbox cache rows from account-generation-scoped entities. Binding requires actual selected UIDVALIDITY and stable provider identifiers or exact local operation evidence. MOVE/COPY/APPEND journals preserve acknowledged provider outcomes without encouraging duplicate sends or copies when cache writes fail. Ambiguous generic-provider copies and folder renames remain unresolved rather than attaching durable metadata by Message-ID. This foundation does not yet implement native label memberships, importance or colored stars.

Account edits distinguish a verified same-mailbox change from replacement. Replacement advances the storage generation and cannot silently carry pending scheduled sends or active account-specific rules to a different mailbox. Snoozes with prior or missing provenance remain held. Setup and full backups preserve the durable identity, signature and pending-job state, validate complete exported rows, and restore atomically.

The named signature library supports per-sender new-message and reply/forward defaults, explicit None, sanitized rich text, literal plain text, revision conflicts and recovery after an uncertain save. Legacy account and alias signature edits remain compatible. Compose changes preserve the user's typed body and confirm replacement of edited signature content.

Snooze records now retain durable entity identity and a claimed/recovery state. Live views and wakes require a current verified location. A wake never rebinds by Message-ID, and uncertain or acknowledged-but-unfinished work is held rather than replayed. The conversation scope uses durable entities with explicit unambiguous reply links, so unrelated deliveries with identical headers are not swept into Snoozed. Legacy unproved records remain held. Recovery/reassociation controls and automatic completion of held claims are not implemented.

Late asynchronous actions now carry the original source proof through queues, account refreshes, provider commands and local bookkeeping. This includes flags, queued retries, GTD Done, copy/move/delete/archive/spam, rules and folder actions. Bulk outcomes without exact per-message evidence remain pending rather than guessed successful or failed. Historical filter runs expose recovery pending without a blind retry. Verified destination-sync-first cache updates reconcile existing unread state without double counting.

Independent review reproduced and closed wrong-mail generation/epoch races, false post-provider failures, stale snooze scope and destination-count drift. Nonselectable folders without a verified epoch retain only generation fencing, and generic folder-rename identity continuity remains unsupported. These changes have not received visual or live-provider acceptance.

## Fifth implementation checkpoint

Native local memberships are keyed by account, storage generation and canonical message entity, never by Message-ID or a disposable cache UUID. Assignment is atomic within one account, version checked, and durably replayable after an uncertain response. Explicit no-op decisions also advance the metadata version. Deleting a label subtree removes associations, not mail, and advances affected versions across retained generations. Backups preserve membership, replay, tombstone and private Undo state.

The searchable picker stages mixed-state add/remove decisions, distinguishes unavailable identity from an empty label set, and retains exact recovery requests. Reader chip removal is a single explicit action. Server-derived Undo restores mixed prior states atomically only when every post-forward version still matches. Later decisions, deletion, replacement or expired recovery state cannot be overwritten. Create/Manage shortcuts use the existing manager without discarding pending recovery.

Label navigation is a real account/generation/label view, not a synthetic IMAP folder. Feeds deduplicate canonical entities, retain actual action locators, and provide cursor pagination. Counts are synchronized-cache counts with current unresolved and prior-generation retention disclosed separately. Visibility, colors, full paths, deep links and Back/Forward use stable label IDs. Late folder-page or account responses cannot contaminate a new label feed. Background refresh replays the loaded window, remaps reader and checkbox selection by canonical identity, and removes confirmed nonmembers. A bounded lookahead handles displaced rows. If the current location cannot be verified within that budget, the prior snapshot stays visible with an explicit reload path and mutations paused; missing from the first page is not treated as removal.

A feed row represents one durable message entity. A thread head is not claimed to represent every conversation member for assignment. Draft assignment is intentionally unavailable until draft/Sent handoff exists. Native-label endpoints remain unavailable to API tokens pending a deliberate scope design. Native-label rule conditions, compose/scheduled handoff and provider label synchronization are subsequent slices. Final browser acceptance remains outstanding.

## Native label search and rule action contracts

Native label search uses direct membership, owned stable UUIDs, exact normalized full paths or a unique short name. Ambiguous, missing and deleted references are explicit errors, including under negation. Unknown message identity remains SQL unknown under NOT/AND/OR; an ordinary true OR branch can still match. Resolution, message results, coverage and hydration share a repeatable-read snapshot. Search keeps physical cache rows while native label feeds deduplicate durable entities. Coverage reports known and unavailable identities in the synchronized cache, never provider completeness. New label predicates are unavailable to API tokens pending query-scope design; ordinary authorized full-mail reads retain their existing metadata enrichment.

Account-specific rules can apply or remove native label UUIDs alongside supported existing conditions. Save and execution require the captured account generation; delayed work retains its original source tuple, canonical entity, metadata version and exact rule revision. The label decision shares the canonical transactional writer and is completed before dependent relocation. Conflicts stop that relocation. Unknown database outcomes are reported as pending recovery with the exact request retained only in bounded process memory; this is not durable restart recovery or an automatic retry facility.

Enabled rules referencing a label block its subtree deletion. Disabled rules preserve missing UUID references visibly, but cannot be enabled or run until repaired. Renaming changes display paths, not saved references. The seventh checkpoint adds guarded native-label conditions and exact supported saved-search conversion. Historical runs remain explicitly selected Inbox runs; the real-time pipeline retains its existing unread-arrival scope. No provider label synchronization is implied.

## Seventh implementation checkpoint

Native rule conditions support direct UUID membership and nonmembership with true/false/unknown evaluation. Every reference is validated before Boolean evaluation, including missing negative references under OR. Ingestion and historical runs capture the source, canonical entity, metadata version, complete memberships and nullable search fields before asynchronous provider work. Rule revision, account generation, source and label references remain bound to that snapshot.

Conditional effects use immutable decision receipts and one-time action claims. Native label changes extend only the bounded, verified own-write chain. Category, notification, stop, flags, forwarding and relocation are guarded before dispatch; conditional flags do not fall through to an unguarded retry. Lost database acknowledgements and uncertain provider outcomes retain pending status rather than reauthorizing work. This establishes ordered local authorization, not an atomic transaction with IMAP or SMTP. An edit after a committed claim can precede remote execution. There is no automatic restart replay or user-facing reassociation workflow.

Search-to-filter conversion is server authoritative. It accepts exactly supported flat AND expressions and leaf negation, preserving quoted literals, SQL nullable semantics, collation and wildcard escaping. Real groups, OR and unsupported leaves are rejected without dropping conditions. Preview/save binds account scope, generation and label-tree revision; historical start can require the exact saved rule revision. Native condition references block deletion while enabled and remain visibly unresolved when disabled. The editor and capability notices are localized across all eleven locales.

List delete and move now share frozen target preparation across toolbar, context menu, hover, keyboard and swipe entry points. Rejected or stale thread resolution cannot substitute the representative message. Permanent deletion requires confirmation for resolved Trash/draft targets. Undo-delay, lock and unload dispatches recheck original identity, and late responses cannot restore old rows, counts or private notifications into a replacement account or user session. Ordinary navigation does not silently retarget an already prepared action.

Independent review reproduced and corrected UTF-8 outcome-size enforcement, representative fallback after account filtering, identity drift during Undo, and stale in-flight response contamination. Final integration review also corrected stale rule revisions after reorder and missing exact revisions in ordinary rule create/update responses, so same-tab edits and conversion to native conditions retain their compare-and-swap contract. Those focused regressions and the preserved backend aggregate are source-bound evidence, not browser or provider acceptance. All 203 reference acceptance entries below remain open until individually validated.

## Eighth implementation checkpoint

The Gmail gear now opens one native quick-settings drawer with density, page/fetch size, shortcut help and saved filters. Fresh mobile sessions use Sidebar Settings; repeated taps open the same drawer, and dismissal restores a visible mail-pane control without clearing the reader. Full settings and direct label management keep their existing entry points and cannot replace an active settings editor. The drawer is a 320px mail-pane sibling on desktop and a bounded fixed overlay at narrow widths; its non-modal keyboard behavior, Escape and focus restoration are explicit. Existing palettes and fonts remain authoritative. These are authored layout rules, not measured browser geometry.

Default, Comfortable and Compact are separate Gmail preferences, not switches to the similarly named native layouts. Density applies to flat, threaded and expanded message rows with content-driven minima: ordinary/compact desktop rows target 40/32px, and narrow rows target 64/56px. Default and Comfortable currently share row geometry because attachment chips remain unfinished. Controls do not claim that missing distinction is implemented. Page size keeps existing pagination and infinite-scroll semantics; the drawer calls it messages per load in infinite mode.

Density persistence uses a dedicated authenticated compare-and-swap endpoint and a server-incremented revision in existing preferences. A stale request cannot overwrite a later accepted choice, including after reload or a lost response. A user-owned local intent token survives reload and prevents obsolete pages from retrying over a newer choice. Conflict recovery is bounded; failed writes keep the local choice with an explicit Retry. Server read/write results and lock errors are applied only to the current session and intent. The generic preference queue remains unchanged.

Saved filters show actual native rule names, scope, conditions and actions. Deletion requires the exact displayed rule and scope, fences repeated submits, and reconciles a lost response by reading before offering another mutation. It does not run the rule or change existing messages. Delayed filter rows and notices cannot populate a replacement account or user session. Shortcut help opens the existing native overlay, and Escape leaves the selected reader intact.

Rules-tab toggle, create/edit, delete and Run HTTP callbacks now carry user/account-generation and operation tokens. Form dismissal/reopening cannot let an older completion erase a newer editor or release a newer operation lock. Synchronous scope invalidation covers same-event-turn session/generation round trips. Delayed folder loads use the same guard. A failed read is recoverable through a read-only retry; no failed mutation is automatically replayed. All-rules WebSocket events still lack correlation identifiers, so this change does not claim cross-session event identity.

All new quick-settings copy has translations in all eleven locales. Local render and regression evidence does not replace keyboard-only, assistive-technology, large-font, 390/768/1024px browser or live-provider acceptance. A fresh cloud browser attempt again failed before app render with a localhost connection refusal while Vite itself started normally.

## Verification

Eighth checkpoint: the frozen local frontend aggregate passed **5,365 tests**, zero failures/skips, plus lint and production build. All **1,139** frozen frontend/source dependency files and their path set remained unchanged. The frozen local PostgreSQL 17 backend aggregate passed **5,512 tests, 3 existing skips**, UTC with two workers, plus lint/plugin-boundary/syntax checks. All **589** backend files and their path set remained unchanged. Independent review reproduced the density reload/uncertain-write/cross-tab races before repair, proved the server CAS guard using a removed-guard negative control, and checked token, CSRF and screen-lock boundaries. Independent lifecycle and fresh-mobile regressions verified the final canceled-confirmation, lock-round-trip and visible-focus guards. Hosted Node22/PostgreSQL16 CI for this checkpoint remains a separate publication gate.

Seventh checkpoint: the complete local frontend aggregate passed 5,094 tests with zero failures or skips, plus lint and production build. All 1,122 frozen frontend/source dependency files were unchanged. The complete local PostgreSQL 17 backend aggregate passed 5,464 tests with 3 existing skips, using UTC and two workers. Backend lint, plugin-boundary lint and syntax checks passed, and all 586 frozen backend files were unchanged. One skipped test describes an existing concurrent Watch-copy race; the other two cover obsolete Microsoft placeholders. Independent final integration tests reproduced both revision defects before their fixes and verified exact microsecond revision preservation afterward.

Fifth checkpoint: the complete local frontend aggregate passed 4,954 tests with zero failures or skips, plus lint and production build. The complete PostgreSQL 17 backend aggregate passed 5,206 tests with 3 skips across 300 suites, using UTC and two workers. Backend lint, plugin-boundary lint and syntax checks passed. The frozen frontend and backend source manifests were unchanged after final verification. An initial backend aggregate found 22 failures in three older hand-created fixture schemas; those fixtures were updated to the real identity and membership contract without weakening assertions, then the entire database suite was rerun. An initial frontend aggregate found missing localization. All 149 native-label keys now have translations in all 11 locales, with completeness and interpolation regressions; the complete locale suite passed 2,220 tests. Eight exact language-pair exceptions document legitimate identical translations using the existing uniqueness-test policy, without disabling other pair checks.

Independent review reproduced and closed loaded-page refresh truncation, stale keyboard and reader actions, and delayed automatic-read behavior. Final independent refresh/reader/selection checks passed 26 tests. Bounded refresh retains an explicitly stale readable snapshot when it cannot verify current locations, blocks mutation paths, and resumes automatic reading only from a fresh matching entity/account/generation/cache row. Visual and live-provider acceptance remain outstanding.

Fourth checkpoint: final frontend verification passed 4,721 tests with zero failures or skips, plus lint and production build. The complete local PostgreSQL 17 backend aggregate passed 5,129 tests with 3 skips across 295 suites using UTC and two workers. Backend lint, plugin-boundary lint and syntax checks passed. Both frontend and backend source manifests were unchanged after their final runs. A first full database run found 11 failures in two older hand-created test schemas missing newly projected identity columns; the fixtures were corrected without weakening assertions and the entire database suite was rerun successfully. [Hosted CI](https://github.com/salmonumbrella/mailflow/actions/runs/42852632869) passed on exact head `01c5ed1fe5be2c555cbd5b8970f8c138ec5f97d4`: Node 22 frontend 4,721 passed with zero skips and PostgreSQL 16 backend 5,129 passed with 3 skips; lint/build/audit passed.

Third checkpoint: backend initially passed 4,382 tests with 337 environment-gated skips. An isolated local PostgreSQL 17 harness subsequently ran the complete suite: 4,716 passed and 3 skipped with two test workers and UTC, after two PostgreSQL test-fixture corrections (size column and asynchronous query mock). Frontend final two-worker run passed all 4,697 tests with zero failures or skips. Backend lint, plugin-boundary lint, syntax checks, frontend lint and production build passed. An earlier default-concurrency run had the known AccountErrors device-code timing failure (4,692/4,693); its isolated 19/19 rerun and the final complete two-worker run passed. The earlier failure is not counted as green.

Independent review found and verified fixes for uncertain-label replay-token loss and stale size after local APPEND UID reuse. Focused review runs passed 766 backend and 84 frontend checks, followed by 619 size/IMAP/parser/relocation and 40 label/settings/helper checks plus an independent retry regression. Database-dependent fixtures now execute in the local PostgreSQL harness; no remaining confirmed P1/P2 issue was found in this reviewed scope. The localization guard remains unchanged.

The second published checkpoint passed [hosted CI](https://github.com/salmonumbrella/mailflow/actions/runs/42831777421) on exact head 3798f25c3646a3a153550f2985dcf2f10fc90505: backend 4,576 passed and 3 skipped with PostgreSQL 16, frontend 4,666 passed with no skips under the default command, and lint/build/audit checks succeeded. The third published checkpoint also passed [hosted CI](https://github.com/salmonumbrella/mailflow/actions/runs/42836608832) on exact head 583ab5a73875f931b44f0e6103c00318dbc83f6d: PostgreSQL 16 backend 4,716 passed and 3 skipped; Node 22 frontend 4,697 passed with zero skips; lint/build/audit passed. These historical results do not validate the fifth checkpoint.

No dependency upgrades were made. Local runtime is Node 24.22.1 with isolated PostgreSQL 17.11; CI uses Node 22 and PostgreSQL 16. Before the clean local database aggregate, default local concurrency hit an existing CPU timing assertion and a non-UTC test-server run exposed an existing timezone assumption. Assertions were not weakened; the final aggregate uses UTC and two workers. The fork staging-base PR trigger changes no CI jobs, permissions, secrets or deployment behavior. No deployment or live account mutation was performed for testing. Browser visual/interaction verification and the requested automated Roborev execution remain unavailable in the current environment; no such pass is asserted. Size-query performance and old-cache repair remain unverified/unimplemented respectively.

## Exhaustive source-surface checklist

### Shell and header
Source: gmail/src/Header.tsx; App.tsx; shell.css; chrome-fidelity.css
Individual acceptance remains open pending final integration and browser validation.

- [ ] G001 [PENDING_ACCEPTANCE] Main-menu collapse/expand with state and accessible expanded label
- [ ] G002 [PENDING_ACCEPTANCE] Home button returns to mailbox and clears search
- [ ] G003 [PENDING_ACCEPTANCE] Persistent global search while reading, viewing contacts, or Scheduled
- [ ] G004 [PENDING_ACCEPTANCE] 64px top bar, sidebar-aligned brand, flexible search, right control cluster
- [ ] G005 [PENDING_ACCEPTANCE] Status menu: Active / Do not disturb / Away and checked state
- [ ] G006 [PENDING_ACCEPTANCE] Support menu: help, training, feedback
- [ ] G007 [PENDING_ACCEPTANCE] Google-apps menu and local app notices
- [ ] G008 [PENDING_ACCEPTANCE] Contacts panel within apps menu, back navigation and contact list
- [ ] G009 [PENDING_ACCEPTANCE] Account menu, close, account identity and local-account notice
- [ ] G010 [PENDING_ACCEPTANCE] Header popover outside-click / Escape dismissal and focus restoration

### Folder and label navigation
Source: gmail/src/Sidebar.tsx; App.tsx
Individual acceptance remains open pending final integration and browser validation.

- [ ] G011 [PENDING_ACCEPTANCE] Inbox unread count and active folder styling
- [ ] G012 [PENDING_ACCEPTANCE] Starred, Snoozed, Sent, Drafts with draft count
- [ ] G013 [PENDING_ACCEPTANCE] Expandable Categories: Social, Updates, Forums, Promotions
- [ ] G014 [PENDING_ACCEPTANCE] More/Less: Important, Scheduled, All Mail, Spam, Trash
- [ ] G015 [PENDING_ACCEPTANCE] Collapsed sidebar icons/tooltips and expanded sidebar labels
- [ ] G016 [PENDING_ACCEPTANCE] Keyboard navigation: arrows, Home, End, Enter/Space
- [ ] G017 [PENDING_ACCEPTANCE] Custom label tree, nesting, unread counts, expand/collapse
- [ ] G018 [PENDING_ACCEPTANCE] Hidden labels More/Less affordance
- [ ] G019 [PENDING_ACCEPTANCE] Create label with parent selector and duplicate/empty-name validation
- [ ] G020 [PENDING_ACCEPTANCE] Edit/rename label and change parent
- [ ] G021 [PENDING_ACCEPTANCE] Delete label plus descendants confirmation without deleting messages
- [ ] G022 [PENDING_ACCEPTANCE] Drag mail onto labels/folders
- [ ] G023 [PENDING_ACCEPTANCE] Label context menu, viewport placement, nested color submenu
- [ ] G024 [PENDING_ACCEPTANCE] Standard label foreground/background combinations
- [ ] G025 [PENDING_ACCEPTANCE] Custom foreground/background picker with keyboard grid and preview
- [ ] G026 [PENDING_ACCEPTANCE] Remove label color
- [ ] G027 [PENDING_ACCEPTANCE] Label-list visibility: show, hide, show-if-unread
- [ ] G028 [PENDING_ACCEPTANCE] Message-list label visibility: show/hide
- [ ] G029 [PENDING_ACCEPTANCE] Manage labels entry point

### Mailbox rows and selection
Source: gmail/src/MailList.tsx; mail-list.css; App.tsx
Individual acceptance remains open pending final integration and browser validation.

- [ ] G030 [PENDING_ACCEPTANCE] 40px desktop scanline, sender column, inline labels+subject+preview, right-aligned date
- [ ] G031 [PENDING_ACCEPTANCE] Density default/comfortable/compact including 32px compact rows
- [ ] G032 [PENDING_ACCEPTANCE] Read/unread emphasis with inherited MailFlow palette
- [ ] G033 [PENDING_ACCEPTANCE] Always-visible checkbox and star controls
- [ ] G034 [PENDING_ACCEPTANCE] Single selection, multi-selection and Shift-checkbox range selection
- [ ] G035 [PENDING_ACCEPTANCE] Context-click selects the targeted conversation
- [ ] G036 [PENDING_ACCEPTANCE] Grid accessibility, row labels, focused row and keyboard activation
- [ ] G037 [PENDING_ACCEPTANCE] Hover archive/delete/read-unread/snooze quick actions
- [ ] G038 [PENDING_ACCEPTANCE] Keyboard focus reveals same quick actions as hover
- [ ] G039 [PENDING_ACCEPTANCE] Thread count and draft indicators
- [ ] G040 [PENDING_ACCEPTANCE] Inline label chips and removable/colored labels
- [ ] G041 [PENDING_ACCEPTANCE] Attachment chips, attachment preview and download
- [ ] G042 [PENDING_ACCEPTANCE] Unsubscribe row affordance
- [ ] G043 [PENDING_ACCEPTANCE] Empty states specialized for search/starred/snoozed/spam/trash/drafts
- [ ] G044 [PENDING_ACCEPTANCE] Pagination, stable selection across navigation and list scroll restoration
- [ ] G045 [PENDING_ACCEPTANCE] Mailbox footer: storage, activity details, policy links (source is mock values)

### Toolbar and menus
Source: gmail/src/Toolbar.tsx; MailMenus.tsx; App.tsx
Individual acceptance remains open pending final integration and browser validation.

- [ ] G046 [PENDING_ACCEPTANCE] Persistent select-all checkbox and partial-selection state
- [ ] G047 [PENDING_ACCEPTANCE] Selection dropdown: All / None / Read / Unread / Starred / Unstarred
- [ ] G048 [PENDING_ACCEPTANCE] Refresh and More controls when nothing selected
- [ ] G049 [PENDING_ACCEPTANCE] Selection-aware Archive / Report spam / Delete
- [ ] G050 [PENDING_ACCEPTANCE] Selection-aware Mark read/unread / Snooze / Add to Tasks
- [ ] G051 [PENDING_ACCEPTANCE] Move-to dropdown with destination search and folders/categories/labels
- [ ] G052 [PENDING_ACCEPTANCE] Label-as dropdown with search, mixed states, staged add/remove and Apply
- [ ] G053 [PENDING_ACCEPTANCE] Create-new and Manage-labels from move/label menus
- [ ] G054 [PENDING_ACCEPTANCE] More menu: mark read/unread, star/unstar, important/unimportant
- [ ] G055 [PENDING_ACCEPTANCE] More menu: mute, filter messages like these, forward as attachment
- [ ] G056 [PENDING_ACCEPTANCE] Right-click: reply/reply-all/forward/forward-as-attachment
- [ ] G057 [PENDING_ACCEPTANCE] Right-click: archive/delete/read-unread/snooze/tasks/move/labels/mute
- [ ] G058 [PENDING_ACCEPTANCE] Right-click: find sender mail and open in new window
- [ ] G059 [PENDING_ACCEPTANCE] Snooze presets: later today, tomorrow, weekend, next week
- [ ] G060 [PENDING_ACCEPTANCE] Snooze custom calendar: previous/next month, date/time, future validation
- [ ] G061 [PENDING_ACCEPTANCE] Unsnooze action and return to appropriate view
- [ ] G062 [PENDING_ACCEPTANCE] Range count, Newer/Older pagination and Newest/Oldest menu
- [ ] G063 [PENDING_ACCEPTANCE] Arrow-key menu navigation, nested submenu arrow keys, Escape and focus return
- [ ] G064 [PENDING_ACCEPTANCE] Viewport clamping, scroll dismissal and outside-click dismissal
- [ ] G065 [PENDING_ACCEPTANCE] Trash permanent deletion confirmation
- [ ] G066 [PENDING_ACCEPTANCE] Undo toast restores data and closes/dismisses appropriately

### Search and filtering
Source: gmail/src/Search.tsx; NEWSearchFilters.tsx; search.ts; FilterDialog.tsx
Individual acceptance remains open pending final integration and browser validation.

- [ ] G067 [PENDING_ACCEPTANCE] Search combobox suggestions and keyboard selection
- [ ] G068 [PENDING_ACCEPTANCE] Recent search history, reuse and remove entries
- [ ] G069 [PENDING_ACCEPTANCE] Enter-to-search, clear and advanced options affordance
- [ ] G070 [PENDING_ACCEPTANCE] Advanced From / To / Subject / Has words / Does not have fields
- [ ] G071 [PENDING_ACCEPTANCE] Advanced size comparison, amount and units
- [ ] G072 [PENDING_ACCEPTANCE] Advanced date-within selector and keyboard calendar
- [ ] G073 [PENDING_ACCEPTANCE] Advanced folder/label selector and has-attachment checkbox
- [ ] G074 [PENDING_ACCEPTANCE] Query-to-fields and fields-to-query roundtrip without dropping operators
- [ ] G075 [PENDING_ACCEPTANCE] Search results Mail / Conversations / Spaces tabs
- [ ] G076 [PENDING_ACCEPTANCE] Any-time refinement: day/week/month/year
- [ ] G077 [PENDING_ACCEPTANCE] Has-attachment refinement toggle
- [ ] G078 [PENDING_ACCEPTANCE] To refinement contact autocomplete, clear/apply
- [ ] G079 [PENDING_ACCEPTANCE] Advanced-search link from search/sent/drafts refinements
- [ ] G080 [PENDING_ACCEPTANCE] Most relevant / most recent sorting menu
- [ ] G081 [PENDING_ACCEPTANCE] Sender/recipient contact banner and compose-from-address
- [ ] G082 [PENDING_ACCEPTANCE] Create filter from search, return to search criteria
- [ ] G083 [PENDING_ACCEPTANCE] Filter actions archive/read/star/label/delete/never-spam/important/not-important/category
- [ ] G084 [PENDING_ACCEPTANCE] Filter action validation and mutual exclusion for importance
- [ ] G085 [PENDING_ACCEPTANCE] Apply newly created filter to existing matching conversations
- [ ] G086 [PENDING_ACCEPTANCE] Persist, edit and delete saved filters
- [ ] G087 [PENDING_ACCEPTANCE] Filter sender directly from message/context menu
- [ ] G088 [PENDING_ACCEPTANCE] Search grammar: quoted/grouped terms, OR, negation, sender/recipient/subject
- [ ] G089 [PENDING_ACCEPTANCE] Search grammar: folders/labels/categories, read/star/important/attachment flags
- [ ] G090 [PENDING_ACCEPTANCE] Search grammar: dates/relative dates, sizes and attachment names
- [ ] G091 [PENDING_ACCEPTANCE] Disabled forwarding filter + explanatory notice (source limitation)

### Conversation reader
Source: gmail/src/MessageView.tsx; message.css; message-fidelity.css
Individual acceptance remains open pending final integration and browser validation.

- [ ] G092 [PENDING_ACCEPTANCE] Full-width conversation view with back and previous/next
- [ ] G093 [PENDING_ACCEPTANCE] Conversation subject, labels, remove Inbox, external marker
- [ ] G094 [PENDING_ACCEPTANCE] Print all and open conversation in new window
- [ ] G095 [PENDING_ACCEPTANCE] Multiple messages in chronological conversation, collapse/expand individual messages
- [ ] G096 [PENDING_ACCEPTANCE] Expand/collapse all conversations controls
- [ ] G097 [PENDING_ACCEPTANCE] Sender avatar, time and relative/full-date display
- [ ] G098 [PENDING_ACCEPTANCE] Sender details popover: From/To/Cc/Bcc/date/subject/mailed-by/signed-by/security
- [ ] G099 [PENDING_ACCEPTANCE] Per-message reply and More menu
- [ ] G100 [PENDING_ACCEPTANCE] Per-message reply-all/forward/print/delete/filter sender/show original actions
- [ ] G101 [PENDING_ACCEPTANCE] Original HTML rendering isolation and plain text formatting
- [ ] G102 [PENDING_ACCEPTANCE] Quoted content reveal/collapse
- [ ] G103 [PENDING_ACCEPTANCE] Attachment cards: preview, download, download-all, image/document/calendar variants
- [ ] G104 [PENDING_ACCEPTANCE] Attachment image/document modal close and keyboard behavior
- [ ] G105 [PENDING_ACCEPTANCE] Inline reply/reply-all/forward mode switch
- [ ] G106 [PENDING_ACCEPTANCE] Inline recipient editing plus Cc/Bcc
- [ ] G107 [PENDING_ACCEPTANCE] Inline rich-text reply body and formatting toolbar
- [ ] G108 [PENDING_ACCEPTANCE] Inline attachments/photos/links/emoji/signature/labels
- [ ] G109 [PENDING_ACCEPTANCE] Reply dock state and expand/collapse
- [ ] G110 [PENDING_ACCEPTANCE] Pop inline reply into compose window, edit subject and preserve draft
- [ ] G111 [PENDING_ACCEPTANCE] Inline reply send, schedule-send, discard and validation
- [ ] G112 [PENDING_ACCEPTANCE] Inline draft save/restore and interrupted-navigation behavior
- [ ] G113 [PENDING_ACCEPTANCE] Confidential reply controls and removal (source local simulation)
- [ ] G114 [PENDING_ACCEPTANCE] Emoji reaction affordance with explanatory unavailable state

### Composer and recipient editor
Source: gmail/src/Composer.tsx; RecipientField.tsx; RichTextEditor.tsx; composer-fidelity.css
Individual acceptance remains open pending final integration and browser validation.

- [ ] G115 [PENDING_ACCEPTANCE] Docked compose geometry, titlebar and preserve size while dragging
- [ ] G116 [PENDING_ACCEPTANCE] Minimize/restore, fullscreen toggle, default fullscreen preference
- [ ] G117 [PENDING_ACCEPTANCE] Save-and-close, discard confirmation, draft reopen
- [ ] G118 [PENDING_ACCEPTANCE] To / Cc / Bcc fields and subject
- [ ] G119 [PENDING_ACCEPTANCE] Recipient token creation on delimiters/paste/blur, validation and removal
- [ ] G120 [PENDING_ACCEPTANCE] Recipient contact autocomplete keyboard navigation and selection
- [ ] G121 [PENDING_ACCEPTANCE] Contact-picker modal, search, groups, select all, clear selection
- [ ] G122 [PENDING_ACCEPTANCE] Recipient chip popover/editing and multiple recipient behavior
- [ ] G123 [PENDING_ACCEPTANCE] Editor paragraphs, selection, keyboard commands and rich clipboard paste
- [ ] G124 [PENDING_ACCEPTANCE] Send validation for recipients/subject/body; send confirmation flows
- [ ] G125 [PENDING_ACCEPTANCE] Send keyboard shortcut and split send/schedule dropdown
- [ ] G126 [PENDING_ACCEPTANCE] Schedule presets and custom future date/time picker
- [ ] G127 [PENDING_ACCEPTANCE] File attachments, remove attachment, drag/drop and upload
- [ ] G128 [PENDING_ACCEPTANCE] Insert photo: source tabs, upload, URL, inline/attachment insertion
- [ ] G129 [PENDING_ACCEPTANCE] Drive picker: search, file-type filter, grid/list, selection, clear/insert (source mock)
- [ ] G130 [PENDING_ACCEPTANCE] Insert/edit link: anchor text, URL, validation, apply/remove
- [ ] G131 [PENDING_ACCEPTANCE] Emoji picker categories, search, recent use and keyboard behavior
- [ ] G132 [PENDING_ACCEPTANCE] Signature select/no signature, manage signatures and insertion
- [ ] G133 [PENDING_ACCEPTANCE] Composer labels menu with search and applied-state management
- [ ] G134 [PENDING_ACCEPTANCE] More: plain text, print, spell check, default fullscreen
- [ ] G135 [PENDING_ACCEPTANCE] Mail merge toggle and spreadsheet-import affordance (source local simulation)
- [ ] G136 [PENDING_ACCEPTANCE] Confidential mode: expiration, passcode choice, save/remove (source local simulation)
- [ ] G137 [PENDING_ACCEPTANCE] Layout template picker, insert layout and default styling/color (source local simulation)
- [ ] G138 [PENDING_ACCEPTANCE] Unsaved draft interruptions, repeated send protection and error/undo state

### Formatting toolbar
Source: gmail/src/FormattingToolbar.tsx; RichTextEditor.tsx; editor.css
Individual acceptance remains open pending final integration and browser validation.

- [ ] G139 [PENDING_ACCEPTANCE] Font-family menu and active font detection
- [ ] G140 [PENDING_ACCEPTANCE] Font-size menu and active size detection
- [ ] G141 [PENDING_ACCEPTANCE] Bold / Italic / Underline
- [ ] G142 [PENDING_ACCEPTANCE] Foreground and highlight color palette plus reset
- [ ] G143 [PENDING_ACCEPTANCE] Left / center / right alignment
- [ ] G144 [PENDING_ACCEPTANCE] Numbered and bulleted lists
- [ ] G145 [PENDING_ACCEPTANCE] Indent less/more and block quote
- [ ] G146 [PENDING_ACCEPTANCE] Strikethrough and remove formatting
- [ ] G147 [PENDING_ACCEPTANCE] Undo/redo availability
- [ ] G148 [PENDING_ACCEPTANCE] Overflow More formatting controls
- [ ] G149 [PENDING_ACCEPTANCE] Selection preserved while opening/using popovers
- [ ] G150 [PENDING_ACCEPTANCE] Keyboard navigation, Escape dismissal and focus restoration

### Quick settings and full settings
Source: gmail/src/App.tsx; SettingsView.tsx; settings-fidelity.css
Individual acceptance remains open pending final integration and browser validation.

- [ ] G151 [PENDING_ACCEPTANCE] Quick settings right drawer, close and See all settings
- [ ] G152 [PENDING_ACCEPTANCE] Density radio controls, selected state and persistence
- [ ] G153 [PENDING_ACCEPTANCE] Page size 10/25/50/100 and reset to first page
- [ ] G154 [PENDING_ACCEPTANCE] Keyboard-shortcut help from quick settings
- [ ] G155 [PENDING_ACCEPTANCE] Saved filters list and delete in quick settings
- [ ] G156 [PENDING_ACCEPTANCE] General / Labels / Filters and Blocked Addresses page tabs
- [ ] G157 [PENDING_ACCEPTANCE] Disabled tabs for unsupported reference areas remain honestly disabled
- [ ] G158 [PENDING_ACCEPTANCE] General: important-mail/off notification preference
- [ ] G159 [PENDING_ACCEPTANCE] General: star presets 1/4/all, drag/click in-use and unused stars
- [ ] G160 [PENDING_ACCEPTANCE] General: keyboard shortcuts on/off
- [ ] G161 [PENDING_ACCEPTANCE] General: icon/text button labels preference
- [ ] G162 [PENDING_ACCEPTANCE] General: profile picture/about-me notice
- [ ] G163 [PENDING_ACCEPTANCE] General: auto-create contacts preference
- [ ] G164 [PENDING_ACCEPTANCE] Signature manager: create/rename/delete validation
- [ ] G165 [PENDING_ACCEPTANCE] Signature rich-text editor and formatting
- [ ] G166 [PENDING_ACCEPTANCE] Default signature selection and compose integration
- [ ] G167 [PENDING_ACCEPTANCE] Personal level indicators preference
- [ ] G168 [PENDING_ACCEPTANCE] Show/hide snippets preference
- [ ] G169 [PENDING_ACCEPTANCE] Vacation responder on/off, dates, subject, plain/rich body (source local settings)
- [ ] G170 [PENDING_ACCEPTANCE] Save Changes/Cancel and dirty-state behavior
- [ ] G171 [PENDING_ACCEPTANCE] System label visibility and show-in-IMAP toggles (source local settings)
- [ ] G172 [PENDING_ACCEPTANCE] Category label-list/message-list visibility
- [ ] G173 [PENDING_ACCEPTANCE] Custom label tree/counts, visibility, edit/remove/create
- [ ] G174 [PENDING_ACCEPTANCE] Filter list with criteria/actions, edit/delete/create and back-to-mail
- [ ] G175 [PENDING_ACCEPTANCE] Setting notices and dismiss controls

### Help and feedback
Source: gmail/src/SupportView.tsx; Header.tsx; support-fidelity.css
Individual acceptance remains open pending final integration and browser validation.

- [ ] G176 [PENDING_ACCEPTANCE] Help drawer open/close/back, article list and search
- [ ] G177 [PENDING_ACCEPTANCE] Help resource/community/forum placeholder navigation
- [ ] G178 [PENDING_ACCEPTANCE] Feedback issue/idea choice
- [ ] G179 [PENDING_ACCEPTANCE] Required issue category and description validation
- [ ] G180 [PENDING_ACCEPTANCE] Review step, back navigation and form retention
- [ ] G181 [PENDING_ACCEPTANCE] Screenshot toggle with explicitly blank local preview
- [ ] G182 [PENDING_ACCEPTANCE] Email-updates choice
- [ ] G183 [PENDING_ACCEPTANCE] Local feedback save confirmation without third-party send
- [ ] G184 [PENDING_ACCEPTANCE] Legal/privacy/account-info explanatory notices
- [ ] G185 [PENDING_ACCEPTANCE] Modal focus trapping, Escape and restore previous focus

### Global state, navigation and integration
Source: gmail/src/App.tsx; mailbox.ts; search.ts; tests/browser.js
Individual acceptance remains open pending final integration and browser validation.

- [ ] G186 [PENDING_ACCEPTANCE] Persist mailbox preferences without resetting selected MailFlow color theme
- [ ] G187 [PENDING_ACCEPTANCE] Opt-in layout selection, legacy default unchanged, switch out cleanly
- [ ] G188 [PENDING_ACCEPTANCE] URL navigation, Back/Forward, direct thread/draft links
- [ ] G189 [PENDING_ACCEPTANCE] Context-sensitive keyboard shortcuts with typing/modal suppression
- [ ] G190 [PENDING_ACCEPTANCE] G then I sequence; C, /, ?, U, E, #, !, Shift-I/U, R/A/F, S, X, J/K
- [ ] G191 [PENDING_ACCEPTANCE] Next/previous navigation and focused-row scroll-into-view
- [ ] G192 [PENDING_ACCEPTANCE] Search/folder selection clears incompatible selected state
- [ ] G193 [PENDING_ACCEPTANCE] Real MailFlow account/folder/message identities instead of reference synthetic state
- [ ] G194 [PENDING_ACCEPTANCE] Real API contracts for read/star/archive/move/delete/labels/snooze/send/schedule
- [ ] G195 [PENDING_ACCEPTANCE] Loading, empty, network-error and retry behavior
- [ ] G196 [PENDING_ACCEPTANCE] Safe draft persistence and no duplicate sends
- [ ] G197 [PENDING_ACCEPTANCE] GTD Klinger sidebar coexistence, collapse/resize, states and actions
- [ ] G198 [PENDING_ACCEPTANCE] GTD deep links preserve correct mailbox message identity
- [ ] G199 [PENDING_ACCEPTANCE] GTD shortcuts/context menu and hover cleanup
- [ ] G200 [PENDING_ACCEPTANCE] Desktop widths with both sidebars open and collapsed
- [ ] G201 [PENDING_ACCEPTANCE] Mobile 390px, tablet 768/1024px, long text and large font
- [ ] G202 [PENDING_ACCEPTANCE] Reduced motion, forced colors, keyboard-only and screen reader semantics
- [ ] G203 [PENDING_ACCEPTANCE] No false success for unavailable Google services or demo-only operations

## Reference limits, not production promises

The reference is explicitly a synthetic local mailbox, not Gmail or Google backend access. Its SettingsView disables Inbox, Accounts, Forwarding/POP/IMAP, Add-ons, Chat and Meet, Advanced, Offline and Themes tabs. Filters forwarding is disabled. Feedback is saved locally, screenshots are blank demo previews, and several Drive/confidential/mail-merge/layout/template and account interactions are simulations/notices. Matching the reference requires faithful UI and honest behavior, not claiming unavailable service integration.
