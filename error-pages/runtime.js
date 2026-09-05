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
