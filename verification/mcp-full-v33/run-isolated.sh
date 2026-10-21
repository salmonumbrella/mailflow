#!/usr/bin/env bash
# PROPOSED dedicated-host execution only. Never run on the shared host.
set -euo pipefail
payload=$(realpath "$1"); nodebin=$(realpath "$2")
home_dir=$(realpath "$3"); logs=$(realpath "$4"); runner_uid="$5"; runner_gid="$6"
[[ "$runner_uid" =~ ^[0-9]+$ && "$runner_gid" =~ ^[0-9]+$ && "$runner_uid" != 0 && "$runner_gid" != 0 ]]
[[ "$payload" == */verification/mcp-full-v33 && "$home_dir" == */mcp-full-v33-home && "$logs" == */mcp-full-v33-logs ]]
[[ ! -e "$logs/external-full.tap" && ! -e "$logs/commands.json" && ! -e "$logs/privileges.json" && ! -e "$logs/namespace.json" ]]
ip link set lo up
ip -o link show > "$logs/interfaces.log"
if awk -F': ' '{ print $2 }' "$logs/interfaces.log" | grep -v '^lo$'; then exit 70; fi
cpu_list=$(python3 -c 'import os; print(",".join(map(str, sorted(os.sched_getaffinity(0))[:2])))')
taskset -pc "$cpu_list" $$ > "$logs/cpu-affinity.log"
common=(setpriv --reuid="$runner_uid" --regid="$runner_gid" --clear-groups --no-new-privs
  env -i "PATH=$nodebin:/usr/bin:/bin" "HOME=$home_dir" LANG=C.UTF-8 CI=true
  NODE_OPTIONS=--max-old-space-size=768 UV_THREADPOOL_SIZE=1
  npm_config_fetch_retries=0 npm_config_update_notifier=false
  "MCP_FULL_EXPECTED_UID=$runner_uid"
  sh -c 'test "$(id -u)" = "$MCP_FULL_EXPECTED_UID" && test "$(id -u)" != 0 && test "$(awk '\''/^NoNewPrivs:/ {print $2}'\'' /proc/self/status)" = 1 || exit 71
    printf "{\"uid\":%s,\"gid\":%s,\"noNewPrivileges\":true}\n" "$(id -u)" "$(id -g)" > "$1"
    shift; exec "$@"' runner-node "$logs/privileges.json")
full_rc=not_started
record_status() {
  python3 - "$logs/commands.json" "$full_rc" <<'PY'
from pathlib import Path
import json,sys
value=None if sys.argv[2]=='not_started' else int(sys.argv[2])
Path(sys.argv[1]).write_text(json.dumps({'externalFull':{'argv':['npm','test','--','--test-reporter=tap','--test-concurrency=1'],
 'exitCode':value,'attempts':int(value is not None),'deadlineSeconds':240,
 'deadlineStatus':'not_started' if value is None else 'reached' if value==124 else 'kill_or_signal' if value>=128 else 'not_reported'}},indent=2)+'\n')
PY
}
trap record_status EXIT
record_status
cd "$payload/external"
# Exactly once, unfiltered existing package script; no focused/joined rerun.
set +e
timeout --signal=TERM --kill-after=5s 240s "${common[@]}" "$nodebin/npm" test -- --test-reporter=tap --test-concurrency=1 > "$logs/external-full.tap" 2>&1
full_rc=$?
set -e
record_status
# An isolated namespace must contain no remaining test/CLI/server process.
python3 - "$logs/namespace.json" "$$" <<'PY'
from pathlib import Path
import json,os,sys
own=os.readlink('/proc/self/ns/net'); excluded={os.getpid(),int(sys.argv[2])}; remaining=[]
for entry in Path('/proc').iterdir():
 if not entry.name.isdecimal() or int(entry.name) in excluded: continue
 try:
  if os.readlink(entry/'ns/net')==own: remaining.append(int(entry.name))
 except (FileNotFoundError,PermissionError,ProcessLookupError): pass
Path(sys.argv[1]).write_text(json.dumps({'namespace':own,'remainingPids':remaining,'complete':not remaining},indent=2)+'\n')
raise SystemExit(0 if not remaining else 1)
PY
[[ "$full_rc" == 0 ]]
