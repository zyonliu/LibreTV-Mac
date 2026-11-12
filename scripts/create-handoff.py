#!/usr/bin/env python3
"""Package complete project source and final evidence; exclude generated and user data."""
import hashlib
import json
import os
import pathlib
import plistlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
VERSION = plistlib.loads((ROOT / 'macos/Info.plist').read_bytes())['CFBundleShortVersionString']
package = DIST / f'LibreTV-Mac-{VERSION}-Local-arm64.pkg'
assert package.is_file(), 'Build the Local PKG first'
security = json.loads((DIST / 'verification/security/summary.json').read_text())
assert security['status'] == 'passed' and security['shippedDesktop']['status'] == 'passed', 'Complete the scoped desktop audit before creating a handoff'
archive = DIST / f'LibreTV-Mac-{VERSION}-Handoff.zip'
folders = ['src', 'public', 'macos', 'scripts', 'tests', 'docs', '.github']
root_files = ['.dockerignore', '.env.example', '.gitignore', 'Dockerfile', 'LICENSE', 'README.md', 'docker-compose.yml',
              'eslint.config.mjs', 'next-env.d.ts', 'next.config.ts', 'package-lock.json', 'package.json',
              'postcss.config.mjs', 'tailwind.config.ts', 'tsconfig.json', 'vitest.config.mts']
excluded = {'.build', '__pycache__', '.DS_Store', 'reference-preview.html'}
files = [ROOT / name for name in root_files]
for name in folders:
    for directory, subdirectories, names in os.walk(ROOT / name, followlinks=False):
        subdirectories[:] = [value for value in subdirectories if value not in excluded]
        files.extend(pathlib.Path(directory) / name for name in names if name not in excluded and not name.endswith(('.pyc', '.tsbuildinfo', '.log')))
entries = {}
evidence = DIST / 'verification'
evidence_checksums = []
for file in sorted(evidence.rglob('*')):
    if file.is_file() and file.name != 'SHA256SUMS':
        assert not file.is_symlink()
        evidence_checksums.append(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.relative_to(evidence).as_posix())
(evidence / 'SHA256SUMS').write_text('\n'.join(evidence_checksums) + '\n')
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
    for file in sorted(files):
        assert file.is_file() and not file.is_symlink(), file
        relative = 'Source/' + file.relative_to(ROOT).as_posix()
        output.write(file, relative)
        entries[relative] = hashlib.sha256(file.read_bytes()).hexdigest()
    for file in sorted((DIST / 'verification').rglob('*')):
        if file.is_file():
            assert not file.is_symlink()
            relative = file.relative_to(DIST).as_posix()
            output.write(file, relative)
            entries[relative] = hashlib.sha256(file.read_bytes()).hexdigest()
    start = f'''LibreTV Mac {VERSION} 新会话交接

先读 Source/docs/HANDOFF.md、IMPLEMENTATION.md、VERIFICATION.md。
源码仓库 https://github.com/zyonliu/LibreTV-Mac，版本标签 v{VERSION}。
始终从本项目根目录执行命令；精确提交见 verification/source-publication.json。
Source/ 是完整可构建源码；verification/ 是最终验证记录。
未包含用户配置、影片、历史、凭据、node_modules、构建产物或 .git。
Local PKG 单独交付；ad-hoc app、未签名 PKG、未公证。
桌面生产/开发依赖、实际 Desktop 载荷与 Node 运行时已完成联网审计。
官方 LibreTV Core 按用户要求不纳入漏洞扫描，保持原样且可独立更新。
此包未完成正式 Developer ID、公证或干净 Mac/Gatekeeper 分发验收。
'''
    output.writestr('START-HERE.txt', start)
    entries['START-HERE.txt'] = hashlib.sha256(start.encode()).hexdigest()
    output.writestr('SOURCE-SHA256.json', json.dumps(entries, indent=2) + '\n')
with zipfile.ZipFile(archive) as check:
    assert check.testzip() is None
    for name, checksum in entries.items():
        assert hashlib.sha256(check.read(name)).hexdigest() == checksum, name
checksums = []
for file in sorted(DIST.iterdir()):
    if file.is_file() and file.name != 'SHA256SUMS':
        checksums.append(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.relative_to(DIST).as_posix())
(DIST / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
print(json.dumps({'archive': str(archive), 'sourceAndEvidenceFiles': len(entries), 'archiveBytes': archive.stat().st_size, 'checksumFiles': len(checksums)}, indent=2))
