# Independent open-activity review

Reviewed the opt-in tracking migration, public and authenticated routes, outgoing MIME and
delivery integration, scheduled-send state transitions, composer consent/restoration, reader
and activity panel, startup ordering, and supplied proxy configurations.

Only fictional fixtures, loopback HTTP, disposable PostgreSQL 17, and mocked SMTP/IMAP were
used. No live email, provider, public HTTPS request, dependency installation, deployment,
commit, push, or browser-policy workaround was performed.

## Findings and regression evidence

1. **P1, supplied nginx configuration invalid.** The pixel route had been inserted as active
   configuration in the commented TLS example, outside the active server block. An additional
   API location opening was also uncommented. The implementer restored the comments. The new
   structural test passes and includes negative controls for an out-of-server location and an
   unmatched opening brace. This is a structural check, not `nginx -t`; nginx is unavailable.
2. **P1, stale scheduled tokens activated without final-message consent.** After a safe 451
   refusal, changing the scheduled sender account or turning tracking off caused the final
   generic scheduled status update to mark the old unsent token `sent`. Both cases failed
   independently against real PostgreSQL. The implementer scoped acceptance to the final
   account, Message-ID, and explicit tracking flag. Final regression recheck is recorded below.
3. **P2, known-unsent database failure became uncertain delivery.** A failure in the new
   `sending` tracking-state write occurs before `transport.sendMail`. Nevertheless, the
   scheduler classified it as an uncertain SMTP outcome and retained `smtp_started_at`. The
   regression confirmed zero SMTP calls. The implementer added an internal pre-SMTP marker
   so the scheduler can safely retry. Final regression recheck is recorded below.

## Checks

- New `backend/src/services/openActivity.review.postgres.test.js`: real migration and routes,
  accepted-SMTP metadata failure plus same-key retry, pre-SMTP failure, default-off negative
  control, scheduled safe-retry classification, account switch, and final opt-out.
- New `frontend/src/openActivityConfig.review.test.js`: active nginx structural correctness
  with two negative controls, and public mount ordering before sessions/CORS/API chain and
  request telemetry.
- Existing focused route/origin tests: **7 passed**.
- Existing composer/panel/reader tests, consent utilities, and new config tests: **12 passed**.
- ESLint on the two new review test files: **passed with zero warnings**.
- Full backend/frontend suites, production build, and browser visual QA were not run by this
  reviewer. The coordinator owns aggregate verification.

## Privacy and operational limits

- Application activity rows contain no recipient, IP, user-agent, location, or device fields.
  Tokens are random and private owner APIs omit them. Owner/account scope and migration
  cascades were inspected; original persistence tests cover their execution.
- The public Express handler replies before database work, does not read headers/session,
  and bounds pending work, process token memory, per-token counts, and update frequency.
  Unknown and malformed canonical pixel-path requests use the same GIF response.
- HTTPS origin checks are syntactic. They intentionally perform no DNS or reachability probe.
- The 30-day expiry immediately stops collection and hides results, but physical deletion is
  batched at 500 rows/hour globally. A sustained installation-wide expiry rate above that can
  build a cleanup backlog unless continued sends delete the corresponding expired account
  rows. This is not a strict physical-deletion deadline.
- Caddy is unavailable here. Both supplied Caddy configurations still use generic proxy routes
  for pixels. Access logging is not enabled, but default proxy error logging can include request
  data when an upstream fails. This is an unverified runtime privacy risk, reported to the
  coordinator for dedicated route/error-log handling or explicit deployment qualification.

## Final targeted regression result

**6/6 independent PostgreSQL review tests passed after the fixes.** The account-switch,
final-opt-out, and pre-SMTP safe-retry cases were each observed failing before the fix and
passing afterward. The final run used Node 22 and a separately initialized PostgreSQL 17
cluster on loopback port 54333. The cluster was stopped afterward.

The implementer separately reported **59/59** focused backend tests passing, including the
original persistence cases and existing scheduled-send suites. That larger run is attributed
to the implementer, not to this independent review.
