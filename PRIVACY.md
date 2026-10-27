# Privacy — Sendfeather browser extension

The extension runs DNS lookups for the domain you check. Queries go directly
from your browser to public DNS-over-HTTPS resolvers — Cloudflare's
(`cloudflare-dns.com`) first, Google's (`dns.google`) as a fallback. Nothing
is sent to Sendfeather or to anyone else, and nothing is stored: no accounts,
no analytics, no telemetry, no cookies.

## What it asks for, and why

- **`activeTab`** — reads the current tab's address only at the moment you
  open the popup, to prefill the domain box. It cannot read page content,
  and the access ends when the popup closes.
- **Host access to `cloudflare-dns.com` and `dns.google`** — these two
  endpoints are the only network requests the extension can make.

## Contact

info@sendfeather.com
