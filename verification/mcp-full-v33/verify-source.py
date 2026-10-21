#!/usr/bin/env python3
"""Proposed hosted verifier; no product import, network, or test execution."""
from pathlib import Path
from collections import Counter
import ast, hashlib, json, os, re, shutil, sys

def digest(data): return hashlib.sha256(data).hexdigest()
def read(path): return json.loads(path.read_text())
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
            entries.append(mode.encode()+b' '+name.encode()+b'\0'+bytes.fromhex(oid))
        data = b''.join(entries)
        return hashlib.sha1(b'tree '+str(len(data)).encode()+b'\0'+data).hexdigest()
    return encode(root)

def verify(payload, mode):
    assert mode in ['before', 'after']
    pins = read(payload/'pins.json'); descriptor = pins['external']; external = payload/'external'
    assert len(descriptor['files']) == 43
    actual = set()
    for parent, dirs, names in os.walk(external, followlinks=False):
        parent = Path(parent)
        for directory in list(dirs):
            child = parent/directory
            assert not child.is_symlink(), str(child)
            if child == external/'node_modules':
                assert mode == 'after'
                dirs.remove(directory)
        for name in names:
            file = parent/name
            assert file.is_file() and not file.is_symlink(), str(file)
            actual.add(file.relative_to(external).as_posix())
    assert actual == set(descriptor['files']), 'external file set drift'
    for name, row in descriptor['files'].items():
        file = external/name; data = file.read_bytes()
        assert digest(data) == row['sha256'], name
        assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() == row['oid'], name
        assert bool(file.stat().st_mode & 0o111) == (row['mode'] == '100755'), name
    assert tree_id(descriptor['files']) == descriptor['tree'] == '0e12321da7d5a110d04918c1d4c640e66d960008'
    assert read(external/'package.json')['scripts']['test'] == 'node --test'
    for name, pin in pins['harness'].items():
        file = payload/name
        assert file.is_file() and not file.is_symlink() and digest(file.read_bytes()) == pin, name
    workflow = payload.parents[1]/'.github/workflows/verify-mcp-full-v33.yml'
    assert digest(workflow.read_bytes()) == pins['workflowSHA256']
    cases = read(payload/'cases.json')
    tests = sorted(x.relative_to(external).as_posix() for x in (external/'test').glob('*.test.js'))
    assert tests == [x['file'] for x in cases['files']] and len(tests) == 11
    total = 0
    for row in cases['files']:
        file = external/row['file']; text = file.read_text()
        literal = re.findall(r'''^test\(((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))\s*,''', text, re.M)
        titles = [ast.literal_eval(x) for x in literal]
        assert len(re.findall(r'^test\(', text, re.M)) == len(titles) == row['count']
        assert titles == row['titles'] and digest(file.read_bytes()) == row['sha256']
        total += len(titles)
    assert cases['expectedCount'] == total == 196 and cases['expectedFiles'] == 11
    assert not (payload/'.env').exists() and not (external/'.env').exists()
    print(json.dumps({'status':'exact','mode':mode,'externalTree':descriptor['tree'],'files':43,
        'caseInventory':196,'caseFiles':11,'harness':'exact','workflowSHA256':pins['workflowSHA256']}))

def cleanup(payload, home, logs):
    assert payload.name == 'mcp-full-v33' and payload.parent.name == 'verification'
    assert home.name == 'mcp-full-v33-home' and logs.name == 'mcp-full-v33-logs' and home.parent == logs.parent
    targets = [payload/'external/node_modules', home]; rows = []
    for target in targets:
        error = None; existed = target.exists() or target.is_symlink()
        try:
            if target.is_symlink() or target.is_file(): target.unlink()
            elif target.is_dir(): shutil.rmtree(target)
        except Exception as exc: error = str(exc)
        rows.append({'target':str(target),'existed':existed,'absentAfter':not target.exists() and not target.is_symlink(),'error':error})
    complete = all(x['absentAfter'] and x['error'] is None for x in rows)
    logs.mkdir(exist_ok=True)
    (logs/'cleanup.json').write_text(json.dumps({'status':'complete' if complete else 'incomplete','targetCount':2,'ownedTargets':rows},indent=2)+'\n')
    raise SystemExit(0 if complete else 1)

