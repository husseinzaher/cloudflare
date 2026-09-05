// Stamps one error page per site out of the shared template, then bundles them
// into the worker and writes the wrangler routes to match.
//
//   node build.mjs
//
// Everything downstream is generated: dist/<site>/error.{html,json}, worker.js,
// wrangler.toml, and - for a site that names a staticOutDir - a copy where its
// own web server can serve it. Adding a customer is an entry in
// sites.config.json and a push; nothing here needs editing for it.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(resolve(here, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

const config = readJson('sites.config.json');
const messages = readJson('messages.json');
const ui = readJson('ui.json');
const htmlTemplate = read('templates/error.html');
const jsonTemplate = read('templates/error.json');
const runtime = read('runtime.js');

// Languages whose pages have to mirror, not just translate.
const RTL = new Set(['ar', 'fa', 'he', 'ur']);

// A .env describes one business, and when it exists it *is* the configuration -
// the whole point being that pointing this worker at a different company is
// editing one file. sites.config.json stays the path for serving many at once.
//
// Deliberately hand-parsed: the file holds branding, not secrets, and adding a
// dependency to read six lines of KEY=value would be the more surprising
// choice in a package that otherwise installs nothing to build.
// Set by readEnv, so the build can report which configuration it actually used.
let envSource = null;

// The keys a build understands. Fixed rather than "anything in the
// environment", so a stray variable on the build machine cannot quietly change
// what gets deployed.
const ENV_KEYS = [
  'SITE_ID', 'DOMAIN', 'ZONE', 'EXTRA_DOMAINS', 'WORKER_NAME',
  'BRAND_NAME', 'BRAND_NAME_EN', 'BRAND_WORDMARK',
  'LOCALE', 'SECONDARY_LOCALE',
  'COLOR_BG_FROM', 'COLOR_BG_TO', 'COLOR_PRIMARY', 'COLOR_PRIMARY_STRONG',
  'COLOR_PRIMARY_SOFT', 'COLOR_PRIMARY_TINT', 'COLOR_ACCENT', 'COLOR_WARNING',
  'COLOR_DESTRUCTIVE', 'COLOR_FOREGROUND', 'COLOR_MUTED_FOREGROUND',
  'FONT_STACK', 'FONT_LATIN_STACK', 'FONT_GOOGLE',
  'HEALTH_PATH', 'JSON_PREFIXES', 'STATIC_OUT_DIR',
  'MONITOR_REPO', 'MONITOR_URL', 'MONITOR_TITLE', 'MONITOR_CRON',
];

function readEnv() {
  const path = resolve(here, '.env');

  // Cloudflare's build variables arrive as real environment variables, so the
  // same configuration can live in the dashboard instead of the repository.
  // They win over the file when both set a key - and the build says which ones
  // did, because a value overridden invisibly in a dashboard is exactly the
  // kind of thing nobody finds for an hour.
  const fromBuildVars = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') fromBuildVars[key] = value;
  }
  const overrides = Object.keys(fromBuildVars);

  if (!existsSync(path)) {
    if (!overrides.length) return null;
    envSource = `build variables (${overrides.join(', ')})`;
    return { ...fromBuildVars, $source: 'vars' };
  }

  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    // Strip one layer of wrapping quotes, but leave inner ones alone: a font
    // stack is written  FONT_STACK="Inter", system-ui  and means it.
    if (value.length > 1 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")
        && !value.slice(1, -1).includes(value[0])) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  envSource = overrides.length
    ? `.env, overridden by build variables for ${overrides.join(', ')}`
    : '.env';
  return { ...env, ...fromBuildVars, $source: 'file' };
}

