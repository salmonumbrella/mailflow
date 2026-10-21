#!/usr/bin/env python3
"""Managed, exact-source hosted SQL subset. Static preparation is NOT execution."""
import argparse
import codecs
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
TASK = 'mailflow-producer40-pg-v22'
DATABASES = ('mailflow_svtw', 'mailflow_pyws_backup')


class Stop(RuntimeError):
    pass


def require(value, reason):
    if not value:
        raise Stop(reason)


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            value.update(chunk)
    return value.hexdigest()


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def scrub(text, sensitive=(), paths=()):
    for value in sorted(sensitive, key=len, reverse=True):
        if value:
            text = text.replace(value, '<ephemeral-secret>')
    text = re.sub(r'postgres(?:ql)?://[^\s\x22\x27<>]+', '<isolated-pg-url>', text)
    for value, replacement in paths:
        text = text.replace(str(value), replacement)
    return text


def metadata():
    manifest = json.loads((HERE / 'manifest.json').read_text())
    for name, expected in manifest.items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts, 'unsafe harness path')
        path = HERE / relative
        require(path.is_file() and not path.is_symlink() and sha(path) == expected, 'harness pin drift: ' + name)
    plan = json.loads((HERE / 'plan.json').read_text())
    require(len(plan['source']['source_files']) == 113, 'inventory size')
    require(len(plan['commands']) == 1, 'selected files')
    require(sum(c['expected_sql_passes'] for c in plan['commands']) == 40, 'SQL count')
    require(sum(c['expected_duplicate_unit_passes'] for c in plan['commands']) == 0, 'duplicate unit count')
    require(plan['held']['sql_targets'] == 10, 'held E count')
    return plan


def source_guard(root, plan, env):
    def git(*args):
        p = subprocess.run(['git', '-C', str(root), *args], env=env, capture_output=True, text=True, timeout=20)
        require(p.returncode == 0, 'source git guard failed')
        return p.stdout.strip()
    require(git('rev-parse', 'HEAD') == plan['source']['sha'], 'source HEAD drift')
    require(git('rev-parse', 'HEAD^{tree}') == plan['source']['tree'], 'source tree drift')
    require(not git('status', '--porcelain=v1', '--untracked-files=all'), 'source checkout dirty')
    for name, expected in plan['source']['source_files'].items():
        path = root / name
        require(path.is_file() and not path.is_symlink() and sha(path) == expected, 'source hash drift: ' + name)


def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if not pid:
                return
        except ChildProcessError:
            return


def finish_group(child):
    # Do not release the file boundary while any session descendant remains.
    child.poll()
    lingering = group_exists(child.pid)
    if lingering:
        os.killpg(child.pid, signal.SIGTERM)
        limit = time.monotonic() + 2
        while group_exists(child.pid) and time.monotonic() < limit:
            child.poll(); reap(); time.sleep(.05)
        if group_exists(child.pid):
            os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    limit = time.monotonic() + 3
    while time.monotonic() < limit:
        reap()
        if not group_exists(child.pid):
            break
        time.sleep(.05)
    require(not group_exists(child.pid), 'test process group survives cleanup')
    children = Path('/proc/self/task/' + str(os.getpid()) + '/children').read_text().split()
    require(not children, 'adopted descendant survives cleanup')
    return lingering


