# Native invitation responses

The reading pane and expanded conversation messages can send Accept, Tentative or Decline replies to direct calendar invitations. Selecting a choice does not send it. The confirmation names the organizer and the owning account address; only the explicit **Send … response** action sends mail. An archive action appears only after the response is durably recorded as sent and uses the existing undoable archive action.

## Transport and trust boundary

`GET /api/mail/messages/:id/invitation` reads the owned original MIME message. `POST` to that path accepts only `response`, `revision`, `requestId`, `expectedAttemptId` and `retry`. Neither recipients nor ICS are accepted from the browser. Authentication, the normal API CSRF chain and message/account ownership apply; the route is not added to the API-token allowlist.

The server verifies the stored Message-ID against the original source, the organizer against From/Sender, the owning account address against one attendee, and that account against a visible To/Cc recipient. Aliases have no verification facility in the current account schema, so alias-only invitations, forwarded/delegated invitations, multiple calendar payloads and ambiguous structures are refused explicitly. The MIME source is limited to 2 MiB and the calendar payload to 256 KiB. A known oversized IMAP message is refused before its source is fetched; otherwise only the bound plus one byte is requested.

Replies use the existing `prepareDelivery` / `deliverAndRecord` SMTP pipeline with a `text/calendar; method=REPLY` attachment. UID, sequence, event dates, recurrence identity and required timezone data are preserved. Only the owning attendee is included in the reply. Unrelated attendees, descriptions, alarms and URLs are not forwarded. Recurrence replies with `RANGE=THISANDFUTURE` disclose that scope in the confirmation. This is an email RSVP, not an automatic import into the local calendar or a provider calendar API operation.

## Durable state

Migration `0078_invitation_response_state.sql` adds owner/account-cascaded state. Keys hash the owner, account, organizer and event identity. Values contain revision ranks, statuses, choices, opaque attempt identifiers and timestamps, not raw calendar data or recipient addresses. SQL operations are owner/account scoped. No state row expires.

Atomic compare-and-swap reservations prevent duplicate clicks and stale-tab response changes. The final SMTP claim locks the latest observed invitation sequence in the same statement. An opened newer request or cancellation blocks older responses, including one still preparing its SMTP transport. This does not discover newer calendar payloads that have not yet been opened.

SMTP acceptance is persisted before Sent-folder and metadata work. Known failures permit an explicit versioned retry. Lost/ambiguous SMTP outcomes become `uncertain` and cannot be automatically or manually resent through this panel. A stale preparation that never entered SMTP becomes a known failure; its obsolete claim cannot later enter SMTP.

Setup and full backups include this table without including sessions, API tokens, rate limits or open-tracking tokens. Restore converts pending and failed attempts, including ones only preparing at snapshot time, to `uncertain`: the original server might have continued them after the snapshot. An older snapshot cannot reconstruct responses made after that snapshot. After restoring, check Sent or the calendar before responding to invitations whose later history may be missing.

## Reader integration and limits

Inline `text/calendar` MIME parts now appear as download metadata alongside their normal HTML alternative, which remains unchanged. The panel uses this metadata or an existing calendar-only body to identify invitation messages. Older already-cached HTML invitations without calendar metadata may need their body to be fetched again.

Tests use local fixtures, fake SMTP/IMAP and disposable PostgreSQL only. Coverage includes RFC/MIME parsing, malformed and unowned identities, sequence/recurrence updates, preparation and SMTP failures, concurrent reservations and send claims, setup/full backup round trips, cascade cleanup, stale navigation, confirmation and archive ordering. No live messages are sent or moved by these tests.