// The env is a layer *over* a site, not a replacement for one. Setting a single
// COLOR_PRIMARY should recolour the site that is already configured, not demand
// every other key back from scratch - which is what a build with three
// variables set and the rest expected from nowhere would mean.
//
// `base` is the site being overridden: sites.config.json's defaultSite, or
// nothing at all when the repository configures no sites and the env is the
// only source.
function siteFromEnv(env, base) {
  const value = (key, fallback = '') => (env[key] || '').trim() || fallback;
  const source = env.$source === 'file' ? '.env' : 'build variables';

  const domain = value('DOMAIN', base?.hostnames?.[0]);
  if (!domain) {
    throw new Error(`${source}: DOMAIN is required - the domain to protect, e.g. example.com`);
  }
  const brand = value('BRAND_NAME', base?.brand?.name);
  if (!brand) {
    throw new Error(
      `${source}: BRAND_NAME is required. Nothing in sites.config.json could supply it - `
      + 'either set BRAND_NAME, or add the site there and let the env override only what differs.',
    );
  }

  const list = (key, fallback = []) => {
    const raw = value(key);
    return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
  };
  const colors = base?.colors || {};
  const primary = value('COLOR_PRIMARY', colors.primary || '#4f46e5');

  return {
    id: value('SITE_ID', base?.id || domain.replace(/[^a-z0-9]+/gi, '-').toLowerCase()),
    hostnames: [domain, ...list('EXTRA_DOMAINS', base?.hostnames?.slice(1) || [])],
    zone: value('ZONE', base?.zone || domain),
    locale: value('LOCALE', base?.locale || 'en'),
    secondaryLocale: value('SECONDARY_LOCALE', base?.secondaryLocale || '') || null,
    brand: {
      name: brand,
      nameEn: value('BRAND_NAME_EN', base?.brand?.nameEn || '') || undefined,
      wordmark: value('BRAND_WORDMARK', base?.brand?.wordmark || brand),
    },
    colors: {
      bgFrom: value('COLOR_BG_FROM', colors.bgFrom || '#0b1020'),
      bgTo: value('COLOR_BG_TO', colors.bgTo || '#111a3a'),
      primary,
      primaryStrong: value('COLOR_PRIMARY_STRONG', colors.primaryStrong || primary),
      primarySoft: value('COLOR_PRIMARY_SOFT', colors.primarySoft || primary),
      primaryTint: value('COLOR_PRIMARY_TINT', colors.primaryTint || primary),
      accent: value('COLOR_ACCENT', colors.accent || '#06b6d4'),
      warning: value('COLOR_WARNING', colors.warning || '#ebaa2d'),
      destructive: value('COLOR_DESTRUCTIVE', colors.destructive || '#dc5b4d'),
      foreground: value('COLOR_FOREGROUND', colors.foreground || '#ffffff'),
      mutedForeground: value('COLOR_MUTED_FOREGROUND', colors.mutedForeground || '#a8abc4'),
    },
    font: {
      stack: value('FONT_STACK', base?.font?.stack || 'system-ui, sans-serif'),
      latinStack: value('FONT_LATIN_STACK', base?.font?.latinStack || '') || undefined,
      googleFonts: value('FONT_GOOGLE', base?.font?.googleFonts || '') || undefined,
    },
    healthPath: value('HEALTH_PATH', base?.healthPath || '/'),
    jsonPrefixes: list('JSON_PREFIXES', base?.jsonPrefixes || []),
    staticOutDir: value('STATIC_OUT_DIR', base?.staticOutDir || '') || undefined,
    messages: base?.messages,
  };
}

function required(value, what) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`sites.config.json: ${what} is required`);
  }
  return value;
}

// The brand reads differently per language: an Arabic-first product usually
// still writes its name in Latin script in an English sentence.
function brandFor(site, locale) {
  return site.brand.names?.[locale] || (locale === 'en' ? site.brand.nameEn : null) || site.brand.name;
}

// A site's own copy wins over the shared catalogue, key by key, so a customer
// can reword one status without forking the whole table.
function messagesFor(site) {
  const merged = {};
  for (const [code, entry] of Object.entries({ ...messages, ...(site.messages || {}) })) {
    if (code.startsWith('$')) continue;
    const localised = {};
    for (const [locale, copy] of Object.entries(entry)) {
      if (locale === 'family') continue;
      const brand = brandFor(site, locale);
      localised[locale] = {
        title: copy.title.replaceAll('{brand}', brand),
        message: copy.message.replaceAll('{brand}', brand),
      };
    }
    merged[code] = { family: entry.family, ...localised };
  }
  return merged;
}

