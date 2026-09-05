<div align="center">

# Edge Error Pages

**Your branded error page, served from Cloudflare's edge — so it still shows up
when your server is completely down.**

Multi-tenant · any domain · any language · RTL-aware

</div>

---

## The problem

When a site goes down, visitors do not see the site. They see the CDN's default
screen — for Cloudflare, a grey page reading *"Web server is down — Error 521"*,
carrying someone else's branding.

It is the moment a customer is most likely to conclude the product is broken,
and it is the one moment the product has no say in what they read.

A normal error page cannot fix this. It lives on the server, so it covers only
the errors the server is alive to answer. It cannot speak for the server's own
death.

## The fix

Put the page one hop earlier — at the edge.

```
Visitor  →  Cloudflare edge  →  your server
                  ↑
        this worker: passes everything through,
        and answers itself only when the server cannot
```

A Worker sits on the route, forwards every request untouched, and produces a
response of its own **only** when the origin is unreachable. One deployment
serves any number of domains, each with its own branding, language and palette.

| Situation | What the visitor gets |
| --- | --- |
| Origin healthy | the real response, untouched — the worker adds nothing |
| Deploy in progress (proxy up, app down) | the proxy's own branded 503, passed through |
| **Server down, rebooting, or gone** | **the branded page, code 521** |
| Connect timeout / TLS failure | the same page, codes 522 / 525 |
| `/api/`, webhooks, any JSON route | a JSON body instead, so callers do not choke on HTML |
| WebSocket upgrade | a bodiless 503, so the client's reconnect loop takes over |

Every page prints its status code, so a report becomes *"I got 502"* instead of
*"the site is broken"*. The "wait it out" codes poll the site and reload
themselves the moment it answers — nobody sits pressing refresh.

---

## Quick start

```bash
npm install
npm run build     # generate the pages, worker.js and wrangler.toml
npm test          # 12 cases against a stubbed origin failure
npm run deploy    # publish to Cloudflare
```

The first deploy opens a browser to log in to Cloudflare. Nothing else is
needed: the routes come from your config.

---

## Adding a site

Sites are data, not code. One entry in `sites.config.json` is one customer:

```json
{
  "id": "acme",
  "hostnames": ["acme.com", "www.acme.com"],
  "zone": "acme.com",
  "locale": "en",
  "brand": { "name": "Acme", "wordmark": "ACME" },
  "colors": {
    "bgFrom": "#0b1020", "bgTo": "#111a3a",
    "primary": "#2563eb", "accent": "#22d3ee",
    "warning": "#f59e0b", "destructive": "#ef4444"
  },
  "healthPath": "/health",
  "jsonPrefixes": ["/api/"]
}
```

Then `npm run deploy`. The build derives everything from that entry: a static
page for the site, the worker bundle keyed by its hostnames, and the Cloudflare
routes. There is no template to copy and no route to remember.

Requests are branded by the host they arrive on, and an unlisted subdomain falls
back to its parent domain before it falls back to `defaultSite` — so
`staging.acme.com` is already Acme without being listed.

### What a site can control

| Key | Effect |
| --- | --- |
| `hostnames`, `zone` | which domains this branding answers for, and the Cloudflare zone the routes are added to |
| `locale`, `secondaryLocale` | which language leads and which is echoed underneath. **RTL is detected from the locale** — layout, mirroring and animation direction follow |
| `brand.name`, `brand.nameEn`, `brand.names` | the name inside the copy, per language |
| `brand.wordmark` | the mark in the page footer |
| `colors` | the whole palette. Background, glow, buttons and the three error tones are derived from it with `color-mix` |
| `font.stack`, `font.latinStack`, `font.googleFonts` | typography. The font stylesheet is the page's only external request |
| `healthPath` | what the "wait" pages poll to know the site is back |
| `jsonPrefixes` | routes whose callers must receive JSON, never a web page |
| `messages` | per-status copy overrides, merged key by key over the shared catalogue |
| `staticOutDir` | also write the page where the site's own web server serves it (see below) |

Copy for every status lives in `messages.json`, in Arabic and English, with
`{brand}` interpolated per language. The page's own furniture — buttons,
countdown, labels — lives in `ui.json`. **A new language is a key in both.**

---

## Serving it from your own server too

The same generated page is worth serving twice, and the two layers do not
overlap:

