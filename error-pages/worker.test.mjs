// Runs the built worker against a stubbed origin, because the failure it exists
// for - the origin being unreachable - is the one you cannot reproduce by
// pointing it at a working server.
//
//   node --test cloudflare/error-pages/worker.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let worker;
const realFetch = globalThis.fetch;

before(async () => {
  worker = (await import('./worker.js')).default;
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

function originFails(message) {
  globalThis.fetch = async () => { throw new Error(message); };
}

function originReturns(response) {
  globalThis.fetch = async () => response;
}

test('serves the branded page when the origin refuses the connection', async () => {
  originFails('connect(): Connection refused');
  const res = await worker.fetch(new Request('https://tajeerai.com/dashboard/integrations/whatsapp'));

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-Edge-Error'), '521');
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.match(await res.text(), /var injected = \{ code: '521' \}/);
});

test('serves JSON, not a web page, to API callers', async () => {
  originFails('Connection refused');
  const res = await worker.fetch(new Request('https://tajeerai.com/api/conversations'));

  assert.equal(res.status, 503);
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal(JSON.parse(await res.text()).code, '521');
});

test('distinguishes a timeout from a refusal', async () => {
  originFails('Connection timed out');
  const res = await worker.fetch(new Request('https://tajeerai.com/'));

  assert.equal(res.headers.get('X-Edge-Error'), '522');
});

test('distinguishes a TLS failure', async () => {
  originFails('SSL handshake failed with origin');
  const res = await worker.fetch(new Request('https://tajeerai.com/'));

  assert.equal(res.headers.get('X-Edge-Error'), '525');
});

test('fails a WebSocket upgrade without a body', async () => {
  originFails('Connection refused');
  const res = await worker.fetch(new Request('https://tajeerai.com/socket.io/?EIO=4', {
    headers: { Upgrade: 'websocket' },
  }));

  assert.equal(res.status, 503);
  assert.equal(await res.text(), '');
});

test('passes a healthy origin through untouched', async () => {
  originReturns(new Response('hello', { status: 200, headers: { 'X-Origin': 'yes' } }));
  const res = await worker.fetch(new Request('https://tajeerai.com/'));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Origin'), 'yes');
  assert.equal(await res.text(), 'hello');
});

test("leaves nginx's own error page alone", async () => {
  // nginx is up and already served the branded 503 for a deploy - the worker
  // has nothing to add, and replacing it would lose the real status.
  originReturns(new Response('<html>nginx branded page</html>', { status: 503 }));
  const res = await worker.fetch(new Request('https://tajeerai.com/'));

  assert.equal(await res.text(), '<html>nginx branded page</html>');
});

test("replaces Cloudflare's own origin errors when they arrive as responses", async () => {
  originReturns(new Response('cloudflare screen', { status: 522 }));
  const res = await worker.fetch(new Request('https://tajeerai.com/'));

  assert.equal(res.headers.get('X-Edge-Error'), '522');
  assert.match(await res.text(), /var injected = \{ code: '522' \}/);
});

test('brands the page by the hostname it was called on', async () => {
  originFails('Connection refused');
  const res = await worker.fetch(new Request('https://www.tajeerai.com/'));

  assert.equal(res.headers.get('X-Edge-Site'), 'tajeerai');
  assert.match(await res.text(), /تاجر AI/);
});

test('falls back from an unlisted subdomain to its parent domain', async () => {
  originFails('Connection refused');
  const res = await worker.fetch(new Request('https://staging.tajeerai.com/'));

  assert.equal(res.headers.get('X-Edge-Site'), 'tajeerai');
});

test('falls back to the default site for an unknown host', async () => {
  originFails('Connection refused');
  const res = await worker.fetch(new Request('https://someone-elses-domain.example/'));

  assert.equal(res.headers.get('X-Edge-Site'), 'tajeerai');
});

// These run the build with environment overrides, which rewrites the generated
// files - so each one puts them back before it returns.
async function buildWith(env) {
  const { execFileSync } = await import('node:child_process');
  const here = new URL('.', import.meta.url).pathname;
  try {
    return execFileSync('node', ['build.mjs'], {
      cwd: here,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  } finally {
    execFileSync('node', ['build.mjs'], { cwd: here, encoding: 'utf8' });
  }
}

test('a different DOMAIN does not inherit the configured site\'s hostnames', async () => {
  // Inheriting them would be worse than an error: the new business would claim
  // a Cloudflare route for a domain belonging to the previous one.
  let error;
  try {
    await buildWith({ DOMAIN: 'somewhere-else.example' });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'a foreign DOMAIN with no BRAND_NAME must fail, not inherit a brand');
  assert.match(String(error.stderr), /BRAND_NAME is required/);

  const out = await buildWith({ DOMAIN: 'somewhere-else.example', BRAND_NAME: 'Somewhere Else' });
  assert.match(out, /a site of its own/);
  assert.match(out, /somewhere-else\.example/);
  // The hostnames are what must not leak - the monitor line may legitimately
  // name a repository that has the same word in it.
  assert.doesNotMatch(out, /tajeerai\.com/, 'the foreign site inherited the configured site\'s hostnames');
});

test('an override without a DOMAIN keeps the configured site', async () => {
  const out = await buildWith({ COLOR_PRIMARY: '#0d9488' });

  assert.match(out, /over the "tajeerai" site/);
  assert.match(out, /1 site\(s\) built: tajeerai \(tajeerai\.com, www\.tajeerai\.com\)/);
});

test('wrangler.toml keeps [build] last, so the routes survive', async () => {
  // A TOML table swallows every key after it. With [build] higher up, routes
  // and workers_dev become fields of the build table, wrangler warns
  // "Unexpected fields found in build field", and the worker deploys with no
  // routes at all - it is live and intercepting nothing.
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');

  const build = toml.indexOf('[build]');
  assert.notEqual(build, -1, 'wrangler.toml has no [build] section');
  for (const key of ['routes = [', 'workers_dev =', 'name =', 'main =', 'compatibility_date =']) {
    const at = toml.indexOf(key);
    assert.notEqual(at, -1, `wrangler.toml is missing ${key}`);
    assert.ok(at < build, `"${key}" must come before [build], or TOML nests it inside the build table`);
  }
});

test('the built worker is in step with the sites it was generated from', async () => {
  const { readFileSync } = await import('node:fs');
  const here = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const built = here('./worker.js');

  // Every site's generated page has to be inside the bundle, or the deployed
  // worker is serving something the repository no longer describes.
  const config = JSON.parse(here('./sites.config.json'));
  for (const site of config.sites) {
    assert.ok(
      built.includes(JSON.stringify(here(`./dist/${site.id}/error.html`))),
      `worker.js is stale for site "${site.id}" — run: node cloudflare/error-pages/build.mjs`,
    );
  }
});