function buildSite(site) {
  required(site.id, 'site.id');
  required(site.hostnames?.length, `site "${site.id}" hostnames`);
  required(site.brand?.name, `site "${site.id}" brand.name`);

  const locale = site.locale || 'en';
  const secondaryLocale = site.secondaryLocale || null;
  const dir = RTL.has(locale) ? 'rtl' : 'ltr';
  const secondaryDir = secondaryLocale && RTL.has(secondaryLocale) ? 'rtl' : 'ltr';

  if (!ui[locale]) throw new Error(`ui.json has no strings for locale "${locale}" (site ${site.id})`);

  const siteRuntime = {
    id: site.id,
    locale,
    secondaryLocale,
    brand: { name: brandFor(site, locale) },
    colors: site.colors,
    healthPath: site.healthPath || '/',
    ui: ui[locale],
    messages: messagesFor(site),
  };

  const fontLinks = site.font?.googleFonts
    ? [
        '<link rel="preconnect" href="https://fonts.googleapis.com">',
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        `<link rel="stylesheet" href="${site.font.googleFonts}">`,
      ].join('\n')
    : '';

  const tokens = {
    LOCALE: locale,
    DIR: dir,
    SECONDARY_DIR: secondaryDir,
    // An RTL page spins the other way, so the motion reads as forward in both.
    SPIN_TO: dir === 'rtl' ? '-360deg' : '360deg',
    BRAND_NAME: site.brand.name,
    BRAND_WORDMARK: site.brand.wordmark || site.brand.name,
    FONT_LINKS: fontLinks,
    FONT_STACK: site.font?.stack || 'system-ui, sans-serif',
    FONT_LATIN_STACK: site.font?.latinStack || site.font?.stack || 'system-ui, sans-serif',
    COLOR_BG_FROM: site.colors.bgFrom,
    COLOR_BG_TO: site.colors.bgTo,
    COLOR_PRIMARY: site.colors.primary,
    COLOR_PRIMARY_STRONG: site.colors.primaryStrong || site.colors.primary,
    COLOR_PRIMARY_SOFT: site.colors.primarySoft || site.colors.primary,
    COLOR_PRIMARY_TINT: site.colors.primaryTint || site.colors.primary,
    COLOR_ACCENT: site.colors.accent,
    COLOR_FOREGROUND: site.colors.foreground || '#ffffff',
    COLOR_MUTED_FOREGROUND: site.colors.mutedForeground || 'rgba(255,255,255,0.7)',
    SITE_JSON: JSON.stringify(siteRuntime),
  };

  let html = htmlTemplate;
  for (const [token, value] of Object.entries(tokens)) {
    html = html.replaceAll(`{{${token}}}`, () => value);
  }
  html = html.replace(
    '<!doctype html>',
    `<!doctype html>\n<!-- GENERATED for site "${site.id}" by cloudflare/error-pages/build.mjs.\n     Edit templates/error.html or sites.config.json and rebuild - changes here are lost. -->`,
  );

  const outage = siteRuntime.messages['503'] || siteRuntime.messages.default;
  const json = jsonTemplate
    .replaceAll('{{JSON_MESSAGE}}', () => (outage[locale] || outage.en).message)
    .replaceAll('{{JSON_MESSAGE_EN}}', () => (outage.en || outage[locale]).message)
    .trim();

  const unresolved = html.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) {
    throw new Error(`site "${site.id}": template tokens left unresolved: ${[...new Set(unresolved)].join(', ')}`);
  }

  return { site, html, json };
}

function writeSiteFiles({ site, html, json }) {
  const dist = resolve(here, 'dist', site.id);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'error.html'), html);
  writeFileSync(join(dist, 'error.json'), json + '\n');

  // A site whose own web server serves the page (nginx, Caddy, S3) gets a copy
  // where that server already looks.
  if (site.staticOutDir) {
    const target = resolve(here, site.staticOutDir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'error.html'), html);
    writeFileSync(join(target, 'error.json'), json + '\n');
  }
}

// The uptime watch is off unless a repository to file issues against is named:
// there is nowhere to send an alert otherwise, and a monitor that alerts into
// the void is worse than none - it reads as covered when it is not.
function monitorConfig(env, site) {
  const value = (key, fallback = '') => ((env && env[key]) || '').trim() || fallback;
  const repo = value('MONITOR_REPO', config.monitor?.repo || '');
  if (!repo) return { enabled: false };

  return {
    enabled: true,
    repo,
    url: value('MONITOR_URL', config.monitor?.url || `https://${site.hostnames[0]}${site.healthPath || '/'}`),
    title: value('MONITOR_TITLE', config.monitor?.title || `${site.brand.name} is down`),
  };
}

function buildWorker(built) {
  // One page per site, and a hostname index pointing into it. The worker looks
  // itself up by the host it was called on, which is what lets one deployment
  // serve every customer's branding - without paying for the page once per
  // hostname.
  const pages = {};
  const hosts = {};
  for (const { site, html, json } of built) {
    pages[site.id] = { id: site.id, html, json, jsonPrefixes: site.jsonPrefixes || [] };
    for (const hostname of site.hostnames) {
      hosts[hostname.toLowerCase()] = site.id;
    }
  }

  const fallbackId = config.defaultSite || built[0].site.id;
  const fallback = built.find((entry) => entry.site.id === fallbackId);
  if (!fallback) throw new Error(`defaultSite "${fallbackId}" is not in sites`);

  const banner = `// GENERATED by build.mjs - do not edit.
// Source: sites.config.json + messages.json + ui.json + templates/error.html,
// then \`node cloudflare/error-pages/build.mjs\`.
`;

  const source = runtime
    .replace('__MONITOR__', () => JSON.stringify(monitor))
    .replace('__PAGES__', () => JSON.stringify(pages))
    .replace('__HOSTS__', () => JSON.stringify(hosts))
    .replace('__DEFAULT_SITE__', () => JSON.stringify(fallback.site.id));

  writeFileSync(resolve(here, 'worker.js'), banner + source);
  return banner.length + source.length;
}

