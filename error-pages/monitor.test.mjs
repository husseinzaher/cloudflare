// The uptime watch only ever runs when something is already wrong, so it is the
// code least likely to be exercised and most costly to have quietly broken.
// These stub GitHub and the site, and assert what it does in each state.
//
//   node --test monitor.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const envPath = here + '.env';
let worker;
let calls;

// Build once with the watch enabled, then restore the repository's own build.
before(async () => {
  writeFileSync(envPath, 'MONITOR_REPO=husseinzaher/tajeerai\n');
  try {
    execFileSync('node', ['build.mjs'], { cwd: here, encoding: 'utf8' });
    const built = readFileSync(here + 'worker.js', 'utf8');
    writeFileSync(here + '.worker.monitor.test.mjs', built);
    worker = (await import('./.worker.monitor.test.mjs')).default;
  } finally {
    if (existsSync(envPath)) unlinkSync(envPath);
    execFileSync('node', ['build.mjs'], { cwd: here, encoding: 'utf8' });
    if (existsSync(here + '.worker.monitor.test.mjs')) unlinkSync(here + '.worker.monitor.test.mjs');
  }
});

// A scheduled run only registers work through waitUntil, so the test has to
// await what it registered.
function ctx() {
  const pending = [];
  return { waitUntil: (promise) => pending.push(promise), done: () => Promise.all(pending) };
}

function stub({ health, issues = [] }) {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });

    if (url.startsWith('https://api.github.com')) {
      if (url.includes('/issues?state=open')) return Response.json(issues);
      return Response.json({ number: 42 });
    }
    if (health instanceof Error) throw health;
    return new Response('', { status: health.status, headers: health.headers || {} });
  };
}

const github = (method, fragment) =>
  calls.filter((call) => call.url.includes('api.github.com') && call.method === method
    && call.url.includes(fragment));

beforeEach(() => { calls = []; });

test('opens an issue when the site is down, naming the cause', async () => {
  stub({ health: { status: 503, headers: { 'X-Edge-Error': '521' } } });
  const c = ctx();
  await worker.scheduled({}, { GITHUB_TOKEN: 't' }, c);
  await c.done();

  const created = github('POST', '/issues');
  assert.equal(created.length, 1, 'exactly one issue should be opened');
  assert.match(created[0].body.title, /is down/);
  assert.match(created[0].body.body, /521/);
  assert.match(created[0].body.body, /nginx is down, or the server is/);
});

test('does not open a second issue while one is already open', async () => {
  stub({
    health: { status: 503, headers: { 'X-Edge-Error': '521' } },
    issues: [{ number: 7, title: 'تاجر AI is down' }],
  });
  const c = ctx();
  await worker.scheduled({}, { GITHUB_TOKEN: 't' }, c);
  await c.done();

  assert.equal(github('POST', '/issues/7/comments').length, 1, 'should comment on the open issue');
  assert.equal(
    calls.filter((call) => call.method === 'POST' && call.url.endsWith('/issues')).length,
    0,
    'a second issue was opened for the same outage',
  );
});

test('closes the issue when the site recovers', async () => {
  stub({ health: { status: 200 }, issues: [{ number: 7, title: 'تاجر AI is down' }] });
  const c = ctx();
  await worker.scheduled({}, { GITHUB_TOKEN: 't' }, c);
  await c.done();

  assert.equal(github('PATCH', '/issues/7').length, 1, 'the issue should be closed');
  assert.equal(github('PATCH', '/issues/7')[0].body.state, 'closed');
});

test('stays quiet when the site is healthy and nothing is open', async () => {
  stub({ health: { status: 200 } });
  const c = ctx();
  await worker.scheduled({}, { GITHUB_TOKEN: 't' }, c);
  await c.done();

  assert.equal(calls.filter((call) => call.method !== 'GET').length, 0, 'a healthy check wrote something');
});

test('reports a connection failure as unreachable, not as a bad status', async () => {
  stub({ health: new Error('Connection refused') });
  const c = ctx();
  await worker.scheduled({}, { GITHUB_TOKEN: 't' }, c);
  await c.done();

  const created = github('POST', '/issues');
  assert.equal(created.length, 1);
  assert.match(created[0].body.body, /nginx is down, or the server is/);
});

test('does nothing at all without a token, rather than throwing', async () => {
  stub({ health: { status: 503 } });
  const c = ctx();
  await worker.scheduled({}, {}, c);
  await c.done();

  assert.equal(calls.length, 0, 'it should not even probe without somewhere to report to');
});
