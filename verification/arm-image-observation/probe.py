"""Observe three pinned official ARM images; creates no containers or services."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
EXPECTED = '2e8d94aa521bcbce83f4b7645aeeec90ac3abc0d6881fe72a58ca62f0720ba55'

def main():
    output = Path(sys.argv[1])
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    result = {'kind': 'PINNED_PUBLIC_IMAGE_METADATA_ONLY', 'appAccepted': False,
              'containersCreated': False, 'images': {}, 'errorType': None}
    try:
        assert os.environ.get('GITHUB_REPOSITORY') == 'salmonumbrella/mailflow'
        assert os.environ.get('GITHUB_RUN_ATTEMPT') == '1'
        assert platform.system() == 'Linux' and platform.machine() == 'aarch64'
        assert hashlib.sha256((HERE/'images.json').read_bytes()).hexdigest() == EXPECTED
        specs = json.loads((HERE/'images.json').read_text())['images']
        assert set(specs) == {'node', 'postgres', 'redis'}
        with tempfile.TemporaryDirectory(prefix='arm-image-observation-') as temporary:
            private = Path(temporary)
            (private/'home').mkdir()
            (private/'docker').mkdir()
            env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                   'HOME': str(private/'home'), 'DOCKER_CONFIG': str(private/'docker'),
                   'LANG': 'C.UTF-8'}
            executable = Path(shutil.which('docker', path=env['PATH'])).resolve(strict=True)
            socket = Path('/var/run/docker.sock').resolve(strict=True)
            prefix = [str(executable), '--host', 'unix://'+str(socket)]
            for name, spec in specs.items():
                pulled = subprocess.run(prefix+['pull', '--platform', 'linux/arm64', spec['pullRef']],
                                        env=env, capture_output=True, timeout=180)
                assert pulled.returncode == 0
                inspected = subprocess.run(prefix+['image', 'inspect', spec['pullRef']],
                                           env=env, capture_output=True, timeout=30)
                assert inspected.returncode == 0
                item = json.loads(inspected.stdout)[0]
                keys = {value.partition('=')[0] for value in spec['versionEnvironment']}
                actual = {'imageId': item['Id'], 'repoDigests': item['RepoDigests'],
                          'os': item['Os'], 'architecture': item['Architecture'],
                          'rootfsDiffIds': item['RootFS']['Layers'],
                          'versionEnvironment': [value for value in item['Config']['Env']
                                                 if value.partition('=')[0] in keys]}
                checks = {'idAsCurrentlyRequired': item['Id'] in [spec['configDigest'], spec['armManifestDigest']],
                          'platform': item['Os'] == 'linux' and item['Architecture'] == 'arm64',
                          'rootfsDiffIds': item['RootFS']['Layers'] == spec['rootfsDiffIds'],
                          'repoDigestAsCurrentlyRequired': spec['pullRef'].replace('docker.io/', '') in
                              [value.replace('docker.io/', '') for value in item['RepoDigests']],
                          'versionEnvironment': all(value in item['Config']['Env'] for value in spec['versionEnvironment'])}
                result['images'][name] = {'requestedImmutablePullRef': spec['pullRef'],
                                         'expected': spec, 'observed': actual, 'checks': checks}
    except Exception as error:
        # No raw daemon output, inherited credentials or private host paths.
        result['errorType'] = type(error).__name__
    result['allCurrentChecksMatch'] = (result['errorType'] is None and len(result['images']) == 3 and
        all(all(record['checks'].values()) for record in result['images'].values()))
    (output/'image-observations.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({'kind': result['kind'], 'observedImages': len(result['images']),
                      'allCurrentChecksMatch': result['allCurrentChecksMatch'],
                      'errorType': result['errorType'], 'appAccepted': False}))
    return 0 if result['allCurrentChecksMatch'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
