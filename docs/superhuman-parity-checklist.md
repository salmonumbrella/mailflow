# Superhuman native integration checklist

Reference revisions and the starting MailFlow commit are recorded in [superhuman-workspace.md](superhuman-workspace.md). This checklist distinguishes working native behavior from reference mock data and from acceptance work that could not run here.

## Native feature coverage

| Reference experience | MailFlow implementation | Acceptance evidence |
| --- | --- | --- |
| Dark, keyboard-first full-width workspace | Independent Superhuman theme/layout, compact rail/list, full reader, native mobile fallback | Theme/layout, shell, list, command and real-App fixture tests |
| Inbox splits and counts | Native categories plus saved-search add/edit/delete/order, hide-empty and live cache counts | Native SQL/compiler parity, PostgreSQL owner/CAS, store race and mounted UI tests |
| Triage and navigation | Native read/star/archive/trash/move/labels/snooze/undo; visible-target checks; account shortcuts | Existing native regressions and independent wrong-target/stale-action tests |
| Commands and help | Existing command bus, contextual availability, effective custom shortcuts, saved-search split cycling, individual-message traversal, accessible pickers and note focus | Keyboard/IME/focus and native button activation tests |
| Search | Existing server query grammar and account scope | Native search and saved-split integration tests |
| Compose, replies, forward, attachments | Existing native editor and identity/draft/sending pipelines; To→Bcc intro and confirmed-send archive | Composer, MIME, scheduling, held-send, identity and guarded archive regressions |
| Mute / Muted | Persistent owner/account thread preferences, native captured Inbox archive and incoming alert suppression | Real PostgreSQL ownership/CAS/identity tests, sync filtering and stale-target UI guards |
| Snippets | Standalone library and compose-from-snippet, optional subject, owner-persisted plain text, usage metadata, safe collapsed-cursor insertion | Real PostgreSQL conflicts/count races, mounted TipTap/plain/mobile tests |
| Quick replies | Reply/reply-all canned suggestions inserted into the draft | Existing-content/signature/quote preservation and no-send tests |
| Availability | Manual date/time/timezone text insertion; no free/busy claim | Calendar-date, future-time and DST gap/fold tests |
| Calendar | Opt-in local day/week/month calendars, event CRUD, 12/24-hour format, all-day/multiday/overlaps and manual availability entry | Owner/CAS, date math/DST, real CRUD and mounted navigation tests |
| “Booking Pages” in the mock | Reusable local event templates, clearly labeled as templates | Create/edit/use/delete mounted tests; no public booking claim |
| Private comments | Owner-only private thread notes, not team collaboration | Owner/account, moves, reparenting, idempotency, CAS and stale UI review |
| Sender context pane | Exact sender, actual saved contact and bounded account search | Exact-address, stale-request, account isolation and native mark-read tests |
| Invitation response | Trusted stored ICS, explicit recipient confirmation, native SMTP and durable attempt state | Fictional RFC/MIME fixtures, mocked SMTP, concurrent PostgreSQL and UI sequencing tests |
| Recipient opens | Explicit per-message, default-off image-load activity; never proof of a human read | Public-route privacy/bounds, owner/account, scheduled consent and mocked SMTP tests |
| Recently viewed | Separate session-only history of the owner's opened mail | Clear on lock/logout/exit, bounded history and stale-navigation tests |
| Settings/accounts/notifications | Existing real MailFlow settings, account setup/switching and notification systems | Existing regressions; no live OAuth or push service activation |
| Issue reporting | Existing native diagnostics rather than a second mock local report database | Native diagnostics retained; no external issue submission |

Independent review reports and the final executed aggregates are recorded in [superhuman-validation.md](superhuman-validation.md). A passing fake-provider or mounted-component test is not a claim of real delivery or browser painting.

## Semantics and explicit limits

- **Done means Archive.** The change uses MailFlow's provider-backed archive behavior and native undo, not a second browser-only completion flag.
- Saved split totals describe synced messages. Search/count errors remain errors instead of becoming fabricated zero counts.
- Snippet usage records explicit insertion or compose actions, not message delivery. Optional subjects are used only for a new message; insertion into an existing draft retains its subject. Snippets are plain text. Rich insertion uses editor nodes, not HTML parsing, and does not replace the selected text, signature or quotation.
- Send + Archive waits for durable native sent confirmation (SMTP acceptance) and validates the original Inbox target. Keep the composing tab open until archival finishes; closing it can leave successfully sent mail unarchived. Unknown, partial or failed delivery never triggers automatic archive.
- [Muted conversations](muted-conversations.md) silence matching MailFlow alerts and archive only the current captured Inbox conversation. They do not invoke provider Gmail mute or automatically move future mail.
- Calendar data is local to MailFlow. It does not synchronize Google/Microsoft calendars, invite attendees, publish booking pages or claim free/busy access. Those features were not implemented by the supplied reference either.
- Calendar deletion is bounded: up to 1,000 child events per request, with durable pending cleanup and an explicit retry for larger calendars or failures. Query ranges are at most 100 days with bounded pages.
- Private notes are not shared comments. They must remain owner/account scoped and preserve deleted-note idempotency without retaining deleted text.
- RSVP supports the owning account's primary address. The schema does not establish verified aliases, so alias-only, delegated, forwarded and ambiguous invitations are rejected rather than responding as an unverified identity. Known newer versions/cancellations prevent an older response. Unopened newer mail cannot be inferred without reading/indexing that invitation.
- Tracking requires an explicitly configured public HTTPS origin and a per-message opt-in. Counts are coarse, rate-limited and retained for 30 days. Blocking, proxying, prefetching, forwarding and viewing Sent mail make human reading unknowable. Application tracking storage excludes recipient identity, IP, user agent, location and device. Deployment logs require their own privacy review.
- Reference-only inert settings are not recreated as controls that pretend to work. Existing native settings remain authoritative.

## Outstanding acceptance and external requirements

- **Real-browser fixture review passed through the shared-workspace route.** Baseline/head and final delta captures cover the documented flows. See the final validation report for executed viewports, screenshot evidence and remaining coverage limits. This is not a pixel-perfect reproduction claim.
- The portable CLI fixture browser runner was syntax checked; managed-browser testing is separate executed evidence. No native mobile application or complete assistive-technology audit is claimed.
- **No live mail was mutated or sent.** IMAP/SMTP, invitation responses, scheduling and tracking tests use disposable databases and fictional/mocked services. Production mail delivery and public HTTPS pixels require a separately authorized smoke test.
- Live notification delivery requires the deployment's configured push keys and browser permission. Provider calendar synchronization would require additional provider grants/configuration. Neither was requested or enabled during this build.
- No PR, remote push, merge or deployment is part of this work. Review additive migrations and shared mail-engine/scheduling seams before integrating with other MailFlow/Gmail work.
