# Optional outgoing image-load activity

Open activity is off by default and must be selected for each HTML message in the composer.
It adds a single 1×1 image only during send preparation, never to the editor or an IMAP draft.
Plain-text-only sends cannot enable it. Ordinary reopened drafts and Undo reopen with it off;
a previously opted-in scheduled message retains its visible setting when edited.
Scheduling stores the boolean, not an image. The scheduled sender adds the image at delivery,
reusing the same unpredictable token for the same account and Message-ID across retries.

This records image requests, **not human reads or per-recipient read receipts**. Mail proxies,
prefetchers, forwarded copies, and the sender's own Sent view can cause requests. Image blocking
and caching can hide requests. Counts cannot identify which recipient viewed anything.

## Host requirement

`APP_URL` must be an HTTPS origin, e.g. `https://mail.example.com`, with no credentials,
non-default port, query, fragment or path. IP literals and local/internal hostnames are refused.
The administrator must provide a publicly reachable host and TLS certificate. Validation is
syntactic; it does not resolve or contact the host. No external host or mail delivery was used
in the local tests. Changing the host later can break already-sent image URLs.

`/api/open-activity/pixel` is mounted **before** sessions, authentication, body parsers, CORS
and telemetry. Its catch-all handler does not decode path parameters, create sessions or read
cookies, IP addresses, user agents, referers, locations, devices or identities. All requests,
including unknown/expired tokens and malformed paths, receive the same transparent GIF,
200 status and non-cacheable headers. HEAD does not record. Query strings do not record.
The random 256-bit URL token contains no personal information and only grants the ability to
record a bounded image request. It never grants access to private activity.

The application handler does not log pixel requests or store network/device identifiers. This
is not an end-to-end promise about infrastructure logging. Operators must also disable or redact access/error request
logging for this path in their ingress, CDN, load balancer or other external proxy. Infrastructure
can otherwise log addresses and URLs independently of MailFlow. The shipped Caddy config does
not enable access logging, but its runtime upstream-error logs may still contain request metadata;
that error path has not been verified here. Review those logs and any external proxy logs before
enabling this feature. The example nginx config disables access/error logging for the pixel location.

## Limits and retention

Only SMTP-accepted messages record image loads. Preparation, Undo cancellation, failed sends,
and uncertain SMTP outcomes have distinct states. A crash during SMTP remains unconfirmed;
it is never presented as a confirmed send just because a token was created. Scheduled recovery
can mark acceptance confirmed from the existing durable sender state.

Updates are atomic, at most one per token per 60 seconds and 1000 counts per message. The public
handler allows at most 120 indexed database attempts per minute per process and four in flight,
with a capped 120-entry token cache. Excess requests still receive the same GIF. No visit history
or event rows accumulate. Each account has at most 10,000 unexpired tracked records.
Activity expires 30 days after SMTP acceptance (or preparation for messages never sent). Expired
URLs no longer record and expired records are excluded from private responses. Hourly cleanup
deletes up to 500 expired records per pass; subsequent sends also remove expired account records.
User/account deletion cascades to activity. Backup restore discards this transient activity and
its public tokens rather than reviving old tracking capabilities. A scheduled queue row can be purged without deleting
its sent activity. Private APIs require the authenticated owner and account scope, never return
tokens, and return no more than 50 records. Message subjects are read from existing owned mail
only for the list, not duplicated into activity records.

## Native boundary

This is core because the current plugin API cannot prepare MIME or mount unauthenticated routes
outside the session chain. The narrow seams are send validation, preparation, delivery state,
queued-message flag persistence, one owner-cascaded table, and the two routers. No plugin gets
public database access or arbitrary outgoing transforms. Existing signatures, attachments,
plaintext alternatives, aliases, Reply-To, scheduling and native Sent-copy handling remain in
the outgoing pipeline. Existing Recently viewed is the owner's reading history, kept separate.
