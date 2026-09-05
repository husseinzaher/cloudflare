<div align="center">

# Cloudflare

**Edge infrastructure — the parts of a product that have to keep working when
the servers behind them do not.**

</div>

---

Code in this repository runs on Cloudflare's edge rather than on an origin
server. That distinction is the whole point: an edge worker answers from
Cloudflare's own network, so it is still there when the origin is unreachable,
mid-deploy, rebooting, or gone.

## What is here

| Package | What it does |
| --- | --- |
| [`error-pages/`](error-pages/README.md) | Branded, multi-tenant error pages served from the edge. When a site is down, visitors see **its** page — brand, language and status code — instead of Cloudflare's grey *"Web server is down"* screen. One deployment serves any number of domains, each with its own branding, and adding a customer is one entry in a config file. |

Each package is self-contained: its own `wrangler.toml`, its own tests, its own
README with the deployment walkthrough.

## Deploying

Every package deploys the same way — from a machine:

```bash
cd <package>
npm install
npm test
npx wrangler deploy
```

…or straight from this repository, so later edits ship by pushing them:
**Cloudflare dashboard → Workers & Pages → Create → Continue with GitHub**, with
**Path** set to the package directory (for example `error-pages`) and **Deploy
command** `npx wrangler deploy`.

The routes each worker claims live in its own `wrangler.toml`, not in the
dashboard — so what a worker intercepts is reviewable in a diff.

> **Before putting a worker on a zone's route:** it will see *every* request to
> that zone, because Cloudflare cannot invoke a Worker only on failure. The free
> plan caps that at 100,000 requests/day. Each package's README covers the
> limits that apply to it.

## Author

**Hussein Zaher**

- 📧 [husseinzaher@outlook.com](mailto:husseinzaher@outlook.com)
- 📱 [+20 100 875 5187](tel:+201008755187)
- 💼 [linkedin.com/in/husseinzaher](https://linkedin.com/in/husseinzaher)
