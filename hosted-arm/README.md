---
last_edited: 2026-10-21
---

File-only source-v8 proposal for vault#5a6k. Runtime is NOT released. No assets, Git branches or workflows have been published from this packet.

The bundle replaces only the accepted v5 orchestrator namespace and source acceptance with exact source-v8 manifest `44f26228faf45d1c88eee5cb56c7166572bb764a478162e667a0903b2f20b4ed` and Root's source-only receipt. The only changed source payloads are bootstrap.mjs and runtime.mjs. Application76146779946849581b5b26dd35933ebd00fe847d/tree726385949110b2d1eef6168fa5765942136b955e, driver00767850, wire, package locks, all dependency bytes/modes and85 links remain pinned. Optional source-v6 is excluded.

The adapter derives from accepted digest-alias fe310cdc, whose15 image checks passed on39630956210. Only the orchestrator namespace, manifest and source-acceptance path change. Containment, redaction, image checks, resource/deadline limits, observed expiring lease and owned cleanup are preserved. The policy is false pending Root review and a separate one-run grant.

The proposed branch is verification/ci-mailflow-arm-v8, with workflow.yml copied to .github/workflows/ci-mailflow-arm-v8.yml. Publish only manifest-declared Git files plus manifest.json at hosted-arm/, excluding every external chunk. No publication is authorized by this proposal.

Fresh immutable content-addressed chunk names are intended for additions to EXISTING prerelease verification-arm-inputs-2026-10-21-v5 (ID419720320). Never create a release or overwrite old assets. The unchanged download guard checks each chunk's size/hash before daemon access. Uploads and one later automatic run require Root's separate release.

build-bundle.py reconstructs and rehashes the accepted v5 archive from its five verified chunks, without extracting it. It replaces only reviewed source metadata/code, writes deterministic gzip/tar metadata and fresh40MiB content-addressed chunks, and records the unchanged closure. It invokes no Node, npm, containers, services or tests.

The proposed profile remains small400+400 development mode, Node2CPU/6144MiB, PG1CPU/2048MiB, Redis0.25CPU/256MiB, fixture heaps512MiB, temp512MiB,1800s lease,1200000ms phase deadline and40min hosted job. This is supplemental LinuxARM evidence only, not Mini108k, full corpus, production/provider, browser or performance acceptance. Historical failures39622836700,39626915695 and39630956210 remain failures; the latest blocked predicate remains unobserved.
