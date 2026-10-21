---
last_edited: 2026-10-21
---

# PR662 frozen hosted verification successor

**SOURCE PREPARATION ONLY — UNRUN and unreviewed as an assembled tree.** No local Node, dependency installation, tests, database connection, container, build, CI/GitHub write, branch/ref change, commit, hook or deployment was performed. The local resource STOP remains. Existing retry/safety workers supplied sealed inputs; no worker or reviewer was created.

This packet adapts the proven `2026-10-21-pg-remaining22` runner. Its previous Node22.23.3/Linuxx64/PG16.15 results (7933 default and385 SQL) do not verify this source. There is no new run URL or GREEN claim.

## Fixed source and provenance

- Published base commit: `123ba32ec5cd8c30f9c174201428ba9bcb06b433`; base tree `d32a97d55ff16e02f0e134ce34ef4f7ad060fa2d`.
- Effective candidate tree: `dce9459a8906352d92a577d0d9fabd7f7e3ba719`. No candidate commit was authored. The base plus12 fixed overlay files determines this tree; `source-map.json` records every whole-file input and exact shared-file fragment/preimage hash.
- Primary lock SHA256: `6543e04c27b0168917d04559d173d2e3efb5e1d955e760894600d6b80f0f1d70`; Node22.23.3, locked Vitest4.1.11, ImapFlow1.7.8, pg8.20.0. No dependency change.
- Historical pre-upgrade source: exact `6ef1a4deeb211f1817c30269350ef3fb0948785d`, tree `cfeb55655ad459ce0fc4b623ca3fbc134200f456`; its unchanged source is checked out separately for two actual historical MOVE→0079→STORE controls. It resolves the same installed dependencies through one explicitly guarded dependency symlink, without a second install.

The assembler starts at the immutable CAS proof base, applies only sealed retry-owned hunks (excluding its foreign snooze overlap), then takes exact named delete/expunge symbols fromda55, mark-all fromf6, helpers/API froma1, selected reads from0b, and stars from7a. The original bounded helper is retained, with only the root-owned export of its existing validUid predicate. No full historical manager file or moving WIP is transplanted. Original source checkouts/branches/refs remain intact. All shared fragment changes are preparation inputs, not final independent review acceptance.

The local `owners/` packets preserve raw objects, preimages, candidate/original tests, logs and seals. Publish only `publish-files.json`'s minimal allowlist; do not publish the owner packets or local paths/logs. `assemble-source.py`, `prepare-harness.py` and `seal-packet.py` are source-processing helpers for this local preparation; the hosted workflow does not run them or reconstruct source from moving refs.

## Commands and required oracles

Seven complete changed-closure files have a source-derived expected328 native cases. Discovery itself is UNRUN. Full filenames/argv/deadlines and required native case identities are in `commands.json`.

| Closure | Expected cases | Required new/strengthened oracles |
|---|---:|---|
| Address/move/epoch + actualSQL |72|Six pending R12 controls: STORE-response epoch/path drift×bothflags, stale proof cancellation×bothflags; two real pre-upgrade controls remain enabled.|
| Retry lifecycle/fakeSQL model |39|All24 previous retry failures revisited; capacity10000 and explicit20000ms deadline retained.|
| Permanent-delete real routes/protocol |110|Twelve R16 cases (zero ownEXPUNGE/external absence4; invalid recovery UID arrays8), four strengthened classification/log assertions.|
| Mark-all production service |42|Three post-lastSTORE epoch cases at1/500/501UIDs, alongside39 existing controls.|
| Mark-all route/CAS/count/hook |8|Six actualSQL controls plus route confirmation controls.|
| Star real routes/core + actualSQL |41|Four pending R13–R15 cases; all37 component cases retained.|
| CAS actualSQL + real backup/restore |16|Version/marker/ownership schedules, allocation failure and actual JSON restore→nextintent.|