def run_logged(argv, cwd, env, prefix, seconds, sensitive=(), paths=()):
    """Registered child + redacted streams; parent retains cleanup on every exit."""
    masked = {signal.SIGINT, signal.SIGTERM}
    before = signal.pthread_sigmask(signal.SIG_BLOCK, masked)
    child, selector = None, None
    started = time.monotonic()
    timed_out, lingering, error_kind = False, False, None
    try:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True)
        with Path(str(prefix) + '.stdout.log').open('x') as out, Path(str(prefix) + '.stderr.log').open('x') as err:
            selector = selectors.DefaultSelector()
            decoders, buffers = {}, {}
            for stream, destination in [(child.stdout, out), (child.stderr, err)]:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, destination)
                decoders[stream] = codecs.getincrementaldecoder('utf-8')('replace')
                buffers[stream] = ''
            # The child and all cleanup state exist before a pending signal is delivered.
            signal.pthread_sigmask(signal.SIG_SETMASK, before)
            total = 0
            while selector.get_map():
                if time.monotonic() - started > seconds:
                    timed_out = True
                    raise Stop('outer deadline')
                for key, _ in selector.select(.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    total += len(data)
                    require(total <= 64 * 1024 * 1024, 'unexpected log volume')
                    buffers[key.fileobj] += decoders[key.fileobj].decode(data, final=not data)
                    lines = buffers[key.fileobj].splitlines(keepends=True)
                    buffers[key.fileobj] = ''
                    if data and lines and not lines[-1].endswith(('\n', '\r')):
                        buffers[key.fileobj] = lines.pop()
                    require(len(buffers[key.fileobj]) < 4 * 1024 * 1024, 'unbounded log line')
                    for line in lines:
                        key.data.write(scrub(line, sensitive, paths))
                    if not data:
                        if buffers[key.fileobj]:
                            key.data.write(scrub(buffers[key.fileobj], sensitive, paths))
                        selector.unregister(key.fileobj)
            child.wait(timeout=max(.01, seconds - (time.monotonic() - started)))
    except subprocess.TimeoutExpired:
        timed_out, error_kind = True, 'outer deadline'
    except BaseException as error:
        error_kind = type(error).__name__ + ': ' + scrub(str(error), sensitive, paths)
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, masked)
        if selector is not None:
            selector.close()
        try:
            if child is not None:
                lingering = finish_group(child)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, before)
    return {'exit_code': child.returncode if child else None,
            'seconds': round(time.monotonic() - started, 3), 'timed_out': timed_out,
            'failure_kind': error_kind, 'lingering_group_at_exit': lingering, 'group_absent': True}


