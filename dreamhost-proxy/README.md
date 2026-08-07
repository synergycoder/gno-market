# Betanet indexer CORS proxy (DreamHost)

Works around one specific gap: `indexer.gno.land` (gno.land betanet's
indexer) doesn't send `Access-Control-Allow-Origin` headers, so
gno.observer's own JavaScript can't query it directly from a browser
(testnet's indexer works fine as-is — this is only needed for betanet).
See the comment at the top of `gno-betanet-proxy.php` for the full
explanation.

This file is **not** part of the gno.observer static site build — it
doesn't get deployed by GitHub Pages. It's meant to be uploaded
separately to DreamHost, which can run PHP (GitHub Pages can't run any
server-side code at all).

## Deploy steps

1. In the DreamHost panel, pick any domain/subdomain already pointed at
   your hosting (a dedicated subdomain like `gno-proxy.yourdomain.com`
   keeps it cleanly separated, but any existing PHP-capable domain
   works — no special DreamHost configuration is needed, PHP runs by
   default on shared hosting).
2. Upload `gno-betanet-proxy.php` into that domain's web root via
   SFTP or the DreamHost File Manager. No dependencies, no build step —
   it's a single self-contained file.
3. Visit it once directly in a browser
   (`https://yourdomain.com/gno-betanet-proxy.php`) to sanity-check it's
   live — a GET request isn't supported, so you should see a
   `{"error":"Only POST is supported."}` JSON response (405). That
   confirms PHP is executing it, not just serving the raw source.
4. Send me the final public URL — I'll wire it into `index.html`'s
   `graphqlQuery()` so betanet's indexer calls route through it instead
   of failing on CORS, and verify it end-to-end in the browser before
   it ships.

## What it does and doesn't do

- Forwards only to `https://indexer.gno.land/graphql/query` — the
  upstream is hardcoded in the script, not something a caller can
  redirect elsewhere, so this can't be repurposed as a general-purpose
  open proxy.
- No authentication, no rate limiting beyond a request-size cap. The
  data behind it (gno.land betanet transaction history) is already
  fully public and read-only, so there's nothing sensitive to protect —
  the only real risk is someone hammering it as a denial-of-service
  vector, which a request-size cap doesn't address. If that ever
  becomes an actual problem, DreamHost's panel shows bandwidth/request
  stats per domain; a rate limit can be added then rather than
  speculatively now.
