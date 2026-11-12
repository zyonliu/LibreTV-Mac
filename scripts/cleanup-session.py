#!/usr/bin/env python3
"""Remove an explicit allowlist of disposable generated artifacts, never user data."""
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]
assert (ROOT / 'macos/Sources/LibreTVMac/LibreTVMacApp.swift').is_file()
assert json.loads((ROOT / 'package.json').read_text())['name'] == 'libretv'
paths = [ROOT / value for value in [
    '.next', 'macos/.build', 'build/previous', 'build/pkg-stage',
    'build/previous-delivery-0.1.0', 'build/previous-delivery-0.1.1', 'build/security-audit',
    'build/runtime/node-v24.16.0-darwin-arm64', 'build/runtime/node-v24.16.0-darwin-arm64.tar.gz',
    'build/LibreTV.iconset', 'build/verification-source',
    'build/official-compat-diagnostic-backup.cjs', 'build/unused-typescript.log', 'docs/reference-preview.html', 'tsconfig.tsbuildinfo',
]]
# Historical diagnostics from this session are replaced by final evidence in dist/verification.
paths += [path for path in (ROOT / 'build').iterdir() if path.is_file() and
          (path.name.startswith('verification-') or path.name.startswith('audit-'))]
removed = []
for path in paths:
    assert path.parent.resolve().is_relative_to(ROOT.resolve())
    if not path.exists() and not path.is_symlink():
        continue
    entries = list(path.rglob('*')) if path.is_dir() and not path.is_symlink() else [path]
    size = sum(entry.lstat().st_size for entry in entries if entry.is_file() and not entry.is_symlink())
    removed.append({'path': str(path.relative_to(ROOT)), 'files': sum(entry.is_file() for entry in entries), 'bytes': size})
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)
report = {'removed': removed, 'bytesRemoved': sum(value['bytes'] for value in removed),
          'preserved': ['dist/', 'build/LibreTV.app', 'build/official/', 'build/runtime/', 'build/verification-media/', 'node_modules/',
                        'all user application support, WebKit data, downloads, exports and caches outside the project']}
output = ROOT / 'dist/verification/cleanup.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'removedPaths': len(removed), 'bytesRemoved': report['bytesRemoved'], 'report': str(output)}, indent=2))