There are29 required new/strengthened native identities: R12six +R16twelve +classificationfour +markallthree +starsfour. None is waived or treated as an expected pass without execution. Pending product defects may make the hosted run fail; that is evidence. The runner disables bail, retains native reports, and continues independent files after confirming process/source/SQL cleanup. Any failed, missing, skipped, pending, todo, runtime-error or timed-out assertion prevents acceptance. No unchanged7933/385 suite is repeated.

The original121=94PASS/27FAIL in793.13s is preserved. `baseline-failures.json` has all27 individual dispositions and the original log hash. Two candidate fixture models now return/check real SQL row/xmin/version/physical-identity contracts; assertion bodies, limits and explicit deadlines are unchanged. Those corrections are UNRUN hypotheses. The10000-capacity timeout remains unresolved; it is not dismissed as load or given a longer timeout. Historical address/retry/CAS general30000ms and other-file default5000ms are preserved, including explicit per-test20000ms overrides.

## Real PostgreSQL requirements

Reuse the existing managed owned-service bootstrap/cleanup with the pinned PostgreSQL16.15 image in `postgres-image.json`. It creates only two fresh disposable databases: `mailflow_flag_test_main` and `mailflow_flag_test_backup`. A nonsuperuser fixture role owns them, has connection limit2, and may create/drop its own schemas/TEMP tables/sequences. Tests need real transactions, bigint strings, timestamptz/jsonb/UUID, xmin, nextval/setval and gen_random_uuid(). Actual0079 and real writeBackup/restoreBackup stay production paths.

The allowlisted child environment supplies `MAILFLOW_TEST_DATABASE_URL`, the separate prefix-checked `MAILFLOW_FLAG_BACKUP_TEST_DATABASE_URL`, and exact `MAILFLOW_PREUPGRADE_BACKEND`. Missing environment gates cannot produce acceptance. No application/provider database, existing credentials or host data mount is used. Each main-db command audits for leftover connections, schemas and public relations. The backup fixture deliberately leaves exactly its four tables plus sequence in its separate disposable database; the adapted audit accepts only that exact inventory, then the owned tmpfs service discards both databases. The parent runner's caps, loopback publication, lease ownership, redaction, cancellation cleanup and subprocess reaping are retained.

## Root publisher handoff

Root must review the fixed overlay/fragments, failure dispositions, plan, runner diff and workflow first. Existing independent product-source review requirements remain; previous component approvals do not approve this effective tree. This packet does not publish product changes.

The existing publisher may later copy only `publish-files.json`'s allowlist under `verification/pr662-owned-probes-v1` and copy the byte-identical `workflow.yml` to `.github/workflows/mailflow-pr662-owned-probes-v1.yml`, on `verification/ci-mailflow-pr662-owned-probes-v1`. Use the normal hook and matching identity. No default-main, existing PR, upstream, branch lease or source head moves are required. This preparation did not push, open a PR, dispatch Actions or request any retry. The workflow accepts only attempt1 on that dedicated fork branch and retains sanitized reports on failure.

## Existing SEARCH ownership and exclusions

The old array-form HEADER is already owned by `vault#wprz`, not a new issue: accepted snooze11/14 at9ab replaces `findUidByMessageId` with bounded uniqueMessageUid and replaces inline snooze destination SEARCH with that finder; deletion12/14 atda55 supplies the bounded object-HEADER shared helper and guarded expunge callers. ImapFlow's installed lock is1.7.8; the manifest range `^1.0.162` is not an installed-version receipt. Available original7719/main6ef/reviewed4fdb show the old form. Aggregate76146779946849581b5b26dd35933ebd00fe847d is absent locally, so its warning remains external input rather than a locally reproduced aggregate audit.

This minimal pending-probe bundle does **not** adopt/retest the full snooze9ab lifecycle, raw-consumer successor,660 adapter, read same-value/defer followups, global migration union, provider/runtime/performance work or the aggregate7614 tree. Their accepted source and outstanding integration obligations remain tracked. In particular, unchanged base finder/wake source outside the named overlay is not claimed as the final snooze fix. A separate final series assembly must retain the accepted safety-owned9ab methods rather than copy stale retry overlaps.
