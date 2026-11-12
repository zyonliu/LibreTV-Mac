#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ROOT="$PWD"
APP_PATH="$PROJECT_ROOT/build/LibreTV.app"
DIST_PATH="$PROJECT_ROOT/dist"
WORK_PATH="$PROJECT_ROOT/build/pkg-stage"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
NAME="LibreTV-Mac-$VERSION-Local-arm64"
mkdir -p "$DIST_PATH/verification" "$WORK_PATH/root/Applications" "$WORK_PATH/packages"
if [ -e "$WORK_PATH/root/Applications/LibreTV.app" ]; then
  echo "Remove the previous generated build/pkg-stage before packaging again." >&2
  exit 1
fi
NODE_VERSION="$(python3 -c 'import json;print(json.load(open("scripts/runtime-config.json"))["nodeVersion"])')"
CORE_VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
python3 scripts/verify-upstream.py --core "$CORE_VERSION" --node-version "$NODE_VERSION" --arch arm64 > "$DIST_PATH/verification/upstream.json"
python3 scripts/audit-release.py "$APP_PATH" --output "$DIST_PATH/verification/build" > "$DIST_PATH/verification/integrity-build.log"
"$APP_PATH/Contents/Resources/Runtime/node" scripts/audit-desktop.mjs --bundle "$APP_PATH" --output "$DIST_PATH/verification/security" > "$DIST_PATH/verification/dependency-audit.log"
ditto "$APP_PATH" "$WORK_PATH/root/Applications/LibreTV.app"
pkgbuild --analyze --root "$WORK_PATH/root" "$WORK_PATH/components.plist"
python3 - "$WORK_PATH/components.plist" "$WORK_PATH/requirements.plist" <<'PY'
import pathlib, plistlib, sys
components = pathlib.Path(sys.argv[1])
values = plistlib.loads(components.read_bytes())
for value in values:
    value['BundleIsRelocatable'] = False
    value['BundleIsVersionChecked'] = True
    value['BundleHasStrictIdentifier'] = True
components.write_bytes(plistlib.dumps(values))
pathlib.Path(sys.argv[2]).write_bytes(plistlib.dumps({'os': ['14.0'], 'arch': ['arm64']}))
PY
pkgbuild --root "$WORK_PATH/root" --component-plist "$WORK_PATH/components.plist" --identifier org.libretv.mac.local.pkg --version "$VERSION" --install-location / --ownership recommended "$WORK_PATH/packages/$NAME-component.pkg"
productbuild --synthesize --product "$WORK_PATH/requirements.plist" --package "$WORK_PATH/packages/$NAME-component.pkg" "$WORK_PATH/Distribution.xml"
python3 - "$WORK_PATH/Distribution.xml" <<'PY'
import pathlib, sys, xml.etree.ElementTree as ET
file = pathlib.Path(sys.argv[1])
tree = ET.parse(file)
root = tree.getroot()
ET.SubElement(root, 'title').text = 'LibreTV Mac 本地版'
ET.SubElement(root, 'welcome', {'file': 'Welcome.html', 'mime-type': 'text/html'})
ET.SubElement(root, 'readme', {'file': 'ReadMe.html', 'mime-type': 'text/html'})
options = root.find('options')
if options is not None:
    options.set('customize', 'never')
tree.write(file, encoding='utf-8', xml_declaration=True)
PY
productbuild --distribution "$WORK_PATH/Distribution.xml" --package-path "$WORK_PATH/packages" --resources "$PROJECT_ROOT/scripts/pkg" "$DIST_PATH/$NAME.pkg"
pkgutil --expand-full "$DIST_PATH/$NAME.pkg" "$WORK_PATH/expanded"
PAYLOAD_APP="$WORK_PATH/expanded/$NAME-component.pkg/Payload/Applications/LibreTV.app"
python3 scripts/audit-release.py "$PAYLOAD_APP" --compare-manifest "$DIST_PATH/verification/build/app-manifest.json" --output "$DIST_PATH/verification/pkg-payload" > "$DIST_PATH/verification/integrity-payload.log"
# An unsigned installer is intentional for the user's approved Local delivery.
pkgutil --check-signature "$DIST_PATH/$NAME.pkg" > "$DIST_PATH/verification/pkg-signature.txt" 2>&1 || true
python3 - "$DIST_PATH/verification/pkg-signature.txt" <<'PY'
import pathlib, sys
assert 'no signature' in pathlib.Path(sys.argv[1]).read_text(), 'Unexpected PKG signing status'
PY
cp "$WORK_PATH/Distribution.xml" "$WORK_PATH/components.plist" "$DIST_PATH/verification/"
printf '%s\n' "$PAYLOAD_APP/Contents/Resources" > "$WORK_PATH/payload-resources.txt"
echo "Verified Local PKG: $DIST_PATH/$NAME.pkg"
