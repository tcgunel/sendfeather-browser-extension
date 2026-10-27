# Sendfeather — browser extension (email deliverability checker)

Development home of the **Sendfeather** browser extension (Manifest V3,
Chrome + Firefox): the popup checks the active tab's domain — or any domain
you type — for MX, SPF, DKIM and DMARC records and explains each verdict in
plain language.

The extension is a thin window onto the same check engine as
[sendfeather.com/tools/email-checker](https://sendfeather.com/tools/email-checker):
it queries public DNS-over-HTTPS resolvers (Cloudflare, falling back to
Google) directly from the browser. Nothing is sent to Sendfeather, there is
no analytics or telemetry, and nothing is stored — see `PRIVACY.md`.

The extension ships on the Chrome Web Store and Firefox Add-ons (submissions
pending at the time of writing), with Edge and Opera kits ready in `store/`
and the Mac App Store version wrapped in `safari/`. This repository is where
the extension is developed and released from. The Sendfeather platform itself
is a separate, private repository — the extension does not depend on it at all.

## Layout

```
manifest.json         MV3 manifest (Chrome + Firefox)
popup.html/.css/.js   The popup and its orchestration
checks.js             Check engine — MX/SPF/DKIM/DMARC verdicts over DoH
icons/                Action icons (16/32/48/128)
store/                Store listing kit for all platforms
safari/               macOS wrapper for the Mac App Store (see safari/README.md)
test/                 Node test suite + Chrome smoke test
PRIVACY.md            Privacy note (store listing + reviewer reference)
```

## Load unpacked

- **Chrome**: `chrome://extensions` → Developer mode → *Load unpacked* →
  this folder.
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on* → `manifest.json`. (Firefox 115+; MV3.)

Click the toolbar icon, type a domain (or accept the prefilled one) and
press *Check*.

## Tests

```sh
npm test                      # unit tests (stubbed DoH) + live smoke checks
node test/chrome-smoke.mjs    # load into scratch headless Chrome, run the
                              # popup end-to-end, capture a screenshot
npx web-ext lint --source-dir .   # Firefox compatibility lint
```

The unit tests stub the DoH endpoints for the verdict cases (multi-record
SPF/DMARC, null MX, revoked DKIM key, p=none, resolver down) and then run
two live checks against real DNS.

## Packaging

The store zip contains only the runtime files:

```sh
zip -r dist/sendfeather-checker-1.0.0.zip \
  manifest.json popup.html popup.css popup.js checks.js icons
```

For Edge and Opera, `dist/sendfeather-checker-1.0.0-chromium.zip` is the same
package with the Firefox-only `browser_specific_settings` block removed
(Opera's acceptance criteria disallow unnecessary manifest entries).

## License

GPL-2.0-or-later — same license as the Sendfeather WordPress plugin.
