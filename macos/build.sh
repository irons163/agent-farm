#!/bin/bash
# Builds "Agent Farm.app" (with its own copy of Node) and a DMG, into dist/.
#
#   npm run build:mac                              Apple Silicon and Intel DMGs, signed with your
#                                                  Developer ID if the keychain has one, otherwise
#                                                  ad-hoc (then they only run on this Mac)
#   NOTARY_PROFILE=agent-farm npm run build:mac    also notarize and staple, so they open anywhere.
#                                                  Create the profile once with
#     xcrun notarytool store-credentials agent-farm --apple-id <apple-id> --team-id <team-id>
#
# One run builds one DMG: ARCH=arm64|x64|universal (default arm64). Universal is about twice the
# size (two copies of Node). Other env: NODE_VERSION, SIGN_ID (codesign identity, or "-" for ad-hoc)
# Needs Xcode or its command line tools.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

NODE_VERSION=${NODE_VERSION:-26.13.0}
ARCH=${ARCH:-arm64}
VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' package.json | head -1)
CACHE=$ROOT/macos/.cache
BUILD=$ROOT/dist/build
APP="$ROOT/dist/Agent Farm.app"
case $ARCH in arm64) KIND=AppleSilicon ;; x64) KIND=Intel ;; *) KIND=Universal ;; esac
DMG="$ROOT/dist/AgentFarm-$VERSION-macOS-$KIND.dmg"
BUNDLE_ID=io.github.irons163.agentfarm

case $ARCH in
  universal) ARCHES="arm64 x64" ;;
  arm64 | x64) ARCHES=$ARCH ;;
  *) echo "ARCH must be universal, arm64 or x64" >&2; exit 2 ;;
esac

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# official Node build, checked against nodejs.org's SHASUMS256.txt
fetch_node() {
  local name="node-v$NODE_VERSION-darwin-$1"
  if [ ! -x "$CACHE/$name/bin/node" ]; then
    mkdir -p "$CACHE"
    curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    curl -fSL --progress-bar -o "$CACHE/$name.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"
    (cd "$CACHE" && grep " $name.tar.gz\$" "SHASUMS256-$NODE_VERSION.txt" | shasum -a 256 -c -) >&2
    tar -xzf "$CACHE/$name.tar.gz" -C "$CACHE" "$name/bin/node" "$name/LICENSE"
    rm "$CACHE/$name.tar.gz"
  fi
  echo "$CACHE/$name"
}

fat() {  # fat <output> <inputs...>
  local out=$1; shift
  if [ $# -eq 1 ]; then cp "$1" "$out"; else lipo -create "$@" -output "$out"; fi
}

rm -rf "$APP" "$BUILD"
mkdir -p "$BUILD" "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

step "Node $NODE_VERSION ($ARCHES)"
NODES=()
for a in $ARCHES; do NODES+=("$(fetch_node "$a")/bin/node"); done
fat "$APP/Contents/MacOS/node" "${NODES[@]}"
cp "$(dirname "$(dirname "${NODES[0]}")")/LICENSE" "$APP/Contents/Resources/node-LICENSE.txt"
# match Node's own minimum macOS version (never below 13.5)
MINOS=$(otool -l "${NODES[0]}" | awk '/minos/ { print $2; exit }')
MINOS=$(printf '%s\n13.5\n' "${MINOS:-13.5}" | sort -V | tail -1)

step "App (macOS $MINOS+)"
BINS=()
for a in $ARCHES; do
  t=$([ "$a" = x64 ] && echo x86_64 || echo arm64)
  swiftc -O -swift-version 5 -target "$t-apple-macos$MINOS" -o "$BUILD/AgentFarm-$a" macos/AgentFarm.swift
  BINS+=("$BUILD/AgentFarm-$a")
done
fat "$APP/Contents/MacOS/AgentFarm" "${BINS[@]}"

cp -R server web hooks bin package.json LICENSE "$APP/Contents/Resources/app/"
find "$APP" -name .DS_Store -delete

step "Icon"
swift macos/make-icon.swift web/assets "$BUILD/icon.png" >/dev/null
mkdir "$BUILD/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$BUILD/icon.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agent Farm</string>
  <key>CFBundleDisplayName</key><string>Agent Farm</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>AgentFarm</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hant</string></array>
  <key>LSMinimumSystemVersion</key><string>$MINOS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>MIT License · github.com/irons163/agent-farm</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

step "Sign"
SIGN_ID=${SIGN_ID:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ { print $2; exit }')}
if [ -z "$SIGN_ID" ] || [ "$SIGN_ID" = - ]; then
  SIGN_ID=-
  TS=--timestamp=none
  echo "No Developer ID certificate: signing ad-hoc (works on this Mac only)."
else
  TS=--timestamp
  echo "Signing as: $SIGN_ID"
fi
# inside-out: Node first (V8 needs JIT under the hardened runtime), then the app
codesign --force --options runtime $TS --entitlements macos/node.entitlements --sign "$SIGN_ID" "$APP/Contents/MacOS/node"
codesign --force --options runtime $TS --sign "$SIGN_ID" "$APP"
codesign --verify --strict "$APP"

make_dmg() {
  local stage="$BUILD/dmg"
  rm -rf "$stage" "$DMG"
  mkdir -p "$stage"
  ditto "$APP" "$stage/Agent Farm.app"
  ln -s /Applications "$stage/Applications"
  hdiutil create -quiet -volname "Agent Farm" -srcfolder "$stage" -fs HFS+ -format ULMO -ov "$DMG"
  [ "$SIGN_ID" = - ] || codesign --sign "$SIGN_ID" $TS "$DMG"
}

notarize() {  # notarize <file>
  local out
  out=$(xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)
  echo "$out"
  if ! grep -q '"status":"Accepted"' <<<"$out"; then
    local id
    id=$(sed -nE 's/.*"id":"([^"]+)".*/\1/p' <<<"$out")
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE"
    exit 1
  fi
}

if [ -n "${NOTARY_PROFILE:-}" ]; then
  [ "$SIGN_ID" = - ] && { echo "Notarizing needs a Developer ID certificate." >&2; exit 1; }
  # the app first, so the copy people drag into Applications carries its own ticket (works offline)
  step "Notarize app"
  ditto -c -k --keepParent "$APP" "$BUILD/app.zip"
  notarize "$BUILD/app.zip"
  xcrun stapler staple "$APP"
  step "DMG"
  make_dmg
  step "Notarize DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  spctl -a -vv -t open --context context:primary-signature "$DMG"
else
  step "DMG"
  make_dmg
fi

rm -rf "$BUILD"
step "Done"
du -sh "$APP" "$DMG" | sed "s|$ROOT/||"
