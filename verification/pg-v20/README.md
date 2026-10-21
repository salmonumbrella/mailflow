---
last_edited: 2026-10-21
---

Prepared for root review only. No Node, dependency installation, PostgreSQL,
Docker, SQL fixture, test, CI execution, GitHub write or review job was run.

The publishable files are listed in manifest.json. Copy those exact bytes into
`verification/pg-v20/` on a new isolated `verification/ci-mailflow-pg-v20`
branch; also copy workflow.yml to `.github/workflows/mailflow-pg-v20.yml`.
Existing publisher owns the normal-hook commit/push after root reviews this
packet. No source branch or default branch moves. The workflow triggers only
that branch/path; the existing default CI remains filtered to main/PRs. No
manual dispatch, retries, other targets or upstream writes are included.

Source is exactly76146779946849581b5b26dd35933ebd00fe847d, tree
726385949110b2d1eef6168fa5765942136b955e. Root reports default CI39595624254
7933PASS; that is not SQL proof. The original pyws summary0e371c85 remains
unchanged. Preparation rehashed all113 v20 inventory files from its immutable
export; no Git object was fetched or repository modified. Runtime checks the
actual source checkout's HEAD/tree/clean state and all113 hashes, including
package.json/lock, before/after installation and every selected file.

The executable entrypoint is:

```sh
python3 verification/pg-v20/runner.py --source source --out pg-results --execute
```

The workflow supplies two checkouts: reviewed workflow/harness commit and
hardcoded tested source. It grants contents:read, disables persisted checkout
credentials and package caching, installs exactNode22.23.3, then the runner
performs locked `npm ci`. Runtime verifies actualNode22.23.3 and Vitest4.1.11.
No new npm package or test framework is introduced.

The runner pulls the immutable official postgres16.15-bookworm digest in
postgres-image.json. This is an owned ephemeral Docker container with dynamic
127.0.0.1-only publication,2CPU/2GiB/no extra swap/128PIDs/no restart, tmpfs
PGDATA, and no host/source/credential/socket mounts. It uses a new random admin
password and new fixture password, fresh DBs `mailflow_svtw` and
`mailflow_pyws_backup`, and a non-superuser fixture role with connection limit2.
No provided endpoint, existing role, credential or envfile is accepted.

Readiness is a final host-TCP query plus actual DB name and server_version_num
160015, including connections as the fixture role to both fresh DBs. It never
uses initdb's Unix pg_isready as success. NB4's consuming Node URL carries
startup options timezoneUTC/statement_timeout6000/lock_timeout5000 and nb4-
application name. Other source assertion/hook timeouts stay unchanged.

A-D runs30 native Vitest file processes serially, heap512MiB, maxWorkers1,
no file parallelism, no cache, bail1. Source outer deadlines stay360s, with
600s only for searchIndex.postgres.test.js. The mixed field-length file runs
all5 cases:1 SQL plus4 already-covered units. Expected totals are375 SQL +4
duplicate units =379 native passes,0 failures/pending/skips/todo. E10 remains
explicitly held at this exact v20 source. Its private successor is not selected;
no optional failing-control mode is included in this packet.

Each command gets source guards, exclusive stdout/stderr/nativeJSON/execution
receipts, and before/after DB checks for leftover clients, schemas and public
relations. A failure, pending/skip, pin drift, deadline, surviving process or
incomplete cleanup stops the sequence. No retry-for-green, SQL/schema repairs,
timeout inflation, assertion weakening or dropping a case. Per-file records
and final result distinguish SQL targets from the four duplicate units.

Child environments are explicit allowlists with a fresh HOME/cache, no
inherited app/provider/GitHub/npm/PG credentials. User and global npm config
point to two DISTINCT empty task-private0600 npmrc files, never the same
/dev/null file. The prior actual mailparser install failure stays unchanged.
Connection URLs reach only
consuming Node environments, never argv or artifact metadata. Docker receives
only the newly generated password through its child environment. Streams and
nativeJSON are sanitized before artifact publication; raw nativeJSON exists
only temporarily in a private directory and is removed. The PG service has
its own unique task/run labels; cleanup verifies label, ID, name and image.
Log collection failure still attempts exact owned stop/removal. No global
prune. A workflow always-step can remove only the recorded service after
cancellation, using a lease/intent rather than discovering unrelated services.

Upload uses the pinned official [upload-artifact v7 metadata](https://github.com/actions/upload-artifact/blob/cf430e030ddbb5b0abf93d22962f4752f3646cd9/action.yml),
which exposes artifact IDs/URLs and runs on Node24 independently of the tested
Node22 process. Native JSON, sanitized logs, TCP/version checks, source
identity, per-command outcomes and cleanup remain retrievable on failure.

Remaining execution inputs: root's review of exact manifest/code/workflow,
existing publisher's separate harness commit and single branch push, and a
native Ubuntu x64 GitHub-hosted runner with public npm/Docker registry access.
There are no credentials or external DB inputs to provide. Execution has not
validated this harness. Full385 SQL, E10, full migration chain, provider/Mini,
corpus and performance gates remain open even if the selected subset passes.

Successor to first hosted run39606786966: the original attempt failed before
any test file at bootstrap SQLSTATE42P18 (format parameter type unknown).
The sole executable change explicitly casts that parameter to text. Source,
case selection, resource limits, timeouts and assertions are unchanged. The
original failure and successful owned cleanup are preserved. This successor
has not yet executed.
