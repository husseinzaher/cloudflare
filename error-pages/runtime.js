// The edge fallback for the one failure a server cannot cover: itself.
//
// When the origin is down it refuses connections outright, Cloudflare has
// nothing to proxy, and the visitor gets Cloudflare's own "Web server is down"
// screen (error 521). Only something running at the edge can answer that, so
// this worker sits on the route, passes every request through untouched, and
// steps in only when the origin cannot be reached - serving that site's own
// branded page, with the status code printed on it.
//
// One deployment serves many sites: hostnames resolve to a page, so which
// branding a visitor sees follows the domain they asked for. The two maps are
// separate on purpose - a site with five hostnames should cost one copy of its
// page in the bundle, not five, and the bundle has a 1 MB ceiling.
const PAGES = __PAGES__;
const HOSTS = __HOSTS__;
const DEFAULT_SITE = __DEFAULT_SITE__;

// Cloudflare's origin-side codes. If one arrives as a real response rather than
// a thrown fetch, the edge gave up on the origin and the visitor is looking at
// Cloudflare's screen - replace it too.
const ORIGIN_ERRORS = new Set([521, 522, 523, 524, 525, 526]);

// Origin failures come back as exceptions, and the message is the only clue to
// which kind. Guessing beats showing nothing: the code is a starting point for
// whoever reports it, not a diagnosis.
function codeFromError(error) {
  const message = String((error && error.message) || '').toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 522;
  if (message.includes('ssl') || message.includes('handshake') || message.includes('certificate')) return 525;
  return 521;
}

// www.example.com falls back to example.com before it falls back to the default
// site, so a customer does not have to list every subdomain to be branded.
function siteFor(hostname) {
  const host = hostname.toLowerCase();
  if (HOSTS[host]) return PAGES[HOSTS[host]];

  const parts = host.split('.');
  while (parts.length > 2) {
    parts.shift();
    const parent = parts.join('.');
    if (HOSTS[parent]) return PAGES[HOSTS[parent]];
  }

  return PAGES[DEFAULT_SITE];
}

function errorResponse(code, request) {
  const url = new URL(request.url);
  const site = siteFor(url.hostname);
  const headers = {
    'Retry-After': '30',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    // The code is on the page, but a header means curl and the browser's
    // network tab show it without reading the body.
    'X-Edge-Error': String(code),
    'X-Edge-Site': site.id,
  };

  // A WebSocket client cannot render anything - fail it plainly and let the
  // client's own reconnect loop do the waiting.
  if (request.headers.get('Upgrade') === 'websocket') {
    return new Response(null, { status: 503, headers });
  }

  // API and webhook callers parse JSON and would choke on a web page.
  if (site.jsonPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return new Response(site.json.replace('__CODE__', String(code)), {
      status: 503,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  // Same placeholder the origin's own server fills, so the page shows the real
  // code however it was served.
  return new Response(site.html.replaceAll('__CODE__', String(code)), {
    status: 503,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export default {
  // Cloudflare's cron trigger. Runs outside any visitor request, which is the
  // whole point: an outage at 3am with no traffic still gets noticed.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watch(env).catch((error) => console.log(`Uptime watch failed: ${error.message}`)));
  },

  async fetch(request) {
    try {
      const response = await fetch(request);
      // 502/503/504 are the origin answering - it served its own branded page,
      // so passing them through keeps it in charge of its own errors.
      if (ORIGIN_ERRORS.has(response.status)) {
        return errorResponse(response.status, request);
      }
      return response;
    } catch (error) {
      return errorResponse(codeFromError(error), request);
    }
  },
};

// --- Uptime watch -----------------------------------------------------------
// A server that has fallen cannot report that it has fallen, and this worker is
// the one thing already running outside it. So on a schedule it checks the site
// and opens a GitHub issue when the site stops answering - which is what turns
// an outage into a notification on a phone rather than something discovered in
// the morning.
//
// Configured at build time from the .env (MONITOR_*), except the token: that is
// a real secret and lives as a Worker secret, set once with
//   npx wrangler secret put GITHUB_TOKEN
const MONITOR = __MONITOR__;

const GITHUB_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  // GitHub rejects requests without one.
  'User-Agent': 'edge-error-pages',
});

async function github(token, path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...GITHUB_HEADERS(token), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

// Three attempts, spaced. One timeout during a deploy is not an outage, and an
// alert that cries wolf gets muted within a week.
async function probe(url) {
  let last = { status: 0, edge: '' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { 'User-Agent': 'edge-error-pages-uptime' },
      });
      if (response.ok) return { up: true, status: response.status, edge: '' };
      last = { status: response.status, edge: response.headers.get('X-Edge-Error') || '' };
    } catch (error) {
      last = { status: 0, edge: codeFromError(error) };
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { up: false, ...last };
}

// Say what was seen and what it means, in the notification itself - the point is
// to be able to act from a phone without opening a dashboard first.
function diagnose(code) {
  if (code === 521 || code === 522 || code === 523) {
    return 'Cloudflare cannot reach the origin at all — nginx is down, or the server is.';
  }
  if (code === 525 || code === 526) {
    return 'The TLS handshake with the origin failed — check the Cloudflare origin certificate.';
  }
  if (code === 502 || code === 503 || code === 504) {
    return 'nginx is up but the app containers are not answering — check `docker compose ps`.';
  }
  if (!code) return 'No response at all, not even from Cloudflare — check DNS and the zone.';
  return `The health endpoint answered ${code}, not 200.`;
}

async function watch(env) {
  if (!MONITOR.enabled) return;
  const token = env.GITHUB_TOKEN;
  if (!token) {
    console.log('Uptime watch is configured but GITHUB_TOKEN is not set - skipping.');
    return;
  }

  const result = await probe(MONITOR.url);
  const issues = await github(token, `/repos/${MONITOR.repo}/issues?state=open&per_page=100`);
  const open = issues.find((issue) => issue.title === MONITOR.title && !issue.pull_request);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);

  if (result.up) {
    if (!open) return;
    await github(token, `/repos/${MONITOR.repo}/issues/${open.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Recovered — \`${MONITOR.url}\` answered 200 at ${now} UTC.` }),
    });
    await github(token, `/repos/${MONITOR.repo}/issues/${open.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
    console.log(`Recovered; closed issue #${open.number}.`);
    return;
  }

  const code = Number(result.edge) || result.status;
  const seen = result.edge
    ? `HTTP \`${result.status}\`, edge worker reported \`${result.edge}\``
    : `HTTP \`${result.status || '000'}\``;

  if (open) {
    await github(token, `/repos/${MONITOR.repo}/issues/${open.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Still down at ${now} UTC — ${seen}.` }),
    });
    console.log(`Still down; commented on #${open.number}.`);
    return;
  }

  const body = [
    `\`${MONITOR.url}\` did not answer 200 on three attempts.`,
    '',
    `- ${seen}`,
    '',
    `**${diagnose(code)}**`,
    '',
    `First seen: ${now} UTC`,
  ].join('\n');

  const created = await github(token, `/repos/${MONITOR.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: MONITOR.title, body }),
  });
  console.log(`Opened incident #${created.number}.`);
}
