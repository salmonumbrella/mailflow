#!/usr/bin/env python3
"""Static compile/JSON/YAML/source-pin checks only; never imports runner/Node."""
import argparse
import ast
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--inventory', type=Path, required=True)
parser.add_argument('--frozen-fjve', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
here = Path(__file__).resolve().parent
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for path in here.glob('*.py'):
    compile(path.read_text(), path.name, 'exec')
frozen = json.loads((args.frozen_fjve / 'manifest.json').read_text())
assert all(sha(args.frozen_fjve / n) == h for n, h in frozen.items())
plan = json.loads((here / 'plan.json').read_text())
assert len(plan['commands']) == 1 and plan['selected_sql_targets'] == plan['expected_native_passes'] == 10
assert plan['duplicate_unit_targets'] == 0 and plan['unselected_A_D_targets'] == 375
command = plan['commands'][0]
assert command['file'] == 'backend/src/services/imapManager.draftIngest.test.js'
assert command['deadline_seconds'] == 360 and command['max_fixture_clients'] == 1
assert command['expected_sql_passes'] == 10 and command['expected_duplicate_unit_passes'] == 0
binding = json.loads((args.inventory / 'hosted-handoff-v21/source-bindings.json').read_text())['v21']
assert plan['source']['accepted_private_sha'] == binding['head'] == 'bc538c0ae6827e8c94f5b824d5d12a881a5da092'
assert plan['source']['tree'] == binding['tree'] == '85ee5f47109f0c01b8f595c32b88c3f26e24cd56'
assert plan['source']['source_files'] == binding['source_files'] and len(binding['source_files']) == 113
for name, value in binding['source_files'].items():
    assert not Path(name).is_absolute() and '..' not in Path(name).parts
    assert sha(Path(binding['source_root']) / name) == value
assert binding['source_files'][command['file']] == 'b5d960914c673139191ce70268bb2ac9afdcbab3a7b3132d3174590ec267b051'
old = json.loads((args.frozen_fjve / 'plan.json').read_text())['source']['source_files']
assert [n for n,h in binding['source_files'].items() if old[n] != h] == [command['file']]
code = (here / 'runner.py').read_text()
parent = ast.parse((args.frozen_fjve / 'runner.py').read_text())
child = ast.parse(code)
def definition(tree, name):
    return next(n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name == name)
for name in ['source_guard','group_exists','reap','finish_group','run_logged','native_counts','ManagedPG']:
    assert ast.dump(definition(parent, name)) == ast.dump(definition(child, name)), name
assert '--maxWorkers=1' in code and '--max-old-space-size=512' in code
assert '--testNamePattern' not in code and '--testTimeout' not in code and '--hookTimeout' not in code
assert 'os.fchmod(descriptor, 0o600)' in code
assert "'NPM_CONFIG_USERCONFIG': str(npm_user)" in code and "'NPM_CONFIG_GLOBALCONFIG': str(npm_global)" in code
admin = (here / 'pg-admin.mjs').read_text()
assert admin.count("PASSWORD %L', $1::text) AS ddl") == 1
assert "PASSWORD %L', $1) AS ddl" not in admin
assert 'mailflow_pyws_backup' not in admin
wf = json.loads((here / 'workflow-parsed.json').read_text())
assert set(wf['on']) == {'push'} and wf['on']['push']['branches'] == ['verification/ci-mailflow-draft-pg-v21']
assert wf['permissions'] == {'contents': 'read'}
job = wf['jobs']['draft-postgres']
assert job['timeout-minutes'] == 25
assert "github.repository == 'salmonumbrella/mailflow'" in job['if'] and 'github.run_attempt == 1' in job['if']
steps = job['steps']
checkouts = [s for s in steps if s.get('uses','').startswith('actions/checkout@')]
assert len(checkouts) == 2 and all(s['with']['persist-credentials'] is False for s in checkouts)
assert checkouts[1]['with']['ref'] == '${{ steps.source.outputs.sha }}'
resolve = next(s for s in steps if s.get('id') == 'source')['run']
assert 'source-map.json' in resolve and "mapping['public_sha'] or ''" in resolve
compile('\n'.join(resolve.splitlines()[1:-1]), '<workflow mapping preflight>', 'exec')
assert steps.index(next(s for s in steps if s.get('id') == 'source')) < steps.index(checkouts[1])
assert steps[-1]['if'] == 'always()' and steps[-1]['with']['overwrite'] is False
mapping = json.loads((here / 'source-map.json').read_text())
assert mapping['public_sha'] is None
assert mapping['accepted_tree'] == binding['tree'] and mapping['accepted_private_sha'] == binding['head']
assert mapping['fixture_sha256'] == binding['source_files'][command['file']]
for name in ['runner.py','pg-admin.mjs','plan.json','workflow.yml','README.md','source-map.json','commands.json','provenance.json','source-oracles.json']:
    private_prefix = '/' + '/'.join(['home', 'codex', 'vault']) + '/'
    assert private_prefix not in (here / name).read_text(), name
result = {'status':'STATIC_READY_PUBLIC_MAPPING_REQUIRED_RUNTIME_UNRUN',
 'python_compile':True,'json_yaml_actionlint':'pass; no shellcheck/pyflakes/application execution',
 'source_files_rehashed':113,'only_fixture_pin_changed_from_v20':command['file'],
 'native_files':1,'expected_sql_passes':10,'duplicate_units':0,'unselected_A_D_cases':375,
 'parent_fjve_unchanged':True,'shared_process_source_native_count_and_cleanup_AST_unchanged':True,
 'bootstrap_cast':'Accepted $1::text; no actual SQL executed here',
 'npm_config':'Distinct empty private0600 files retained',
 'public_mapping':'null; workflow and runner block execution; factual mapping requested from lead',
 'not_run':['Node/import/install','PG/SQL/Docker','tests/CI/GitHub writes','old-source control'],
 'not_claimed':['Observed RED/GREEN','ten-case proof','full385/migrations/provider/Mini/performance']}
with args.output.open('x') as f:
    json.dump(result, f, indent=2); f.write('\n')
print(json.dumps({'status':result['status'],'expected_cases':10,'source_pins':113}))
