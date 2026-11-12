#!/usr/bin/env python3
"""Verify pinned upstream archives and every byte copied from them, without changing the caches."""
import argparse
import hashlib
import json
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'scripts/upstream-lock.json').read_text())

def digest(stream):
    value = hashlib.sha256()
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            return value.hexdigest()
        value.update(chunk)

def checked_archive(file, expected):
    with file.open('rb') as stream:
        actual = digest(stream)
    if actual != expected:
        raise ValueError(f'Archive SHA-256 mismatch: {file.name}')
    return actual

def verify_core(version):
    directory = ROOT / 'build/official' / version
    archive = directory / f'libretv-{version}-standalone.tar.gz'
    checksum = checked_archive(archive, LOCK['core'][version])
    target = directory / 'Core'
    expected = set()
    with tarfile.open(archive, 'r:gz') as files:
        for item in files:
            relative = pathlib.PurePosixPath(item.name)
            if relative.is_absolute() or '..' in relative.parts or item.issym() or item.islnk():
                raise ValueError('Unsafe official archive member')
            if not item.isfile():
                continue
            expected.add(str(relative))
            installed = target.joinpath(*relative.parts)
            if installed.is_symlink() or not installed.is_file():
                raise ValueError(f'Missing official file: {relative}')
            with files.extractfile(item) as source, installed.open('rb') as actual:
                if digest(source) != digest(actual):
                    raise ValueError(f'Official cache file changed: {relative}')
    actual = {p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file()}
    if actual != expected:
        raise ValueError(f'Unexpected files in official core {version}')
    return {'version': version, 'archiveSHA256': checksum, 'filesVerified': len(expected)}

def verify_node(version, arch):
    name = f'node-v{version}-darwin-{arch}'
    archive = ROOT / 'build/runtime' / (name + '.tar.gz')
    checksum = checked_archive(archive, LOCK['node'][archive.name])
    binary = ROOT / 'build/runtime' / name / 'bin/node'
    with tarfile.open(archive, 'r:gz') as files, binary.open('rb') as actual:
        with files.extractfile(name + '/bin/node') as source:
            expected = digest(source)
            if digest(actual) != expected:
                raise ValueError('Cached Node executable differs from the pinned archive')
    return {'version': version, 'arch': arch, 'archiveSHA256': checksum, 'sourceBinarySHA256': expected}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--core', action='append', default=[])
    parser.add_argument('--node-version')
    parser.add_argument('--arch', default='arm64')
    parser.add_argument('--archive', type=pathlib.Path)
    parser.add_argument('--pin-group', choices=['node', 'core'])
    parser.add_argument('--pin-key')
    args = parser.parse_args()
    report = {'core': [verify_core(version) for version in args.core]}
    if args.archive:
        if not args.pin_group or not args.pin_key:
            parser.error('--archive requires --pin-group and --pin-key')
        report['archiveSHA256'] = checked_archive(args.archive, LOCK[args.pin_group][args.pin_key])
    if args.node_version:
        report['node'] = verify_node(args.node_version, args.arch)
    print(json.dumps(report, indent=2))
