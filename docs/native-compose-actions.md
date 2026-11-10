# Native compose actions

Superhuman layout adds two explicit actions to the existing composer:

- **Instant intro:** moves current To recipients, including unfinished typed addresses, into visible Bcc. Existing Bcc wins duplicate addresses case-insensitively. Cc, body, signature, quote and sender are unchanged. Nothing is sent. The user supplies the new To recipients. Ctrl/Cmd+Shift+I works only in Superhuman compose, yields to custom bindings and ignores IME, repeats and nested dialogs.
- **Send + Archive:** sends a reply through native undo send, then archives only its captured original-account/thread INBOX IDs after confirmed SMTP acceptance. It is unavailable for new mail, forwards, scheduled edits and replies without a verifiable parent. Existing Ctrl/Cmd+Shift+Enter remains Send later.

## Safety and limitations

The original reply identity is captured when compose opens and retained through native undo restoration even if the From account changes. Before send, the original thread must still contain its referenced parent. The inbox snapshot excludes Sent, other accounts and other threads, and does not expand on a retry after a lost response. A double click starts only one preflight/send.

The archive request has an optional `afterSend` context. The backend independently reads the authenticated user's durable held-send receipt and permits only confirmed `sent` results, rejecting pending, sending, cancelled, lost, failed and unknown results. Partial recipient rejection and reported Sent-copy failure keep the inbox conversation intact. Immediately before provider actions, the backend filters requested owned rows to the original account/thread and current INBOX; moved/deleted rows and unrelated IDs are not archived.

A sent receipt confirms SMTP acceptance, not arrival in the recipient inbox or a human read.

The send is held on the server, but the post-send archive is followed by the open tab. The action tooltip explicitly asks the user to keep it open. Closing the tab or signing out can leave the reply sent with the original conversation still in the inbox. No archival happens on an uncertain send. Legacy immediate-send responses are delivered normally but report that archival was not confirmed. Archive failures and partial outcomes are surfaced persistently without retries; users are told to check the conversation and not resend the reply.

Only confirmed archived IDs are removed locally. Navigation or selection changes cannot redirect the operation, and owner changes suppress stale actions/results. No new dependency, database migration, live mailbox action, or scheduling change is required.

The compose also accepts the native calendar's `availability: { date, time, timeZone }` context, opening the existing manual availability dialog without inserting text, changing recipients or sending until the user explicitly inserts.

## Regression coverage

- `frontend/src/utils/composeActions.test.js`
- `frontend/src/components/ComposeModal.actions.render.test.js`
- `backend/src/services/sendArchive.test.js`
- `backend/src/routes/mail.sendArchive.test.js`

Existing composer, scheduled edit, draft, recipient, signature, snippet, held-send and ownership suites are also exercised. All mail/provider operations in tests are synthetic mocks; no real mail is sent or moved.
