#!/usr/bin/env python3
"""Fetch only pinned official fixtures needed by the real upgrade/rollback test."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'scripts/upstream-lock.json').read_text())
for version in ['2.21.2', '2.22.0']:
    folder = ROOT / 'build/official' / version
    archive = folder / f'libretv-{version}-standalone.tar.gz'
    folder.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        temporary = archive.with_suffix('.download')
        try:
            with urllib.request.urlopen(f'https://github.com/LibreSpark/LibreTV/releases/download/v{version}/{archive.name}', timeout=60) as source, temporary.open('wb') as target:
                shutil.copyfileobj(source, target)
            assert hashlib.sha256(temporary.read_bytes()).hexdigest() == LOCK['core'][version], 'Official archive checksum mismatch'
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == LOCK['core'][version], 'Cached archive checksum mismatch'
    destination = folder / 'Core'
    if not (destination / 'server.js').exists():
        with tarfile.open(archive, 'r:gz') as files:
            for item in files:
                relative = pathlib.PurePosixPath(item.name)
                assert not relative.is_absolute() and '..' not in relative.parts
                assert not item.issym() and not item.islnk()
                target = destination.joinpath(*relative.parts)
                if item.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif item.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with files.extractfile(item) as source, target.open('wb') as output:
                        shutil.copyfileobj(source, output)
    subprocess.run([sys.executable, str(ROOT / 'scripts/verify-upstream.py'), '--core', version], check=True)
