#!/usr/bin/env bash
#
# Regenerate the Safari wrapper app (macOS) from a packaged extension build.
#
# The project under "Sendfeather Email Checker/" is fully generated — do not edit it by
# hand. Everything that must survive regeneration lives in app/ and is re-applied here:
# bundle identifiers, version stamp, window content, icons.
#
# Usage:
#   ./make-wrapper.sh [extension.zip | extension-folder]
#
# Without an argument it packages from ../dist/sendfeather-checker-<version>-chromium.zip
# where <version> comes from ../manifest.json.
set -euo pipefail

cd "$(dirname "$0")"
SAFARI_DIR="$PWD"
REPO_DIR="$(cd .. && pwd)"
APP_NAME="Sendfeather Email Checker"
PROJECT_DIR="$SAFARI_DIR/$APP_NAME"
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/manifest.json" | head -1)
[ -n "$VERSION" ] || { echo "error: could not read version from $REPO_DIR/manifest.json" >&2; exit 1; }

INPUT="${1:-$REPO_DIR/dist/sendfeather-checker-${VERSION}-chromium.zip}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Unpack the extension.
EXT_DIR="$WORK/ext"
if [ -d "$INPUT" ]; then
    cp -R "$INPUT" "$EXT_DIR"
elif [ -f "$INPUT" ]; then
    mkdir -p "$EXT_DIR"
    unzip -q -o "$INPUT" -d "$EXT_DIR"
else
    echo "error: no such file or folder: $INPUT" >&2
    exit 1
fi

# 2. Generate the project.
rm -rf "$PROJECT_DIR"
xcrun safari-web-extension-converter "$EXT_DIR" \
    --project-location "$SAFARI_DIR" \
    --app-name "$APP_NAME" \
    --bundle-identifier com.sendfeather.emailchecker \
    --macos-only --copy-resources --no-open --no-prompt

# 3. Fix the converter quirks. It writes the app id as com.sendfeather.<App-Name> and
#    capitalises ".Extension" in Swift sources; Safari requires the appex id to be a
#    strict prefix extension of the app id (com.sendfeather.emailchecker.extension).
PBXPROJ="$PROJECT_DIR/$APP_NAME.xcodeproj/project.pbxproj"
sed -i '' \
    -e 's/com\.sendfeather\.Sendfeather-Email-Checker/com.sendfeather.emailchecker/g' \
    -e 's/com\.sendfeather\.emailchecker\.Extension/com.sendfeather.emailchecker.extension/g' \
    -e "s/MARKETING_VERSION = 1.0;/MARKETING_VERSION = $VERSION;/g" \
    -e 's/"CODE_SIGN_IDENTITY\[sdk=macosx\*\]" = "-";/"CODE_SIGN_IDENTITY[sdk=macosx*]" = "Apple Development";/g' \
    "$PBXPROJ"
sed -i '' 's/com\.sendfeather\.emailchecker\.Extension/com.sendfeather.emailchecker.extension/g' \
    "$PROJECT_DIR/$APP_NAME/ViewController.swift"

# 3b. Declare that the app uses no non-exempt encryption (standard HTTPS only), so
#     App Store Connect skips the export-compliance questionnaire at upload.
for PLIST in "$PROJECT_DIR/$APP_NAME/Info.plist" "$PROJECT_DIR/$APP_NAME Extension/Info.plist"; do
    /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$PLIST"
done

# 3c. App Store upload validations. The app Info.plist needs a category UTI
#     (asc - Developer Tools); Safari rejects extension manifest names longer
#     than 40 characters, so the wrapper copy uses the app name (25 chars).
APP_PLIST="$PROJECT_DIR/$APP_NAME/Info.plist"
/usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.developer-tools" "$APP_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :LSApplicationCategoryType public.app-category.developer-tools" "$APP_PLIST"
python3 - "$PROJECT_DIR/$APP_NAME Extension/Resources/manifest.json" <<'PY'
import json, sys

with open(sys.argv[1]) as f:
    manifest = json.load(f)
manifest["name"] = "Sendfeather Email Checker"
with open(sys.argv[1], "w") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

# 4. Apply the branding from app/.
cp "$SAFARI_DIR/app/Main.html" "$PROJECT_DIR/$APP_NAME/Resources/Base.lproj/Main.html"
cp "$SAFARI_DIR/app/Style.css" "$PROJECT_DIR/$APP_NAME/Resources/Style.css"

ICONSET="$PROJECT_DIR/$APP_NAME/Assets.xcassets/AppIcon.appiconset"
MASTER="$SAFARI_DIR/app/AppIcon/master-1024.png"
render() { sips -z "$1" "$1" "$MASTER" --out "$2" >/dev/null; }
render 16   "$ICONSET/mac-icon-16@1x.png"
render 32   "$ICONSET/mac-icon-16@2x.png"
render 32   "$ICONSET/mac-icon-32@1x.png"
render 64   "$ICONSET/mac-icon-32@2x.png"
render 128  "$ICONSET/mac-icon-128@1x.png"
render 256  "$ICONSET/mac-icon-128@2x.png"
render 256  "$ICONSET/mac-icon-256@1x.png"
render 512  "$ICONSET/mac-icon-256@2x.png"
render 512  "$ICONSET/mac-icon-512@1x.png"
cp "$MASTER" "$ICONSET/mac-icon-512@2x.png"
render 128 "$PROJECT_DIR/$APP_NAME/Resources/Icon.png"

echo "wrapper regenerated for extension v$VERSION:"
echo "  $PROJECT_DIR/$APP_NAME.xcodeproj"
echo "next: open in Xcode, select your Team for both targets, then run"
