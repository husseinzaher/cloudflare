// Stamps one error page per site out of the shared template, then bundles them
// into the worker and writes the wrangler routes to match.
//
//   node build.mjs
//
// Everything downstream is generated: dist/<site>/error.{html,json}, worker.js,
// wrangler.toml, and - for a site that names a staticOutDir - a copy where its
// own web server can serve it. Adding a customer is an entry in
// sites.config.json and a push; nothing here needs editing for it.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

function buildWorker(built) {
  // Hostname -> page. The worker looks itself up by the host it was called on,
  // which is what lets one deployment serve every customer's branding.
  const bundle = {};
  for (const { site, html, json } of built) {
    for (const hostname of site.hostnames) {
      bundle[hostname.toLowerCase()] = {
        id: site.id,
        html,
        json,
        jsonPrefixes: site.jsonPrefixes || [],
      };
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
    .replace('__SITES__', () => JSON.stringify(bundle))
    .replace('__DEFAULT_HOSTNAME__', () => JSON.stringify(fallback.site.hostnames[0].toLowerCase()));

  writeFileSync(resolve(here, 'worker.js'), banner + source);
  return banner.length + source.length;
}

function buildWranglerConfig(built) {
  const worker = config.worker || {};
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

# Regenerate the pages before every upload, so what is deployed can never drift
# from sites.config.json - whether the deploy runs here or on Cloudflare's
# builder after a push. Rerunning build.mjs rewrites this file identically.
[build]
command = "node build.mjs"

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
`,
  );
}

rmSync(resolve(here, 'dist'), { recursive: true, force: true });

const sites = required(config.sites?.length, 'sites') && config.sites;
const built = sites.map(buildSite);
built.forEach(writeSiteFiles);
const bytes = buildWorker(built);
buildWranglerConfig(built);

const names = built.map(({ site }) => `${site.id} (${site.hostnames.join(', ')})`);
process.stdout.write(`${built.length} site(s) built: ${names.join('; ')}\n`);
process.stdout.write(`worker.js ${(bytes / 1024).toFixed(1)} KB, wrangler.toml routes written\n`);
if (bytes > 900 * 1024) {
  process.stdout.write('WARNING: approaching the 1 MB worker size limit - see README.\n');
}
