# Superhuman layout

Superhuman is an additional frontend layout for MailFlow, inspired by `R44VC0RP/mail-view/superhuman`. It uses MailFlow's existing mail, account, search, compose and preference APIs. It does not add a mail backend or AI triage.

## Enable it

Choose **Settings → Appearance → Layout → Superhuman**, or select it from the message list's layout control. The optional **Superhuman** color theme is a separate choice; changing the layout does not replace your selected theme. Existing layouts and the mobile mail interface remain available.

The desktop layout includes a compact navigation rail, account/folder drawer, dense message rows, native inbox-category tabs, full-width reading, a contextual command palette and keyboard hints. Recently viewed mail is session-only and is cleared when the workspace is left, locked or signed out.

## Existing native actions

Read, star, reply, reply all, forward, archive, trash, move, snooze, undo, search, account switching and settings continue to use native MailFlow behavior. The palette uses native **Archive**, rather than a separate local Done state. Unsupported reference-only workflows are not presented as working controls. The native category tabs are not a new Important/Other classifier.

Superhuman shortcuts are context-sensitive and respect user overrides. Focused controls, editors, dialogs, compositions and message windows keep ownership of their keys. Highlighting a list row does not itself open the message or mark it read. Keyboard help shows the effective bindings, including browser-safe mailbox shortcuts.

The composer remains MailFlow's native composer. A separate frontend correction preserves original and edited reply quotations when it is minimized and restored, including save and send capture. No sending, attachment-storage or draft-backend contract is changed.

## Scope

Relative to native base `bdeab4bc801f604c50306d1b83e16047796db101`, the backend, migrations, nginx example, API wrapper and plugin registration are unchanged. Existing MailFlow AI writing/settings, Gmail behavior, GTD and other native functionality are preserved.

The earlier broad draft is being replaced with this layout-only scope. New AI triage, tracking, invitation responses, muting, local calendars, private notes, snippets storage, saved-search split storage and custom sending workflows are not included. No production schema/data rollback is performed or supplied.

## Local visual preview

Build the frontend with Node 22, then run the fictional native-only fixture from the repository root:

```sh
cd frontend
npm ci
npm run build
cd ..
node scripts/superhuman-layout-fixture.mjs --port 4173
```

The fixture binds loopback, starts with fictional `.example` accounts and rejects delivery, scheduling, AI and unsupported integration requests. It is test infrastructure, not a replacement backend. Native provider delivery, live account authorization and deployment require separate qualification.
