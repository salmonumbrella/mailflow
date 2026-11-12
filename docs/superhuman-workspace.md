# Superhuman workspace for MailFlow

## Goal and baseline

Implement a keyboard-first Superhuman-style mail workspace as native MailFlow presentation and actions, not an embedded mock application. Development starts at upstream `bdeab4bc` on `feat/superhuman-experience`.

References:

- [mail-view/superhuman](https://github.com/R44VC0RP/mail-view/tree/main/superhuman), revision `661e8abdd168992f63deb74a951f72ad00390467`: visual and interaction reference.
- [Superlocal](https://github.com/R44VC0RP/superlocal), revision `d3725bcb963f28544a10cd2a463f1d1017c6a6b7`: source-aware mail actions, honest operation state, safe rendering and undo design reference.

The reference mock stores synthetic mail in the browser and reports sends without a provider. Its received HTML, whole-conversation snapshot undo, browser-only RSVP and account creation are not appropriate implementations for real MailFlow accounts. Local calendar and private-comment concepts are implemented with authenticated server persistence. No reference code, commercial fonts, or branding assets are imported wholesale.

## Architecture and preservation plan

MailFlow's Express routes, PostgreSQL read model, IMAP engine, SMTP sending, Zustand store, existing composers, safe body renderers and undo actions stay authoritative. This work does not add another mail provider, change authentication, or alter a running production system. New private feature storage and additive migrations are part of the local changeset; existing mail remains authoritative.

1. Add independent `superhuman` entries to the existing theme and layout registries. Preferences continue to persist through the native authenticated preferences API.
2. Add a desktop-only compact navigation rail, optional native folder sidebar, session-local recent opens, and native full-width list/reader navigation. Keep the current mobile experience.
3. Render compact, single-line conversation/message rows and native category splits using existing query, paging, selection and action handlers.
4. Extend the existing command palette and shortcut resolver with context-aware native actions and an explicit workspace setup command. Preserve custom shortcut overrides and existing layouts.
5. Test using fictional mail and an isolated loopback fixture server. Run existing frontend and backend checks, including renderer, send, scheduling, undo and ownership regression suites.
6. Persist custom splits and text snippets through narrow authenticated APIs with revision checks. Add manual availability and canned replies to the native composer without sending or replacing authored content.
7. Add opt-in local calendar and private thread-note plugins through generic navigation, reader and owner-scoped storage capabilities. Use real contact/search sources for sender context.
8. Add trusted invitation response parsing and the existing SMTP pipeline with durable duplicate protection. Add separately opted-in image-load activity with a cookie-free public endpoint and accurate uncertainty labels.

Shared files touched include the theme/layout registries, MailApp, Sidebar, MessageList, CommandPalette, readers, composer, shortcut utilities, preferences/search APIs, plugin storage, outgoing MIME and scheduling seams, invitation attachment metadata, startup routes and backup table classification. No current Gmail branch or unpublished work was included in this fresh checkout. These are integration conflict points to review before bringing the branch into concurrent Gmail work.

## Use it

Open the command palette with Cmd+K / Ctrl+K, search for **Use Superhuman workspace**, and run it. This explicitly selects both the Superhuman theme and Superhuman layout. The theme and layout remain independent in Appearance settings and in the command palette, so switching either does not silently change the other. The list options menu also lets you return to any previous layout.

In this desktop layout, J/K moves a separate highlight without opening or marking a message read. Enter opens it; Back/Escape returns to the list. E archives, H opens snooze, R replies, Shift+R replies to all, F forwards, S toggles the star, X selects, and Z undoes an available action. U toggles read, L/V opens labels/move, M focuses enabled private notes, Shift+M toggles mute, and N/P traverses messages within the open conversation. Tab/Shift+Tab cycles saved-search inbox splits only when focus is on the list background; controls retain normal focus navigation. User-configured shortcuts take priority. The keyboard-help screen and palette show the effective bindings rather than a hard-coded cheat sheet.

The narrow rail opens native folders/accounts, compose, search, settings, commands, calendar and outgoing activity. Ctrl/Cmd+1–9 opens enabled account inboxes in this layout, without requiring the drawer. Custom bindings remain authoritative. **Recently viewed** contains only messages the owner opened during the current session and clears on workspace exit, lock, or sign-out. It is distinct from outgoing image-load activity. All data and action results come from MailFlow, including errors and unavailable account states.

Use **Manage splits** above the inbox to add, edit, order or hide empty saved searches. Counts describe the synced cache, not an invented provider total. The rail also opens a standalone snippets library with optional subjects, compose-from-snippet and usage metadata. The composer has the same searchable snippets manager, reply suggestions and manual availability insertion; none sends mail. Instant intro moves current To recipients to Bcc for editing. Send + Archive is an explicit reply-only action that waits through undo-send and durable sent confirmation (SMTP acceptance), then validates and archives the original Inbox conversation. Keep the tab open until that archival finishes; ordinary Send and scheduling remain unchanged. Availability text includes the selected timezone and does not claim a free/busy lookup.

Enable **MailFlow calendar** and **Private thread notes** in Settings → Plugins. The calendar starts empty, supports day/week/month, local calendars, timed/all-day events, timezone/week-start, 12/24-hour display and reusable event templates. Its manual availability action opens a guarded draft with the selected date/timezone and does not infer free/busy. Templates do not create public booking pages. Notes are private to the account owner, not shared comments. Calendar and note writes use revision checks, preserve unsaved input on conflict and never mutate mail.

Muted conversations have their own native view and owner/account persistence. Muting suppresses matching new-mail alerts and separately attempts a guarded archive of the current Inbox conversation. Future mail still syncs without automatic moves. Unmuting never moves mail back. See [muted-conversations.md](muted-conversations.md) for identity and retention boundaries.

Supported invitations offer an explicit response confirmation naming the organizer and attendee. The native SMTP pipeline sends the response only after the user confirms; uncertain outcomes do not invite a blind retry. Alias-only, forwarded/delegated, cancelled, malformed and ambiguous invitations are rejected with a reason. Optional archive runs only after the response reaches durable success.

**Open activity** is off by default and requires a configured public HTTPS origin. The per-message checkbox opts in to a pixel that records bounded image-load timestamps, not who read the mail. Proxies, prefetching, forwarding and the owner's Sent view can cause loads; blocked images can hide them. No recipient identity, IP address, device or location is recorded. Ordinary drafts and undone sends reopen with tracking off; scheduled messages retain their visible choice. See [open-activity.md](open-activity.md) for retention and deployment requirements.

## Intended parity and explicit semantics

| Surface | Native integration |
| --- | --- |
| Graphite theme and lavender selection | MailFlow CSS theme contract; independently selectable |
| Focused full-width inbox and reader | Native list-first navigation, Back/Escape and selection |
| Compact sender/subject/snippet/date rows | Native message/thread data, account identities and paging |
| Split inbox | Native categories plus editable saved-search splits, revision-checked persistence and batched native counts |
| Compose, reply, reply-all, forward | Existing composer, authorized From identity, native drafts and attachments |
| Send later / undo send | Existing MailFlow server scheduling/hold behavior |
| Done | Native archive semantics, not Superlocal's mailbox-local Done state |
| Read, star, archive, trash, move, labels, snooze | Existing backend actions and undo paths |
| Search | Existing MailFlow search syntax and backend, not the mock's in-memory grammar |
| Commands and shortcuts | Existing action bus and applicability rules |
| Recently viewed | Session-local owner viewing history, distinct from recipient activity |
| Outgoing open activity | Explicit opt-in image-load recording, bounded/expiring, never proof of a human read |
| Snippets / quick replies / availability | Native text insertion, reusable owner snippets, manual timezone-qualified availability |
| Calendar and event templates | Opt-in owner-local calendar plugin; real server CRUD, no fictional events or public booking claim |
| Private comments | Opt-in private thread notes with ownership and concurrency checks |
| Sender context | Exact sender, saved contacts and bounded account-scoped native mail search |
| Invitation responses | Trusted stored invitation, existing SMTP pipeline, durable attempt state and uncertainty handling |
| Settings, accounts, folders | Existing authenticated MailFlow screens and APIs |
| Safe mail rendering | Existing sanitized iframe/default and optional native alternate renderer preserved |

Native accounts, notifications, unsubscribe, AI settings, signatures, attachments, drafts, undo-send and scheduled sending remain their existing implementations. The reference's private comments are not expanded into team collaboration; provider calendar sync and public booking pages are also outside its local behavior and require separate grants/product decisions. Reference-only inert settings are not copied as misleading nonfunctional controls. Native diagnostics remain the issue-reporting surface.

This is a native feature integration, not a claim of pixel-perfect reproduction. Real-browser testing uses the shared-workspace fictional preview; see the validation report for matched captures, executed keyboard/pointer flows, viewports and remaining visual/accessibility limits. Live provider delivery and calendar/push services were not exercised.

## Verification

See `superhuman-validation.md` for the executed checks, fixture-only browser evidence and limitations. A fixture test validates UI integration and request routing, not real IMAP/SMTP delivery. No live mailbox mutations, pull request, push, merge, or deployment are part of this change.
