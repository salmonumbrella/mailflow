#!/usr/bin/env python3
"""File-only v5-to-v8 bundle assembly; never invokes application/runtime tools."""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import tarfile
import tempfile

P = pathlib.Path
BASE_MANIFEST = 'f5a073143dc5d7872f25d102a3ef8a613d0941493ccd399c0af700c5d10cee45'
BASE_BUNDLE = '2b46894a8a49be67b36dbe828b620b1eb3ae9e3a9b3e7994582733d40143a8b6'
V8 = '44f26228faf45d1c88eee5cb56c7166572bb764a478162e667a0903b2f20b4ed'
ACCEPTANCE = '3fe0e3b22c5f739446e1559ca66814fa5da7e949cfe35ed41f69c440a238bef6'
OLD = 'artifacts/2026-10-21-same-app-orchestrator/source-v5/'
NEW = OLD.replace('source-v5', 'source-v8')
OLD_REVIEW = 'artifacts/2026-10-21-same-app-orchestrator/root-source-v5-accepted.json'
NEW_REVIEW = OLD_REVIEW.replace('source-v5', 'source-v8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(path.read_text())


def write(path, data):
    with path.open('x') as stream:
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-packet', type=P, required=True)
    parser.add_argument('--source-dir', type=P, required=True)
    parser.add_argument('--source-acceptance', type=P, required=True)
    parser.add_argument('--output', type=P, default=P(__file__).resolve().parent)
    args = parser.parse_args()
    base, source, out = args.base_packet, args.source_dir, args.output
    out.mkdir(parents=True, exist_ok=True)
    assert file_digest(base/'manifest.json') == BASE_MANIFEST
    base_manifest = load(base/'manifest.json')
    for name in ['bundle-index.json', 'bundle-receipt.json']:
        assert file_digest(base/name) == base_manifest['files'][name]
    receipt, index = load(base/'bundle-receipt.json'), load(base/'bundle-index.json')
    assert receipt['bundleSha256'] == BASE_BUNDLE
    assert file_digest(source/'files.json') == V8
    assert file_digest(args.source_acceptance) == ACCEPTANCE
    accepted = load(args.source_acceptance)
    assert accepted['orchestratorManifestSha256'] == V8
    assert accepted['runtimeReleased'] is False and accepted['allNinePayloadsMatch'] is True
    source_files = load(source/'files.json')
    assert len(source_files) == 9
    replacements = {NEW+name: (source/name).read_bytes() for name in source_files}
    for name, wanted in source_files.items():
        assert digest(replacements[NEW+name]) == wanted, name
    for name in ['files.json', 'freeze.json']:
        replacements[NEW+name] = (source/name).read_bytes()
    replacements[NEW_REVIEW] = args.source_acceptance.read_bytes()
    assert load(source/'freeze.json')['manifest']['sha256'] == V8

    def renamed(name):
        return NEW+name[len(OLD):] if name.startswith(OLD) else NEW_REVIEW if name == OLD_REVIEW else name

    records = {renamed(name): dict(record) for name, record in index['files'].items()}
    assert len(records) == len(index['files'])
    assert set(replacements) <= set(records)
    changed = []
    for name, data in replacements.items():
        record = records[name]
        if digest(data) != record['sha256']:
            changed.append(name)
        record.update(sha256=digest(data), bytes=len(data))
    assert sorted(n for n in source_files if records[NEW+n]['sha256'] != index['files'][OLD+n]['sha256']) == ['bootstrap.mjs', 'runtime.mjs']
    new_index = dict(index, files=records)
    write(out/'bundle-index.json', new_index)

    # Reconstruct only into an unnamed temporary file; no archive is extracted.
    with tempfile.TemporaryFile() as old_archive:
        combined = hashlib.sha256()
        size = 0
        for name, chunk in receipt['chunks'].items():
            assert file_digest(base/name) == chunk['sha256']
            assert (base/name).stat().st_size == chunk['bytes']
            with (base/name).open('rb') as stream:
                for block in iter(lambda: stream.read(1024*1024), b''):
                    old_archive.write(block)
                    combined.update(block)
                    size += len(block)
        assert combined.hexdigest() == BASE_BUNDLE and size == receipt['bundleBytes']
        old_archive.seek(0)
        seen, order = set(), []
        with tarfile.open(fileobj=old_archive, mode='r:gz') as old_tar, (out/'bundle.tar.gz').open('xb') as archive:
            with gzip.GzipFile(filename='', mode='wb', compresslevel=1, fileobj=archive, mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode='w|', format=tarfile.PAX_FORMAT) as new_tar:
                    for item in old_tar:
                        name = item.name
                        assert not P(name).is_absolute() and '..' not in P(name).parts
                        assert name not in seen
                        seen.add(name)
                        new_name = renamed(name)
                        header = tarfile.TarInfo(new_name)
                        header.mtime = 0
                        if item.issym():
                            assert index['links'][name] == item.linkname and item.mode == 0o777
                            header.type, header.linkname, header.mode = tarfile.SYMTYPE, item.linkname, 0o777
                            new_tar.addfile(header)
                        else:
                            record = index['files'][name]
                            assert item.isfile() and item.size == record['bytes'] and item.mode == record['mode']
                            data = old_tar.extractfile(item).read()
                            assert digest(data) == record['sha256'], name
                            data = replacements.get(new_name, data)
                            header.size, header.mode = len(data), records[new_name]['mode']
                            new_tar.addfile(header, io.BytesIO(data))
                            order.append(new_name)
        assert seen == set(index['files']) | set(index['links'])
        assert order == sorted(records)

    chunks = {}
    with (out/'bundle.tar.gz').open('rb') as stream:
        for number, data in enumerate(iter(lambda: stream.read(40*1024*1024), b'')):
            sha256 = digest(data)
            name = f'bundle.part-{number:03}-{sha256}'
            with (out/name).open('xb') as chunk:
                chunk.write(data)
            chunks[name] = {'sha256': sha256, 'bytes': len(data)}
    result = dict(receipt, bundleSha256=file_digest(out/'bundle.tar.gz'),
                  bundleBytes=(out/'bundle.tar.gz').stat().st_size,
                  indexSha256=file_digest(out/'bundle-index.json'), chunks=chunks)
    write(out/'bundle-receipt.json', result)
    assert new_index['links'] == index['links']
    unchanged = [n for n in index['files'] if renamed(n) == n]
    assert all(records[n] == index['files'][n] for n in unchanged)
    write(out/'bundle-provenance.json', {
        'basePacketManifestSha256': BASE_MANIFEST, 'baseBundleSha256': BASE_BUNDLE,
        'sourceV8ManifestSha256': V8, 'rootSourceAcceptanceSha256': ACCEPTANCE,
        'replacementMembers': sorted(replacements), 'changedMemberBytes': sorted(changed),
        'unchangedRegularFiles': len(unchanged), 'unchangedLinks': len(index['links']),
        'allUnchangedFilesRehashedAgainstBase': True, 'allModesPreserved': True,
        'archiveExtracted': False, 'runtimeExecuted': False,
        'sourceCommit': index['sourceCommit'], 'sourceTree': index['sourceTree']})
    print(json.dumps({'bundleSha256': result['bundleSha256'], 'bytes': result['bundleBytes'],
                      'regularFiles': len(records), 'links': len(index['links']), 'chunks': len(chunks)}))


if __name__ == '__main__':
    main()