def native_counts(report, command):
    files = report.get('testResults', [])
    require(len(files) == 1, 'native report must contain exactly one file')
    require(files[0].get('name', '').replace('\\', '/').endswith(command['file']), 'native file identity mismatch')
    require(files[0].get('status') == 'passed', 'native suite failed')
    assertions = files[0].get('assertionResults', [])
    counts = {key: sum(a.get('status') == key for a in assertions)
              for key in ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']}
    expected = command['expected_sql_passes'] + command['expected_duplicate_unit_passes']
    require(len(assertions) == counts['passed'] == expected, 'native assertion total/status mismatch')
    require(all(a.get('status') == 'passed' for a in assertions), 'pending/skipped/failed assertion')
    require(report.get('success') is True and report.get('numFailedTests', 0) == 0
            and report.get('numPendingTests', 0) == 0 and report.get('numTodoTests', 0) == 0
            and report.get('numRuntimeErrorTestSuites', 0) == 0
            and not report.get('unhandledErrors', []), 'native runtime/pending/error report')
    require(report.get('numTotalTests') == expected and report.get('numPassedTests') == expected, 'native top-level totals mismatch')
    return counts


class ManagedPG:
    def __init__(self, out, private, env, image, run_id, sensitive):
        self.out, self.private, self.env = out, private, env
        self.image, self.run_id, self.sensitive = image, run_id, sensitive
        self.name = TASK + '-' + run_id
        self.identifier = None
        self.image_id = None
        self.docker = ['docker', '--config', str(private / 'docker'), '--host', 'unix:///var/run/docker.sock']
        (private / 'docker').mkdir()
        (private / 'docker/config.json').write_text('{"auths": {}}\n')

    def call(self, args, *, env=None, timeout=30, check=True):
        result = subprocess.run(self.docker + args, env=env or self.env, capture_output=True,
                                text=True, timeout=timeout)
        require(not check or result.returncode == 0, 'owned Docker command failed: ' + args[0])
        return result

    def absent(self, identifier):
        result = self.call(['inspect', identifier], check=False)
        if result.returncode == 0:
            return False
        require('no such object' in result.stderr.lower() or 'no such container' in result.stderr.lower(),
                'Docker inspection failed; absence unproven')
        return True

    def inspect(self):
        return json.loads(self.call(['inspect', self.identifier]).stdout)[0]

    def verify_owner(self):
        row = self.inspect()
        require(row['Id'] == self.identifier and row['Name'] == '/' + self.name, 'owned ID/name mismatch')
        require(row['Config']['Labels'].get('mailflow.task') == TASK
                and row['Config']['Labels'].get('mailflow.run') == self.run_id, 'owned label mismatch')
        lease = json.loads((self.out / 'lease.json').read_text())
        require(row['Image'] == lease['image_id'], 'owned image mismatch')
        return row

    def create(self, password):
        pulled = self.call(['pull', self.image], timeout=180, check=False)
        (self.out / 'image-pull.stdout.log').write_text(scrub(pulled.stdout, self.sensitive))
        (self.out / 'image-pull.stderr.log').write_text(scrub(pulled.stderr, self.sensitive))
        require(pulled.returncode == 0, 'pinned PostgreSQL image pull failed')
        image_id = json.loads(self.call(['image', 'inspect', self.image]).stdout)[0]['Id']
        self.image_id = image_id
        save(self.out / 'lease-intent.json', {'task': TASK, 'run_id': self.run_id, 'name': self.name,
             'id': None, 'image_id': image_id, 'image_ref': self.image})
        # A fresh container, tmpfs PGDATA and no host data, credentials, socket or source mounts.
        args = ['create', '--name', self.name, '--label', 'mailflow.task=' + TASK,
                '--label', 'mailflow.run=' + self.run_id, '--restart=no',
                '--memory=2g', '--memory-swap=2g', '--cpus=2', '--pids-limit=128',
                '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=1g',
                '--tmpfs', '/var/run/postgresql:rw,size=16m', '--tmpfs', '/tmp:rw,size=64m',
                '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=mailflow_admin',
                '--env', 'POSTGRES_DB=postgres', '--env', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
                self.image, '-c', 'max_connections=12', '-c', 'shared_buffers=128MB',
                '-c', 'log_statement=none', '-c', 'log_min_duration_statement=-1']
        before = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        try:
            self.identifier = self.call(args, env={**self.env, 'POSTGRES_PASSWORD': password}).stdout.strip()
            require(re.fullmatch('[0-9a-f]{64}', self.identifier), 'invalid created ID')
            save(self.out / 'lease.json', {'task': TASK, 'run_id': self.run_id, 'name': self.name,
                 'id': self.identifier, 'image_id': image_id, 'image_ref': self.image})
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, before)
        row = self.verify_owner()
        require(not any(m['Type'] in ['bind', 'volume'] for m in row.get('Mounts', [])), 'unexpected data/host mount')
        require(row['HostConfig']['Memory'] == row['HostConfig']['MemorySwap'] == 2147483648
                and row['HostConfig']['NanoCpus'] == 2000000000 and row['HostConfig']['PidsLimit'] == 128
                and row['HostConfig']['RestartPolicy']['Name'] == 'no', 'PG caps mismatch')
        self.call(['start', self.identifier])
        row = self.verify_owner()
        binding = row['NetworkSettings']['Ports']['5432/tcp']
        require(len(binding) == 1 and binding[0]['HostIp'] == '127.0.0.1', 'PG must publish only on loopback')
        require(set(row['HostConfig']['PortBindings']) == {'5432/tcp'}, 'unexpected PG published port')
        return int(binding[0]['HostPort'])

    def cleanup(self):
        if not self.identifier:
            if not self.image_id:
                return {'owned_service_created': False, 'errors': []}
            discovered = self.call(['inspect', self.name], check=False)
            if discovered.returncode != 0:
                require(self.absent(self.name), 'uncertain create outcome')
                return {'owned_service_created': False, 'errors': []}
            candidate = json.loads(discovered.stdout)[0]
            require(candidate['Name'] == '/' + self.name and candidate['Image'] == self.image_id
                    and candidate['Config']['Labels'].get('mailflow.task') == TASK
                    and candidate['Config']['Labels'].get('mailflow.run') == self.run_id,
                    'ambiguous create outcome; refuse unrelated cleanup')
            self.identifier = candidate['Id']
            if not (self.out / 'lease.json').exists():
                save(self.out / 'lease.json', {'task': TASK, 'run_id': self.run_id, 'name': self.name,
                     'id': self.identifier, 'image_id': self.image_id, 'image_ref': self.image})
        row = self.verify_owner()
        log_errors = []
        try:
            logs = self.call(['logs', self.identifier], check=False)
            (self.out / 'postgres.stdout.log').write_text(scrub(logs.stdout, self.sensitive))
            (self.out / 'postgres.stderr.log').write_text(scrub(logs.stderr, self.sensitive))
            if logs.returncode:
                log_errors.append('owned PostgreSQL log retrieval failed')
        except BaseException as error:
            log_errors.append('owned PostgreSQL log retrieval: ' + type(error).__name__)
        finally:
            # Log retrieval failure must never skip exact owned stop/removal.
            row = self.verify_owner()
            if row['State']['Running']:
                self.call(['stop', '--time', '5', self.identifier], timeout=20)
            row = self.verify_owner()
            require(not row['State']['Running'], 'owned PG remains running')
            oom = row['State']['OOMKilled']
            self.call(['rm', '-v', self.identifier])
            absent = self.absent(self.identifier)
            require(absent and not oom, 'PG absence/OOM cleanup failure')
        return {'owned_service_created': True, 'owned_id': self.identifier, 'removed': True,
                'tmpfs_data_discarded': True, 'oom': oom, 'errors': log_errors}