1. **Your web server** answers the errors it is alive to answer — a bad request,
   an oversized upload, or an app restart behind the proxy while the proxy
   itself stays up.
2. **This worker** answers the errors your server cannot answer at all.

Point `staticOutDir` at wherever your server looks, and the build drops the page
there on every run. For nginx, that means a `root` and a handful of
`error_page` directives:

```nginx
error_page 502 504 =503 /__error.html?code=502;
error_page 500 /__error.html?code=500;

location = /__error.html {
    root /var/www/error-pages;
    rewrite ^ /error.html break;
    internal;
    # The query string is an internal redirect the browser never sees, so the
    # code is injected into the page instead.
    sub_filter '__CODE__' '$arg_code';
    sub_filter_once off;
    add_header Retry-After 30 always;
}
```

Keep `proxy_intercept_errors` **off**, so these fire only for errors nginx
itself produces and your app keeps its own 404 and 500 pages.

The visitor sees one page either way. The code on it tells the two apart.

---

## Before your first deploy

**Every request to the zone will run through the worker.** Cloudflare cannot
invoke a Worker "only on failure", so it has to sit on the route and see all
traffic. That is the trade this design makes, and it has consequences worth
knowing up front:

- **The free plan caps you at 100,000 requests/day** and rejects the rest —
  which would turn a net for a rare outage into an outage of its own. Check your
  zone's daily request count first; if it is anywhere near the cap, move to
  Workers Paid ($5/month, 10M requests) before adding the route.
- **A Worker bundle must stay under 1 MB** — roughly 40 sites' pages. The build
  warns as it approaches.
- **Your DNS records must be proxied** (orange cloud). A grey-clouded record
  bypasses the edge entirely, worker and all.

---

## Continuous deployment

Connect the repository once and every later edit ships by pushing it —
**Cloudflare dashboard → Workers & Pages → Create → Continue with GitHub**:

| Field | Value |
| --- | --- |
| Production branch | `master` |
| Root directory | `/` *(or the path to this package inside a monorepo)* |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler deploy` |

The build command stays empty because `wrangler.toml` carries
`[build] command = "node build.mjs"` — wrangler regenerates the pages before it
uploads, so what is deployed can never drift from what is in the repository.

`npx wrangler tail` streams what the live worker is doing.

---

## Project layout

```
sites.config.json     the sites — hostnames, brand, colours, routes
messages.json         status copy, per language, with {brand} interpolated
ui.json               buttons, countdown and labels, per language
templates/error.html  one page for every site; the build stamps the tokens in
templates/error.json  the JSON body for API routes
runtime.js            the worker's logic — edit this, never worker.js
build.mjs             derives dist/, worker.js and wrangler.toml
worker.test.mjs       12 cases, including a guard against a stale build
```

Generated, never edited by hand: `worker.js`, `wrangler.toml`, `dist/`, and any
`staticOutDir` copy.

### Two details that are easy to get wrong

- **The status code cannot be templated into a static file.** nginx's
  `error_page` query string is an internal redirect the browser never sees, so
  the code is *injected* into the page — by `sub_filter` on the origin, by a
  string replace in the worker. Both fill the same `__CODE__` placeholder, and
  if neither runs the page falls back to a generic server error rather than
  printing the placeholder.
- **The failed path is never injected.** Reflecting a client-controlled URL into
  the page's script is an XSS waiting to happen, and the address bar already
  holds it — so the page reads it from `location`.

---

## Testing

```bash
npm test
```

Twelve cases against a stubbed origin, covering the failure you cannot
reproduce on demand against a working server: connection refused, timeout, TLS
failure, JSON for API routes, WebSocket, healthy passthrough, the origin's own
503 left alone, Cloudflare's 52x replaced, branding by hostname, the subdomain
and unknown-host fallbacks, and a guard that fails if the built worker has
drifted from the pages in the repository.

---

## Requirements

- Node.js 18+ (uses `node --test` and `replaceAll`)
- A Cloudflare account with the zone you want to protect
- `ngx_http_sub_module` if you also serve the page from nginx — present in the
  official nginx image and in Debian/Ubuntu's `nginx-core`

---

## Author

**Hussein Zaher**

- 📧 [husseinzaher@outlook.com](mailto:husseinzaher@outlook.com)
- 📱 [+20 100 875 5187](tel:+201008755187)
- 💼 [linkedin.com/in/husseinzaher](https://linkedin.com/in/husseinzaher)
