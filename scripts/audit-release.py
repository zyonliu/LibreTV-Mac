#!/usr/bin/env python3
"""Verify a Local release's contents, signatures, SDK, architecture and core bytes."""
import argparse
import hashlib
import json
import pathlib
import plistlib
import re
import stat
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr.strip()}')
    return (result.stdout + result.stderr).strip()

def manifest(app):
    result = {}
    for file in sorted(app.rglob('*')):
        relative = file.relative_to(app).as_posix()
        mode = file.lstat().st_mode
        if mode & (stat.S_ISUID | stat.S_ISGID) or mode & stat.S_IWOTH:
            raise ValueError(f'Unsafe file permissions: {relative}')
        if file.is_symlink():
            if not file.resolve().is_relative_to(app.resolve()):
                raise ValueError(f'External symlink: {relative}')
            result[relative] = {'link': str(file.readlink())}
        elif file.is_file():
            result[relative] = {'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes': file.stat().st_size}
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--compare-manifest', type=pathlib.Path)
    args = parser.parse_args()
    app = args.app.resolve()
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'org.libretv.mac.local'
    assert info['LSMinimumSystemVersion'] == '14.0'
    signature = run('/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app))
    signing = run('/usr/bin/codesign', '-d', '--verbose=4', str(app))
    assert 'Signature=adhoc' in signing, 'This script builds only the approved Local variant'
    executables = {}
    for relative in ['Contents/MacOS/LibreTVMac', 'Contents/Resources/Runtime/node']:
        file = app / relative
        architecture = run('/usr/bin/lipo', '-archs', str(file))
        assert architecture == 'arm64', f'Unexpected architecture: {architecture}'
        libraries = run('/usr/bin/otool', '-L', str(file)).splitlines()[1:]
        assert all(line.strip().startswith(('/System/Library/', '/usr/lib/', '@rpath/')) for line in libraries), libraries
        load_commands = run('/usr/bin/otool', '-l', str(file))
        versions = re.search(r'cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([\d.]+)\s+sdk ([\d.]+)', load_commands)
        assert versions, 'Missing SDK load command'
        if relative.endswith('LibreTVMac'):
            assert versions[1] == '14.0'
            assert int(versions[2].split('.')[0]) >= 26, 'Native glass requires linking with a recent macOS SDK'
        assert tuple(int(value) for value in versions[1].split('.')[:2]) <= (14, 0), 'Bundled executable requires a newer OS than the declared minimum'
        executables[relative] = {'architecture': architecture, 'minimumOS': versions[1], 'linkedSDK': versions[2], 'libraries': [line.strip() for line in libraries]}
    node = app / 'Contents/Resources/Runtime/node'
    run('/usr/bin/codesign', '--verify', '--strict', str(node))
    node_version = json.loads((ROOT / 'scripts/runtime-config.json').read_text())['nodeVersion']
    assert run(str(node), '--version') == 'v' + node_version
    assert (ROOT / 'scripts/runtime-config.json').read_bytes() == (app / 'Contents/Resources/Runtime/runtime-config.json').read_bytes()
    assert (ROOT / 'package-lock.json').read_bytes() == (app / 'Contents/Resources/Desktop/desktop-package-lock.json').read_bytes()
    for source in (ROOT / 'macos/Runtime').glob('*.cjs'):
        assert source.read_bytes() == (app / 'Contents/Resources/Runtime' / source.name).read_bytes(), f'Stale runtime adapter: {source.name}'
    assert (ROOT / 'macos/Resources/desktop-bootstrap.js').read_bytes() == (app / 'Contents/Resources/desktop-bootstrap.js').read_bytes()
    assert (ROOT / 'macos/Info.plist').read_bytes() == (app / 'Contents/Info.plist').read_bytes()
    core = app / 'Contents/Resources/Core'
    core_version = json.loads((core / 'package.json').read_text())['version']
    cached = ROOT / 'build/official' / core_version / 'Core'
    upstream = manifest(cached)
    assert manifest(core) == upstream, 'Bundled official core is not byte-identical to verified upstream'
    files = manifest(app)
    if args.compare_manifest:
        assert files == json.loads(args.compare_manifest.read_text()), 'Expanded PKG payload differs from the signed build'
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'app-manifest.json').write_text(json.dumps(files, indent=2) + '\n')
    report = {'status': 'passed', 'appVersion': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
              'signature': 'ad-hoc', 'notarized': False, 'distribution': 'Local arm64 only',
              'signatureVerification': signature, 'executables': executables,
              'officialCore': {'version': core_version, 'filesVerified': len(upstream), 'unchanged': True, 'vulnerabilityAudit': 'outside user-requested scope'},
              'manifestFiles': len(files), 'payloadMatchesBuild': bool(args.compare_manifest),
              'dependencyVulnerabilityScan': 'separate result; not implied by this integrity audit'}
    (args.output / 'integrity.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (AssertionError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
