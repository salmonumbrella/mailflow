#!/usr/bin/env python3
"""Compile/JSON/YAML policy inspection only. Never imports or runs the harness."""
import argparse
import ast
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--inventory', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
p = Path(__file__).resolve().parent
plan = json.loads((p / 'plan.json').read_text())
code = (p / 'runner.py').read_text()
compile(code, 'runner.py', 'exec')
compile(Path(__file__).read_text(), 'static-check.py', 'exec')
ast.parse(code)
wf = json.loads((p / 'workflow-parsed.json').read_text())
assert set(wf['on']) == {'push'}
assert wf['on']['push']['branches'] == ['verification/ci-mailflow-pg-v20']
assert wf['permissions'] == {'contents': 'read'}
assert wf['concurrency']['cancel-in-progress'] is False
job = wf['jobs']['postgres']
assert job['timeout-minutes'] == 225
assert "github.repository == 'salmonumbrella/mailflow'" in job['if'] and 'github.run_attempt == 1' in job['if']
steps = job['steps']
checks = [s for s in steps if s.get('uses', '').startswith('actions/checkout@')]
assert len(checks) == 2 and all(s['with']['persist-credentials'] is False and s['with']['repository'] == 'salmonumbrella/mailflow' for s in checks)
assert checks[1]['with']['ref'] == plan['source']['sha']
node = next(s for s in steps if s.get('uses', '').startswith('actions/setup-node@'))
assert node['with'] == {'node-version': '22.23.3', 'package-manager-cache': False}
assert steps[-1]['if'] == 'always()' and steps[-1]['with']['overwrite'] is False
metadata = json.loads((p / 'action-metadata.json').read_text())
assert all(row['sha'] in (p / 'workflow.yml').read_text() and row['runtime'] == 'node24' for row in metadata.values())
assert len(plan['source']['source_files']) == 113 and len(plan['commands']) == 30
assert sum(c['expected_sql_passes'] for c in plan['commands']) == 375
assert sum(c['expected_duplicate_unit_passes'] for c in plan['commands']) == 4
assert all(c['max_fixture_clients'] <= 2 for c in plan['commands'])
assert all(c['deadline_seconds'] == (600 if c['file'] == 'backend/src/services/searchIndex.postgres.test.js' else 360) for c in plan['commands'])
assert all(c['partition'] != 'E' and c['file'] != plan['held']['file'] for c in plan['commands'])
assert '--testNamePattern' not in code and '--testTimeout' not in code and '--hookTimeout' not in code
assert '--maxWorkers=1' in code and '--no-file-parallelism' in code
source = json.loads((args.inventory / 'hosted-handoff-v21/source-bindings.json').read_text())['v20']
assert source['source_files'] == plan['source']['source_files']
for name, value in source['source_files'].items():
    assert not Path(name).is_absolute() and '..' not in Path(name).parts
    assert hashlib.sha256((Path(source['source_root']) / name).read_bytes()).hexdigest() == value
assert hashlib.sha256((args.inventory / 'inventory-summary.json').read_bytes()).hexdigest() == plan['source']['inventory_summary_sha256']
# Inspect the correction's AST/text; do not create configs or invoke npm.
assert "private / 'npm-user.npmrc'" in code and "private / 'npm-global.npmrc'" in code
assert "'NPM_CONFIG_USERCONFIG': str(npm_user)" in code and "'NPM_CONFIG_GLOBALCONFIG': str(npm_global)" in code
assert 'os.fchmod(descriptor, 0o600)' in code and "'NPM_CONFIG_USERCONFIG': '/dev/null'" not in code
assert 'os.environ.copy()' not in code
assert 'signal.pthread_sigmask' in code and 'start_new_session=True' in code
assert "'group_absent': True" in code and 'child.wait(timeout=5)' in code
for name in ['runner.py', 'pg-admin.mjs', 'plan.json', 'workflow.yml', 'postgres-image.json', 'commands.json', 'README.md', 'action-metadata.json']:
    text = (p / name).read_text()
    assert '/home/codex/' not in text and '/Users/' not in text, name
image = json.loads((p / 'postgres-image.json').read_text())
assert image['image'].startswith('postgres:16.15-bookworm@sha256:') and image['server_version_required'] == 160015
assert 'pg_isready' not in code
result = {
    'status': 'STATIC_CHECKS_PASS_NOT_EXECUTED', 'python_compile': True,
    'json_yaml_parsed': True, 'actionlint_no_script_execution': 'exit0; -shellcheck= -pyflakes=',
    'workflow_policy': {'single_new_push_branch': True, 'fork_only': True, 'contents_read': True,
                        'checkout_credentials_false': True, 'source_sha_pinned': True,
                        'actions_primary_metadata_pinned': True, 'always_artifact_upload': True},
    'inventory': {'source_sha': plan['source']['sha'], 'source_tree': plan['source']['tree'],
                  'files_rehashed': 113, 'native_files': 30, 'sql_targets': 375, 'duplicate_units': 4,
                  'expected_native_passes': 379, 'held_E': 10, 'original_inventory_summary_unchanged': True},
    'npm_config_correction': {'basis': 'Root reports prior actual same-/dev/null dual-load install failure; old evidence unchanged',
                              'distinct_private_filenames': ['npm-user.npmrc', 'npm-global.npmrc'],
                              'exclusive_empty_create_and_explicit_mode': '0600', 'child_env_only': True,
                              'npm_or_install_executed': False},
    'inspection_limits': ['Python compiled; JSON/YAML/AST/source hashes inspected only',
                          'JavaScript helper authored/read; no Node syntax/import execution',
                          'No mocked tests, PostgreSQL, Docker, npm, CI or GitHub writes',
                          'Managed cleanup/version/count behavior remains unexecuted until root-reviewed hosted run']}
with args.output.open('x') as stream:
    json.dump(result, stream, indent=2)
    stream.write('\n')
print(json.dumps({'status': result['status'], 'files_rehashed': 113, 'expected_native': 379}))