def cleanup_saved(out, env):
    lease_path = out / ('lease.json' if (out / 'lease.json').exists() else 'lease-intent.json')
    if not lease_path.exists():
        return {'no_owned_service_intent': True}
    lease = json.loads(lease_path.read_text())
    require(lease['task'] == TASK and re.fullmatch('[0-9a-f]{12}', lease['run_id']), 'invalid owned lease')
    # Fallback after workflow cancellation: no Node/test/SQL or new service.
    with tempfile.TemporaryDirectory(prefix='producer40-cleanup-') as temporary:
        pg = ManagedPG(out, Path(temporary), env, lease['image_ref'], lease['run_id'], ())
        pg.identifier = lease['id'] or lease['name']
        if pg.absent(pg.identifier):
            return {'already_absent': True}
        # Do not collect logs here: in-memory ephemeral redaction values no longer exist.
        if not lease['id']:
            candidate = pg.inspect()
            require(candidate['Name'] == '/' + lease['name'] and candidate['Image'] == lease['image_id']
                    and candidate['Config']['Labels'].get('mailflow.task') == TASK
                    and candidate['Config']['Labels'].get('mailflow.run') == lease['run_id'], 'fallback intent ownership mismatch')
            pg.identifier = candidate['Id']
            save(out / 'lease.json', {**lease, 'id': pg.identifier})
        row = pg.verify_owner()
        if row['State']['Running']:
            pg.call(['stop', '--time', '5', pg.identifier], timeout=20)
        row = pg.verify_owner()
        require(not row['State']['Running'], 'fallback stop failed')
        pg.call(['rm', '-v', pg.identifier])
        require(pg.absent(pg.identifier) and not row['State']['OOMKilled'], 'fallback removal/OOM failed')
        return {'removed_owned_id': pg.identifier, 'oom': row['State']['OOMKilled']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--cleanup-owned', action='store_true')
    args = parser.parse_args()
    require(not sys.flags.optimize, 'Python optimization forbidden')
    plan = metadata()
    # Exact allowlist, fresh HOME/temp/cache. No inherited tokens, PG*, DB*, dotenv or npm credentials.
    with tempfile.TemporaryDirectory(prefix='producer40-private-') as temporary:
        private = Path(temporary)
        # npm refuses to load the same file as both user and global config.
        # These are distinct, empty, task-private files; no existing config is read.
        npm_user = private / 'npm-user.npmrc'
        npm_global = private / 'npm-global.npmrc'
        for config in [npm_user, npm_global]:
            descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.fchmod(descriptor, 0o600)
            os.close(descriptor)
        require(npm_user != npm_global, 'npm configuration paths must differ')
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(private),
               'TMPDIR': str(private), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC',
               'CI': 'true', 'NPM_CONFIG_USERCONFIG': str(npm_user), 'NPM_CONFIG_GLOBALCONFIG': str(npm_global)}
        out = args.out.resolve()
        if args.cleanup_owned:
            require(not args.execute, 'cleanup is not execution')
            result = cleanup_saved(out, env)
            save(out / ('fallback-cleanup-' + secrets.token_hex(4) + '.json'), result)
            return
        require(args.execute and args.source, 'Explicit reviewed hosted execution required')
        require(os.environ.get('GITHUB_REPOSITORY') == plan['source']['repository']
                and os.environ.get('GITHUB_REF') == 'refs/heads/verification/ci-mailflow-pg-producer40-v22'
                and os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'wrong hosted repository/ref or retry attempt')
        require(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'native Ubuntu x64 hosted runner required')
        root = args.source.resolve(strict=True)
        require(not out.exists() and not out.is_relative_to(root), 'fresh separate output required')
        out.mkdir(parents=True)
        lock = open('/tmp/mailflow-managed-pg-producer40.lock', 'a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop('hosted PG slot busy; no queue or retry')
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'subreaper unavailable')
        def interrupted(signum, _frame):
            raise Stop('signal ' + str(signum))
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, interrupted)
        run_id = secrets.token_hex(6)
        passwords = [secrets.token_hex(32), secrets.token_hex(32)]
        sensitive = list(passwords)
        paths = [(root, 'source'), (HERE, 'verification/pg-producer40-v22'), (private, '<private>'), (out, 'pg-results')]
        pg = ManagedPG(out, private, env, json.loads((HERE / 'postgres-image.json').read_text())['image'], run_id, sensitive)
        records, failure, cleanup = [], None, None
        started = time.monotonic()
        try:
            source_guard(root, plan, env)
            save(out / 'scope.json', {'source_sha': plan['source']['sha'], 'source_tree': plan['source']['tree'],
                 'selected_sql_targets': 40, 'duplicate_unit_cases': 0, 'expected_native_passes': 40,
                 'separately_verified_unselected_E10_cases': 10, 'files': 1, 'not_claimed': ['full385', 'full migration chain', 'provider/Mini/corpus/performance']})
            node = shutil.which('node', path=env['PATH']); npm = shutil.which('npm', path=env['PATH'])
            require(node and npm, 'Node/npm unavailable')
            node_check = run_logged([node, '--version'], root / 'backend', env, out / 'node-version', 10, sensitive, paths)
            save(out / 'node-version.execution.json', node_check)
            require(node_check['exit_code'] == 0 and not node_check['failure_kind']
                    and (out / 'node-version.stdout.log').read_text().strip() == 'v22.23.3', 'Node version before install')
            installed = run_logged([npm, 'ci'], root / 'backend', {**env, 'NODE_ENV': 'development'}, out / 'npm-ci', 600, sensitive, paths)
            save(out / 'npm-ci.execution.json', installed)
            require(installed['exit_code'] == 0 and not installed['failure_kind'] and not installed['lingering_group_at_exit'], 'locked npm ci failed')
            source_guard(root, plan, env)
            def helper(mode, child_env, name, seconds=30):
                prefix = out / name
                result = run_logged([node, '--max-old-space-size=512', str(HERE / 'pg-admin.mjs'), mode], root / 'backend', {**env, **child_env}, prefix, seconds, sensitive, paths)
                save(out / (name + '.execution.json'), result)
                require(result['exit_code'] == 0 and not result['failure_kind'] and not result['lingering_group_at_exit'], 'managed PG helper failed: ' + mode)
                return json.loads(Path(str(prefix) + '.stdout.log').read_text())
            versions = helper('versions', {}, 'versions')
            require(versions == {'node': plan['source']['node'], 'vitest': plan['source']['vitest']}, 'Node/Vitest version mismatch')
            save(out / 'versions.json', versions)
            port = pg.create(passwords[0])
            def uri(database, role, password, application, options='-c timezone=UTC -c statement_timeout=6000 -c lock_timeout=5000'):
                value = 'postgresql://' + role + ':' + password + '@127.0.0.1:' + str(port) + '/' + database + '?' + urlencode({'application_name': application, 'options': options})
                sensitive.append(value)
                return value
            fixture_base = uri('mailflow_svtw', 'mailflow_fixture', passwords[1], 'pyws-bootstrap')
            admin_base = uri('postgres', 'mailflow_admin', passwords[0], 'fjve-admin')
            ready = helper('bootstrap', {'FJVE_ADMIN_URL': admin_base, 'FJVE_FIXTURE_URL': fixture_base,
                           'FJVE_FIXTURE_PASSWORD': passwords[1]}, 'tcp-ready', 90)
            require(ready.get('finalTcpReady') is True, 'final TCP readiness absent')
            for command in plan['commands']:
                source_guard(root, plan, env)
                database = command['database']
                admin = uri(database, 'mailflow_admin', passwords[0], 'fjve-audit')
                helper('audit', {'FJVE_ADMIN_URL': admin, 'FJVE_EXPECTED_DATABASE': database}, command['id'] + '.preflight')
                report_path = private / (command['id'] + '.native.json')
                argv = [node, '--max-old-space-size=512', 'node_modules/vitest/vitest.mjs', 'run',
                        command['file'].removeprefix('backend/'), '--maxWorkers=1', '--no-file-parallelism',
                        '--bail=1', '--no-cache', '--reporter=json', '--outputFile=' + str(report_path)]
                url = uri(database, 'mailflow_fixture', passwords[1], command['application_name_prefix'] + run_id,
                          command['startup_options'])
                record = {'id': command['id'], 'file': command['file'], 'source_sha': plan['source']['sha'],
                          'database': database, 'argv': [scrub(a, sensitive, paths) for a in argv],
                          'deadline_seconds': command['deadline_seconds'], 'expected_sql_passes': command['expected_sql_passes'],
                          'expected_duplicate_unit_passes': command['expected_duplicate_unit_passes']}
                records.append(record)
                try:
                    result = run_logged(argv, root / 'backend', {**env, 'NODE_ENV': 'test', 'MAILFLOW_TEST_DATABASE_URL': url},
                                        out / command['id'], command['deadline_seconds'], sensitive, paths)
                    record.update(result)
                    require(report_path.is_file() and report_path.stat().st_size <= 32 * 1024 * 1024, 'missing/oversized native report')
                    sanitized = scrub(report_path.read_text(), sensitive, paths)
                    (out / (command['id'] + '.native.json')).write_text(sanitized)
                    report = json.loads(sanitized)
                    assertions = [a for f in report.get('testResults', []) for a in f.get('assertionResults', [])]
                    record['assertion_counts'] = {status: sum(a.get('status') == status for a in assertions)
                        for status in ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']}
                    native_counts(report, command)
                    require(result['exit_code'] == 0 and not result['failure_kind'] and not result['lingering_group_at_exit'], 'native exit/descendant failure')
                    source_guard(root, plan, env)
                    helper('audit', {'FJVE_ADMIN_URL': admin, 'FJVE_EXPECTED_DATABASE': database}, command['id'] + '.postflight')
                    record['status'] = 'passed'
                finally:
                    if report_path.is_file() and not (out / (command['id'] + '.native.json')).exists():
                        require(report_path.stat().st_size <= 32 * 1024 * 1024, 'failed native report oversized')
                        (out / (command['id'] + '.native.json')).write_text(scrub(report_path.read_text(), sensitive, paths))
                    if 'status' not in record:
                        record['status'] = 'failed_or_incomplete'
                    save(out / (command['id'] + '.execution.json'), record)
            require(len(records) == 1 and sum(r['assertion_counts']['passed'] for r in records) == 40, 'aggregate incomplete')
        except BaseException as error:
            failure = type(error).__name__ + ': ' + scrub(str(error), sensitive, paths)
        finally:
            before = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
            try:
                try:
                    source_guard(root, plan, env)
                except BaseException as error:
                    failure = failure or ('post-source-guard: ' + type(error).__name__)
                try:
                    cleanup = pg.cleanup()
                except BaseException as error:
                    cleanup = {'errors': [type(error).__name__ + ': ' + scrub(str(error), sensitive, paths)]}
                    failure = failure or 'owned cleanup incomplete'
                if cleanup.get('errors'):
                    failure = failure or 'owned cleanup/log retrieval incomplete'
                passed = failure is None and len(records) == 1 and not cleanup.get('errors')
                save(out / 'result.json', {'status': 'passed_selected_subset' if passed else 'failed_or_incomplete',
                     'source_sha': plan['source']['sha'], 'source_tree': plan['source']['tree'], 'node_vitest': locals().get('versions'),
                     'postgres_server_version_num_required': 160015, 'completed_files': sum(r.get('status') == 'passed' for r in records),
                     'observed_native_passes': sum(r.get('assertion_counts', {}).get('passed', 0) for r in records),
                     'selected_sql_target_passes': sum(r['expected_sql_passes'] for r in records if r.get('status') == 'passed'),
                     'duplicate_unit_passes': sum(r['expected_duplicate_unit_passes'] for r in records if r.get('status') == 'passed'),
                     'separately_verified_unselected_E10_cases': 10, 'failure': failure, 'cleanup': cleanup,
                     'seconds': round(time.monotonic() - started, 3), 'retry_count': 0,
                     'not_claimed': ['all385 SQL targets', 'E10 source successor', 'full migrations', 'provider/Mini/corpus/performance']})
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                signal.pthread_sigmask(signal.SIG_SETMASK, before)
        require(failure is None, 'hosted subset failed; inspect retained artifacts, no retry')


if __name__ == '__main__':
    try:
        main()
    except Stop as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
