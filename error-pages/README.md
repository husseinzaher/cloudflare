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
needed: the routes come from your config, not from the dashboard.

Point it at your own business first — see
[Configuring it for your business](#configuring-it-for-your-business).

Read [Before your first deploy](#before-your-first-deploy) once before running
the deploy command, and [Deployment, step by step](#deployment-step-by-step) for
the full walkthrough — including deploying from GitHub instead, how to verify it,
and how to switch it off.

---

## Configuring it for your business

There are two ways in, and the right one depends on how many businesses this
deployment answers for.

### One business: `.env`

Copy the template, fill it in, deploy. Every generated page, the worker's name
and its routes follow from this one file:

```bash
cp .env.example .env
```

```ini
DOMAIN=souqmisr.com
ZONE=souqmisr.com
EXTRA_DOMAINS=www.souqmisr.com,shop.souqmisr.com
WORKER_NAME=souqmisr-error-pages

BRAND_NAME=سوق مصر
BRAND_NAME_EN=Souq Misr
LOCALE=ar
SECONDARY_LOCALE=en

COLOR_BG_FROM=#14100a
COLOR_BG_TO=#2a1e0c
COLOR_PRIMARY=#c2410c
COLOR_ACCENT=#f59e0b

HEALTH_PATH=/status
JSON_PREFIXES=/api/,/webhooks/
FONT_STACK="Cairo", system-ui, sans-serif
FONT_GOOGLE=https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap
```

```bash
npm run deploy
```

That is the whole change. The page is now Arabic, right-to-left, in that
palette and font, polling `/status`, and the worker claims all three hostnames.
`.env.example` documents every key; anything you leave out falls back to a
sensible default.

#### How the `.env` reaches the worker

It does not. Nothing in it is ever read at run time, and none of it belongs in
Cloudflare's **Variables and Secrets** — it is a *build-time* file, and its
values are baked into `worker.js` before the upload:

```
git push
   ↓
Cloudflare clones the repo, enters the Path (error-pages/)
   ↓
npx wrangler deploy
   ↓
wrangler runs [build] command = node build.mjs
   ↓
build.mjs reads .env  →  stamps the page, worker.js and wrangler.toml
   ↓
wrangler uploads a worker that already contains everything
```

Deploying from your own machine with `npm run deploy` runs the identical chain.

The same keys can come from Cloudflare's **Variables and secrets** in the build
settings instead of the file — they arrive as environment variables, and the
build reads them. Setting both is allowed; the dashboard wins, and the build log
names every key it overrode, because a value changed invisibly in a dashboard is
the kind of thing nobody finds for an hour.

Prefer the file. It is reviewable in a diff, it travels with the branch, and it
cannot be changed by someone who never opened the repository. The dashboard is
there for the case where a value genuinely must not be committed.

Two consequences worth holding on to:

- **Cloudflare only ever sees what is committed.** That is why the `.env` has to
  be in the repository — see below.
- **A change to the `.env` is live only after a redeploy.** Editing it changes
  nothing on its own; push it, or run `npm run deploy`.

The build announces which configuration it used, as its first line of output, so
the Cloudflare build log answers "which brand did this actually deploy?"
directly:

```
[custom build] Running: node build.mjs
[custom build] Configured from .env (sites.config.json ignored).
[custom build] 1 site(s) built: souqmisr-com (souqmisr.com, www.souqmisr.com)
```

> **Commit the `.env`.** It holds branding, not secrets — no keys, no tokens —
> and Cloudflare's builder only ever sees what is in the repository. A
> gitignored `.env` means the remote build silently falls back to
> `sites.config.json` and deploys the wrong brand.

When a `.env` exists it *is* the configuration, and `sites.config.json` is
ignored — the build says so in its first line of output, which also shows up in
the Cloudflare build log.

### Many businesses: `sites.config.json`

Sites are data, not code. One entry is one customer:

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

Then `npm run deploy`. The build derives everything from each entry: a static
page for the site, a hostname index into it, and the Cloudflare routes. There is
no template to copy and no route to remember. A site costs one copy of its page
in the bundle no matter how many hostnames point at it.

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

Every one of these has a `.env` equivalent — `sites.config.json` is the same
shape, repeated per customer.

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

## Deployment, step by step

Two routes to the same place. **A** is the fastest first deploy; **B** is what
you want afterwards, so later edits ship by pushing them.

### A. From your machine

1. **Install and log in.** The first `wrangler` command opens a browser to
   authorise your Cloudflare account.

   ```bash
   npm install
   npx wrangler login
   ```

2. **Describe your site** in `sites.config.json` — hostnames, zone, brand,
   colours. See [Configuring it for your business](#configuring-it-for-your-business).

3. **Build and check what came out.** This generates the pages, `worker.js` and
   the routes in `wrangler.toml`. Read that file before deploying: the routes it
   lists are exactly the traffic the worker will see.

   ```bash
   npm run build
   npm test
   cat wrangler.toml
   ```

4. **Deploy.**

   ```bash
   npm run deploy
   ```

   Wrangler uploads the worker and claims the routes from `wrangler.toml`. There
   is nothing to configure in the dashboard.

5. **Verify** — see [Verifying it works](#verifying-it-works) below.

### B. From the Cloudflare dashboard, connected to your repository

1. Push this repository to GitHub.
2. In the Cloudflare dashboard, go to **Workers & Pages → Create**.
3. Choose **Continue with GitHub** and authorise Cloudflare for the repository.
4. Pick the repository, then set:

   | Field | Value |
   | --- | --- |
   | Project name | `edge-error-pages` — must match `name` in `wrangler.toml`, or the project and the worker it deploys end up with different names |
   | Production branch | `main` |
   | Path / Root directory | `error-pages` — the directory holding `wrangler.toml`, **not** the repository root unless the package sits there |
   | Build command | *(leave empty)* |
   | Deploy command | `npx wrangler deploy` |
   | Non-production branch deploy command | `npx wrangler versions upload` (the default — uploads a version without giving it traffic) |
   | API token | *Create new token*; name it something you will recognise later, e.g. `edge-error-pages-builds` |
   | Protect with Cloudflare Access | off |

   The build command stays empty because `wrangler.toml` carries
   `[build] command = "node build.mjs"` — wrangler regenerates the pages before
   it uploads, so what is deployed can never drift from what is in the
   repository.

   If the build fails with *"no config file found"*, the Path is wrong: it has
   to point at the directory containing `wrangler.toml`.

5. **Create and deploy.** Cloudflare builds, deploys, and claims the routes from
   `wrangler.toml` — no route to add by hand.
6. From then on, changing a site's branding or copy is:

   ```bash
   git commit -am "…" && git push
   ```

### Verifying it works

1. **Open the site normally.** It must behave exactly as before — the worker
   adds nothing on a healthy origin. If anything looks off, jump to
   [Turning it off](#turning-it-off); it is one click.

2. **Watch the worker live**, in a second terminal:

   ```bash
   npx wrangler tail
   ```

3. **Take the origin away for a moment** and load the site. On a server running
   nginx, in a quiet window:

   ```bash
   sudo systemctl stop nginx && sleep 20 && sudo systemctl start nginx
   ```

   During those seconds the site should show your branded page with **521** on
   it, instead of Cloudflare's grey screen — and reload itself once the origin
   answers again.

4. **Check an API route** during the same window. It must return JSON, not HTML:

   ```bash
   curl -i https://your-domain.com/api/health
   ```

   Expect `503`, `Content-Type: application/json`, `X-Edge-Error: 521`, and a
   body carrying the same code.

### Turning it off

The worker only matters because it is on the route, so removing the route
disables it instantly and completely — the origin is served directly again, with
no redeploy:

**Workers & Pages → your worker → Settings → Domains & Routes → remove the
route.**

Or from the CLI, delete the worker entirely:

```bash
npx wrangler delete
```

## Project layout

```
.env                  one business: the whole configuration in one file
.env.example          every key it accepts, documented
sites.config.json     many businesses: hostnames, brand, colours, routes
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
