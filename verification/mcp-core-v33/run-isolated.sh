#!/usr/bin/env bash
# PROPOSAL ONLY. Root configures the namespace; both Node commands run unprivileged.
set -euo pipefail
core=$(realpath "$1"); payload=$(realpath "$2"); nodebin=$(realpath "$3")
home_dir=$(realpath "$4"); logs=$(realpath "$5"); runner_uid="$6"; runner_gid="$7"
[[ "$runner_uid" =~ ^[0-9]+$ && "$runner_gid" =~ ^[0-9]+$ && "$runner_uid" != 0 && "$runner_gid" != 0 ]]
ip link set lo up
cpu_list=$(python3 -c 'import os; print(",".join(map(str, sorted(os.sched_getaffinity(0))[:2])))')
taskset -pc "$cpu_list" $$ > "$logs/cpu-affinity.log"
if ip -o link show | awk -F': ' '{ print $2 }' | grep -v '^lo$'; then exit 70; fi
common=(setpriv --reuid="$runner_uid" --regid="$runner_gid" --clear-groups --no-new-privs
  env -i "PATH=$nodebin:/usr/bin:/bin" "HOME=$home_dir" LANG=C.UTF-8 CI=true
  NODE_OPTIONS=--max-old-space-size=768 UV_THREADPOOL_SIZE=1
  MCP_CONTRACT_ISOLATED=1 "MCP_CONTRACT_EXPECTED_UID=$runner_uid"
  "MAILFLOW_MCP_SOURCE=$payload/external" "MCP_CONTRACT_RESULTS=$logs/joined-vitest.json"
  ENCRYPTION_KEY=7171717171717171717171717171717171717171717171717171717171717171
  sh -c 'test "$(id -u)" = "$MCP_CONTRACT_EXPECTED_UID" && test "$(id -u)" != 0 && exec "$@"' runner-node)
[[ ! -e "$logs/joined-vitest.json" && ! -e "$logs/external.tap" && ! -e "$logs/commands.json" ]]
external_rc=not_started; joined_rc=not_started
record_status() {
  python3 - "$logs/commands.json" "$external_rc" "$joined_rc" "$runner_uid" <<'PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]); codes=sys.argv[2:4]
def status(code, limit):
    value=int(code) if code != 'not_started' else None
    return {'exitCode':value,'attempts':int(value is not None),'deadlineSeconds':limit,
            'deadlineStatus':'not_started' if value is None else 'reached' if value==124 else 'kill_or_signal' if value>=128 else 'not_reported'}
p.write_text(json.dumps({'external':status(codes[0],60),'joined':status(codes[1],120),
                        'nodeUID':int(sys.argv[4]),'noNewPrivileges':True},indent=2)+'\n')
PY
}
trap record_status EXIT
record_status
# Each distinct command runs ONCE, including when its predecessor failed or timed out.
set +e
cd "$payload/external"
timeout --signal=TERM --kill-after=5s 60s "${common[@]}" "$nodebin/node" --test --test-reporter=tap --test-concurrency=1 test/tools.identities.test.js > "$logs/external.tap" 2>&1
external_rc=$?
record_status
cd "$core/backend"
timeout --signal=TERM --kill-after=5s 120s "${common[@]}" "$nodebin/node" node_modules/vitest/vitest.mjs run \
  --config vitest.mcpContract.config.mjs --maxWorkers=1 --no-file-parallelism > "$logs/joined-vitest.log" 2>&1
joined_rc=$?
record_status
set -e
[[ "$external_rc" == 0 && "$joined_rc" == 0 ]]
