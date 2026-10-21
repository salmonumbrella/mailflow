#!/usr/bin/env python3
"""Hosted source binding only. Does not import product code or run tests."""
from pathlib import Path
import hashlib, json, os, subprocess, sys, re, shutil
from collections import Counter
sha256 = lambda data: hashlib.sha256(data).hexdigest()
def git(*args):
    return subprocess.check_output(['git', '-C', str(core), *args]).decode().strip()
def tree_id(files):
    root = {}
    for path, row in files.items():
        here = root
        for part in path.split('/')[:-1]: here = here.setdefault(part, {})
        here[path.split('/')[-1]] = (row['mode'], row['oid'])
    def encode(node):
        entries = []
        for name in sorted(node, key=lambda key: (key + ('/' if isinstance(node[key], dict) else '')).encode()):
            value = node[name]
            mode, oid = ('40000', encode(value)) if isinstance(value, dict) else value
            entries.append(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(oid))
        data = b''.join(entries)
        return hashlib.sha1(b'tree ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    return encode(root)
def verify(root, descriptor):
    for name, row in descriptor['files'].items():
        file = root / name
        assert file.is_file() and not file.is_symlink(), name
        data = file.read_bytes()
        assert sha256(data) == row['sha256'], name
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == row['oid'], name
        assert bool(os.stat(file).st_mode & 0o111) == (row['mode'] == '100755'), name
    assert tree_id(descriptor['files']) == descriptor['tree']

def verify_mode(core_path, payload_path, mode):
    global core, payload, pins
    core, payload = Path(core_path).resolve(), Path(payload_path).resolve()
    pins = json.loads((payload / 'pins.json').read_text())
    assert git('rev-parse', 'HEAD') == pins['core']['commit']
    assert git('rev-parse', 'HEAD^{tree}') == pins['core']['tree']
    verify(core, pins['core']); verify(payload / 'external', pins['external'])
    for name, digest in pins['harness'].items():
        assert sha256((payload / name).read_bytes()) == digest, name
    if mode == 'after':
        assert sha256((core / 'backend/src/routes/providerIdentities.mcpContract.test.js').read_bytes()) == pins['harness']['providerIdentities.mcpContract.test.js']
        assert sha256((core / 'backend/vitest.mcpContract.config.mjs').read_bytes()) == pins['harness']['vitest.mcpContract.config.mjs']
        assert git('diff', '--name-only') == ''
    else:
        assert not (core / 'backend/src/routes/providerIdentities.mcpContract.test.js').exists()
        assert not (core / 'backend/vitest.mcpContract.config.mjs').exists()
    assert not (core / '.env').exists() and not (core / 'backend/.env').exists()
    assert not (payload / 'external/.env').exists()
    print(json.dumps({'coreCommit': pins['core']['commit'], 'coreTree': pins['core']['tree'],
        'externalTree': pins['external']['tree'], 'coreFiles': len(pins['core']['files']),
        'externalFiles': len(pins['external']['files']), 'mode': mode}))

def cleanup(core_path, payload_path, home_path, logs_path):
    core, payload, home, logs = [Path(x).resolve() for x in [core_path, payload_path, home_path, logs_path]]
    assert core.name == 'core' and payload.name == 'mcp-core-v33' and home.name == 'mcp-core-v33-home'
    assert core != Path('/') and payload != Path('/') and logs.name == 'mcp-core-v33-logs'
    targets = [core / 'backend/src/routes/providerIdentities.mcpContract.test.js',
               core / 'backend/vitest.mcpContract.config.mjs', core / 'backend/node_modules',
               payload / 'external/node_modules', home]
    outcomes = []
    for target in targets:
        before = target.exists() or target.is_symlink()
        error = None
        try:
            if target.is_symlink() or target.is_file(): target.unlink()
            elif target.is_dir(): shutil.rmtree(target)
        except Exception as exc: error = str(exc)
        outcomes.append({'target': str(target), 'existed': before, 'absentAfter': not target.exists() and not target.is_symlink(), 'error': error})
    complete = all(x['absentAfter'] and x['error'] is None for x in outcomes)
    logs.mkdir(exist_ok=True)
    (logs / 'cleanup.json').write_text(json.dumps({'status': 'complete' if complete else 'incomplete',
        'ownedTargets': outcomes, 'targetCount': 5}, indent=2)+'\n')
    raise SystemExit(0 if complete else 1)

def enforce(payload_path, logs_path):
    payload, logs = Path(payload_path).resolve(), Path(logs_path).resolve()
    cases = json.loads((payload / 'cases.json').read_text())
    errors, observed = [], {}
    assert cases['expectedNativeCaseCount'] == 8 and cases['expectedJoinedCaseCount'] == 19
    def require(condition, message):
        if not condition: errors.append(message)
    try:
        commands = json.loads((logs / 'commands.json').read_text()); observed['commands'] = commands
        for name in ['external', 'joined']:
            command = commands[name]
            require(command['attempts'] == 1 and command['exitCode'] == 0, name+' command failed, missing or repeated')
            require(command['deadlineStatus'] == 'not_reported', name+' deadline/kill/incomplete')
        require(commands['nodeUID'] > 0 and commands['noNewPrivileges'] is True, 'unprivileged Node binding missing')
    except Exception as exc: errors.append('command receipt missing/invalid: '+str(exc))
    try:
        tap = (logs / 'external.tap').read_text()
        counts = {}
        for name in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
            values = re.findall(r'^# '+name+r' (\d+)\s*$', tap, re.M)
            require(len(values) == 1, 'TAP '+name+' summary absent/ambiguous')
            counts[name] = int(values[0]) if len(values) == 1 else None
        titles = re.findall(r'^# Subtest: (.*)$', tap, re.M)
        observed['external'] = {'counts': counts, 'titles': titles}
        require(counts['tests'] == 8 and counts['pass'] == 8, 'TAP must run/pass exactly8')
        require(all(counts[k] == 0 for k in ['fail','cancelled','skipped','todo']), 'TAP failed/skipped/todo/cancelled/incomplete')
        require(Counter(titles) == Counter(cases['nativeCaseIdentities']), 'TAP exact8 identities differ')
        require(len(re.findall(r'^ok \d+ - ', tap, re.M)) == 8 and not re.search(r'^not ok |^Bail out!', tap, re.M), 'TAP result lines incomplete/failed')
        require(re.findall(r'^1\.\.(\d+)\s*$', tap, re.M) == ['8'], 'TAP plan is not exactly1..8')
    except Exception as exc: errors.append('native TAP missing/invalid: '+str(exc))
    try:
        data = json.loads((logs / 'joined-vitest.json').read_text())
        files = data['testResults']; rows = [row for file in files for row in file['assertionResults']]
        titles = [row['title'] for row in rows]
        keys = ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests','numFailedTestSuites','numPendingTestSuites']
        observed['joined'] = {'counts': {key: data.get(key) for key in keys}, 'titles': titles, 'statuses': [row['status'] for row in rows]}
        require(data['success'] is True and data['numTotalTests'] == 19 and data['numPassedTests'] == 19, 'Vitest must run/pass exactly19')
        require(all(data[key] == 0 for key in keys[2:]), 'Vitest failure/pending/todo/skip/incomplete')
        require(len(files) == 1 and files[0]['name'].endswith('/src/routes/providerIdentities.mcpContract.test.js'), 'Unexpected Vitest file selection')
        require(all(file['status'] == 'passed' and not file.get('message') for file in files), 'Vitest file error')
        require(len(rows) == 19 and all(row['status'] == 'passed' and not row.get('failureMessages') for row in rows), 'Vitest case not passed or skipped/cancelled')
        require(Counter(titles) == Counter(cases['joinedCaseIdentities']), 'Vitest exact19 identities differ')
    except Exception as exc: errors.append('native Vitest JSON missing/invalid: '+str(exc))
    try:
        before = json.loads((logs / 'pre-source.json').read_text()); after = json.loads((logs / 'post-source.json').read_text())
        require(before['coreCommit'] == after['coreCommit'] == 'c5ff51d2e7b09cca70c8bc23941eb913d34fec5d', 'core commit drift')
        require(before['coreTree'] == after['coreTree'] == 'e067e0770322855eab5d8079be36d1a149abebdf', 'core tree drift')
        require(before['externalTree'] == after['externalTree'] == '5f442218aae7a660c6fdb4be60c96ff62dbd4d06', 'external tree drift')
        require(before['coreFiles'] == after['coreFiles'] == 1557 and before['externalFiles'] == after['externalFiles'] == 43, 'source set incomplete')
    except Exception as exc: errors.append('source binding missing/invalid: '+str(exc))
    try:
        receipt = json.loads((logs / 'cleanup.json').read_text()); observed['cleanup'] = receipt
        require(receipt['status'] == 'complete' and receipt['targetCount'] == len(receipt['ownedTargets']) == 5, 'cleanup incomplete')
        require(all(x['absentAfter'] and x['error'] is None for x in receipt['ownedTargets']), 'owned cleanup failed')
        expected_core = payload.parents[2] / 'core'
        expected_targets = [expected_core / 'backend/src/routes/providerIdentities.mcpContract.test.js', expected_core / 'backend/vitest.mcpContract.config.mjs', expected_core / 'backend/node_modules', payload / 'external/node_modules', logs.parent / 'mcp-core-v33-home']
        require([x['target'] for x in receipt['ownedTargets']] == [str(x) for x in expected_targets], 'cleanup owned target identities differ')
    except Exception as exc: errors.append('cleanup receipt missing/invalid: '+str(exc))
    try:
        steps = json.loads(os.environ['STEPS_JSON'])
        observed['steps'] = {key: steps.get(key, {}).get('outcome', 'missing') for key in
            ['checkout_payload','checkout_core','node','pin','core_ci','external_ci','batch','post','cleanup']}
        require(all(outcome == 'success' for outcome in observed['steps'].values()), 'workflow step missing/failed/skipped')
    except Exception as exc: errors.append('step outcomes missing/invalid: '+str(exc))
    result = {'status': 'passed' if not errors else 'failed_or_incomplete', 'errors': errors, 'observed': observed,
        'workflowSHA': os.environ.get('WORKFLOW_SHA'), 'sourceCommit':'c5ff51d2e7b09cca70c8bc23941eb913d34fec5d',
        'limits':'Exact8+19 synthetic SDK/core cases only; no live provider/SQL/Redis/appentry/UI/full acceptance proof.'}
    (logs / 'result.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if not errors else 1)

if __name__ == '__main__':
    if sys.argv[1] == 'cleanup': cleanup(*sys.argv[2:6])
    elif sys.argv[1] == 'enforce': enforce(*sys.argv[2:4])
    else: verify_mode(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv)>3 else 'before')