def enforce(payload, logs):
    cases = read(payload/'cases.json'); errors = []; observed = {}
    def require(condition, message):
        if not condition: errors.append(message)
    try:
        commands = read(logs/'commands.json'); observed['commands'] = commands
        command = commands['externalFull']
        require(command['argv'] == ['npm','test','--','--test-reporter=tap','--test-concurrency=1'], 'unfiltered full package command differs')
        require(command['attempts'] == 1 and command['exitCode'] == 0 and command['deadlineSeconds'] == 240 and command['deadlineStatus'] == 'not_reported', 'command missing/failed/repeated/deadline')
        priv = read(logs/'privileges.json'); observed['privileges'] = priv
        require(priv['uid'] > 0 and priv['gid'] > 0 and priv['noNewPrivileges'] is True, 'privilege boundary incomplete')
        ns = read(logs/'namespace.json'); observed['namespace'] = ns
        require(ns['complete'] is True and ns['remainingPids'] == [], 'test/CLI/server processes remain in namespace')
        interfaces = (logs/'interfaces.log').read_text().splitlines()
        require(len(interfaces) == 1 and re.match(r'^\d+: lo:', interfaces[0]) is not None, 'network namespace is not loopback only')
    except Exception as exc: errors.append('command/isolation receipt missing/invalid: '+str(exc))
    try:
        tap = (logs/'external-full.tap').read_text(); counts = {}
        for key in ['tests','pass','fail','cancelled','skipped','todo']:
            values = re.findall(r'^# '+key+r' (\d+)\s*$',tap,re.M)
            require(len(values) == 1, 'TAP '+key+' summary missing/ambiguous')
            counts[key] = int(values[0]) if len(values) == 1 else None
        titles = re.findall(r'^# Subtest: (.*)$',tap,re.M)
        expected = [title for row in cases['files'] for title in row['titles']]
        observed['native'] = {'counts':counts,'titles':titles}
        require(cases['expectedCount'] == len(expected) == 196 and cases['expectedFiles'] == len(cases['files']) == 11, 'source inventory differs')
        require(counts['tests'] == counts['pass'] == 196, 'native must run/pass exactly196')
        require(all(counts[x] == 0 for x in ['fail','cancelled','skipped','todo']), 'native fail/skip/todo/cancel/incomplete')
        require(Counter(titles) == Counter(expected), 'native exact source-derived identities differ')
        ok = re.findall(r'^ok (\d+) - (.*)$',tap,re.M)
        require([int(x[0]) for x in ok] == list(range(1,197)), 'native numbered case results incomplete')
        require(Counter(x[1] for x in ok) == Counter(expected), 'native result identities differ')
        require(re.findall(r'^1\.\.(\d+)\s*$',tap,re.M) == ['196'], 'native plan must be1..196')
        require(not re.search(r'^\s*not ok |^Bail out!|^\s+ok \d+ - |^\s+# Subtest:|^ok .*# (?:SKIP|TODO)',tap,re.M), 'nested/failed/bail/skip/todo TAP unsupported')
    except Exception as exc: errors.append('native TAP missing/invalid: '+str(exc))
    try:
        before = read(logs/'pre-source.json'); after = read(logs/'post-source.json')
        observed['source'] = {'before':before,'after':after}
        for row in [before,after]:
            require(row['status'] == 'exact' and row['externalTree'] == '0e12321da7d5a110d04918c1d4c640e66d960008' and row['files'] == 43 and row['caseInventory'] == 196 and row['caseFiles'] == 11 and row['harness'] == 'exact', 'source/harness binding incomplete')
        require(before['mode'] == 'before' and after['mode'] == 'after' and before['workflowSHA256'] == after['workflowSHA256'], 'source phases/workflow differ')
    except Exception as exc: errors.append('source receipts missing/invalid: '+str(exc))
    try:
        receipt = read(logs/'cleanup.json'); observed['cleanup'] = receipt
        require(receipt['status'] == 'complete' and receipt['targetCount'] == len(receipt['ownedTargets']) == 2, 'cleanup incomplete')
        expected = [payload/'external/node_modules', logs.parent/'mcp-full-v33-home']
        require([x['target'] for x in receipt['ownedTargets']] == list(map(str,expected)), 'cleanup owned target identities differ')
        require(all(x['absentAfter'] and x['error'] is None for x in receipt['ownedTargets']), 'cleanup failed')
        require(all(not x.exists() and not x.is_symlink() for x in expected), 'cleanup target still exists')
    except Exception as exc: errors.append('cleanup receipt missing/invalid: '+str(exc))
    try:
        steps = json.loads(os.environ['STEPS_JSON'])
        observed['steps'] = {name:steps.get(name,{}).get('outcome','missing') for name in ['checkout_payload','node','pin','external_ci','batch','post','cleanup']}
        require(all(x == 'success' for x in observed['steps'].values()), 'workflow prerequisite failed/skipped/missing')
        require(os.environ['RUN_ATTEMPT'] == '1', 'only attempt1 is evidence')
        require(bool(re.fullmatch(r'[0-9a-f]{40}', os.environ['WORKFLOW_SHA'])), 'publication SHA missing')
    except Exception as exc: errors.append('workflow binding missing/invalid: '+str(exc))
    result = {'status':'passed' if not errors else 'failed_or_incomplete','errors':errors,'observed':observed,
        'workflowSHA':os.environ.get('WORKFLOW_SHA'),'externalTree':'0e12321da7d5a110d04918c1d4c640e66d960008',
        'limits':'Full external package suite only. Synthetic loopback/in-memory fixtures; no new core/SQL/live-provider/UI/deployment proof. Prior SDK8+joined19 run39635340741 remains separate.'}
    (logs/'result.json').write_text(json.dumps(result,indent=2)+'\n'); print(json.dumps(result,indent=2))
    raise SystemExit(0 if not errors else 1)

if __name__ == '__main__':
    mode=sys.argv[1]
    if mode == 'verify': verify(Path(sys.argv[2]).resolve(),sys.argv[3])
    elif mode == 'cleanup': cleanup(*(Path(x).resolve() for x in sys.argv[2:5]))
    elif mode == 'enforce': enforce(*(Path(x).resolve() for x in sys.argv[2:4]))
    else: raise SystemExit('unsupported mode')
