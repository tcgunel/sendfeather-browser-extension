# Safari wrapper (macOS App Store)

Safari cannot load an unpacked extension folder the way Chrome or Firefox do. The
extension ships wrapped in a minimal macOS app generated with Xcode's
`safari-web-extension-converter`. That app is what lands on the Mac App Store; the web
extension lives inside it as an app extension (appex).

## Layout

| Path | What it is |
| --- | --- |
| `Sendfeather Email Checker/` | Generated Xcode project (app + extension targets). Fully generated — don't hand-edit. |
| `app/` | Source of truth for everything the converter can't produce. |
| `app/Main.html`, `app/Style.css` | The wrapper window shown when the app launches. |
| `app/AppIcon/master-1024.png` | Padded 1024×1024 macOS-style icon master (824 body on 1024 canvas). |
| `app/make-icon.swift` | Re-renders the master from the Sendfeather favicon SVG if branding changes. |
| `make-wrapper.sh` | Regenerates the project and re-applies all customizations. |

## Regenerate for a new extension version

```sh
./make-wrapper.sh                            # uses ../dist/sendfeather-checker-<version>-chromium.zip
./make-wrapper.sh /path/to/some.zip          # or any zip
./make-wrapper.sh /path/to/unpacked/folder   # or a folder containing manifest.json
```

Regenerating wipes the Xcode project — everything custom must live in `app/` or the
script. Re-select your Team in Signing after regeneration.

## Refresh the icon master (only when branding changes)

```sh
xcrun swift app/make-icon.swift /path/to/favicon.svg app/AppIcon/master-1024.png
```

## Run locally

1. Open `Sendfeather Email Checker/Sendfeather Email Checker.xcodeproj` and run (⌘R).
2. The app registers the extension with Safari. Enable it in Safari → Settings →
   Extensions (unsigned dev builds also need Settings → Developer → "Allow unsigned
   extensions", which resets on every Safari quit).
3. Session-only alternative: Safari → Settings → Developer → "Add Temporary
   Extension…" and pick an unpacked extension folder.

## Release to the App Store

1. Xcode → Settings → Accounts → add your Apple ID; for **both** targets set
   Signing & Capabilities → Team to your developer team (automatic signing).
2. Product → Archive → Organizer → Distribute App → App Store Connect → Upload.
3. App Store Connect: the app record exists (Apple ID `6823538630`, bundle ID
   `com.sendfeather.emailchecker`); uploads just need the build.
4. Every upload needs a higher build number:

```sh
cd "Sendfeather Email Checker"
xcrun agvtool new-version -all 2
```

## Notes

- Both `Info.plist`s declare `ITSAppUsesNonExemptEncryption = false` (the app only uses
  standard HTTPS), so uploads skip the export-compliance questionnaire.
  `make-wrapper.sh` re-applies this after every regeneration.
- Upload validation also requires `LSApplicationCategoryType` in the app Info.plist and a
  Safari manifest name of ≤ 40 characters (the store name is 42, so the wrapper copy uses
  "Sendfeather Email Checker"). `make-wrapper.sh` re-applies both after regeneration.
- Bundle-id contract: app `com.sendfeather.emailchecker`, appex
  `…emailchecker.extension`; the appex must stay prefixed by the app id or Xcode
  refuses to embed it.
- The converter writes the IDs wrong (`com.sendfeather.Sendfeather-Email-Checker` and a
  capitalised ".Extension" in Swift sources) — `make-wrapper.sh` fixes both; don't
  "repair" them by hand.
