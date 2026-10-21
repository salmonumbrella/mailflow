---
last_edited: 2026-10-21
---

Focused E10 packet for root review. Runtime remains UNRUN. No Node/import,
install, SQL, PostgreSQL, Docker, CI, GitHub write, agent or review job was run.

Accepted private source bc538c0ae6827e8c94f5b824d5d12a881a5da092, tree
85ee5f47109f0c01b8f595c32b88c3f26e24cd56. All113 inventory inputs were
rehashed read-only. The only changed pin from v20 is
backend/src/services/imapManager.draftIngest.test.js:
8c88e88043edfab2739150d9f99328ea35f4bbc82374dd52359e2cb5f0231102 ->
b5d960914c673139191ce70268bb2ac9afdcbab3a7b3132d3174590ec267b051.
No fixture or product source is copied, patched or replaced by this harness.

Only that native file runs:10 cases,6 safe writes and4 fail-closed controls,
zero duplicate units, failures, skips, pending or todo expected. Existing
transaction forwarding, rollback witness, account/folder/advisory locks,
selective residue cleanup, body/root/Bcc/identity snapshots and native timeouts
stay in the exact accepted fixture. No assertions or existing mocks are changed.
The other375 SQL targets are not selected and must not rerun here.

This directly reuses frozen fjve's managed-PG/process/credential/cleanup code;
runner.py.diff and pg-admin.mjs.diff show the narrow changes. Fresh own labels,
new separate verification branch, one mailflow_svtw DB, one fixture client,
one Vitest worker, heap512MiB, outer360s. ExactNode22.23.3/Vitest4.1.11 and
PG16.15 server160015 are checked. Immutable image and2CPU/2GiB/no extra swap/
128PIDs/no-restart caps are unchanged. Final host-TCP/db/version readiness,
source pre/post guards, redacted native reports/logs, two distinct private0600
empty npmrc files, process reaping and label/ID/image-checked cleanup remain.

The helper includes the accepted $1::text correction in CREATE ROLE format,
from root's helper1db8613c. Actual375 run39606786966 failed there with42P18
before any tests; owned cleanup completed. That failure remains unchanged and
is not test evidence. This packet does not compete with its publisher-owned
successor or change any fjve file.

Exact public mapping is still missing: source-map.json:public_sha is null.
The lead was asked for the factual mapping. Do not substitute the private SHA
or guess. The workflow refuses that null before source checkout/Node/install;
the runner also refuses before service creation. Once the existing publisher
supplies the exact mapping, root must bind that data and its updated manifest.
The full accepted tree and113 hashes still have to match the actual checkout.
No code, fixture or test-selection change is needed for the mapping.

Publish manifest.json and its listed files to verification/draft-pg-v21 on
verification/ci-mailflow-draft-pg-v21, plus workflow.yml to
.github/workflows/mailflow-draft-pg-v21.yml. Root reviews; existing publisher
owns the normal-hook commit and single push. Workflow is fork-only,
contents:read, checkout persist-credentials:false, no cache/secrets/envfiles,
with always-uploaded native JSON/logs and owned-only cleanup. No public-source
mapping or workflow trigger was performed by preparation.

Exact runtime command is in commands.json. No credentials or external PG URL
are inputs. Remaining gates: factual public mapping, root acceptance of bound
bytes, actual hosted ten-case execution and cleanup. This is first focused
verification, not a relabeled old RED or full385/migration/provider/Mini proof.