function buildWranglerConfig(built) {
  const worker = config.worker || {};
  // A cron trigger only earns its place when there is a monitor to run.
  const cron = monitor.enabled
    ? `\n# The uptime watch: checks the site on a schedule and files a GitHub issue\n`
      + `# when it stops answering. Scheduled runs count as requests, so every five\n`
      + `# minutes is 288 a day - nothing against the daily allowance.\n`
      + `[triggers]\ncrons = ["${(env && env.MONITOR_CRON) || config.monitor?.cron || '*/5 * * * *'}"]\n`
    : '';
  const routes = built.flatMap(({ site }) =>
    site.hostnames.map(
      (hostname) => `  { pattern = "${hostname}/*", zone_name = "${required(site.zone, `site "${site.id}" zone`)}" },`,
    ),
  );

  writeFileSync(
    resolve(here, 'wrangler.toml'),
    `# GENERATED by build.mjs from sites.config.json - do not edit.
# Add a site there and rebuild; the routes below follow.
name = "${worker.name || 'edge-error-pages'}"
main = "worker.js"
compatibility_date = "${worker.compatibilityDate || '2025-01-01'}"

# No workers.dev URL: on that hostname the worker's passthrough fetch would
# point at itself, which only produces a confusing broken link. The worker is
# only meaningful on the routes below.
workers_dev = false

# The worker has to sit on the route to answer when an origin is gone -
# Cloudflare cannot "call it only on failure". Every request passes through
# untouched; it responds itself only when the origin cannot be reached.
routes = [
${routes.join('\n')}
]

# Last on purpose. A TOML table swallows every key that follows it, so a
# [build] section placed higher would turn workers_dev and routes into fields of
# the build table - wrangler warns "Unexpected fields found in build field" and
# deploys the worker with no routes at all.
#
# The command regenerates the pages before every upload, so what is deployed
# cannot drift from sites.config.json, whether the deploy runs locally or on
# Cloudflare's builder after a push. Rerunning it rewrites this file identically.
[build]
command = "node build.mjs"
${cron}`,
  );
}

rmSync(resolve(here, 'dist'), { recursive: true, force: true });

const env = readEnv();

// Which configured site, if any, these values are overriding. A DOMAIN naming
// somewhere else is a *different* business, and inheriting from the previous one
// would be worse than an error: the new site would quietly keep the old site's
// extra hostnames and claim a Cloudflare route for a domain that is not its own.
function baseFor(env, sites) {
  const configured = (sites || []).find((site) => site.id === config.defaultSite) || sites?.[0];
  if (!configured) return null;

  const domain = (env.DOMAIN || '').trim().toLowerCase();
  if (!domain) return configured;
  return configured.hostnames.some((host) => host.toLowerCase() === domain) ? configured : null;
}

let sites;
if (env) {
  // One business, whatever the repository lists: the env describes a single
  // deployment, and a site it names is the thing it overrides.
  const base = baseFor(env, config.sites);
  sites = [siteFromEnv(env, base)];
  process.stdout.write(
    `Configured from ${envSource}`
    + (base ? `, over the "${base.id}" site in sites.config.json` : ' (a site of its own)')
    + '.\n',
  );
  if (env.WORKER_NAME) config.worker = { ...config.worker, name: env.WORKER_NAME.trim() };
  config.defaultSite = sites[0].id;
} else {
  sites = required(config.sites?.length, 'sites') && config.sites;
}

const built = sites.map(buildSite);
const monitor = monitorConfig(env, sites[0]);
if (monitor.enabled) {
  process.stdout.write(`Uptime watch: ${monitor.url} -> issues on ${monitor.repo}\n`);
}
built.forEach(writeSiteFiles);
const bytes = buildWorker(built);
buildWranglerConfig(built);

const names = built.map(({ site }) => `${site.id} (${site.hostnames.join(', ')})`);
process.stdout.write(`${built.length} site(s) built: ${names.join('; ')}\n`);
process.stdout.write(`worker.js ${(bytes / 1024).toFixed(1)} KB, wrangler.toml routes written\n`);
if (bytes > 900 * 1024) {
  process.stdout.write('WARNING: approaching the 1 MB worker size limit - see README.\n');
}
