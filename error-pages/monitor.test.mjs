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
const scratch = here + '.worker.monitor.test.mjs';
let worker;
let calls;

// Build once with the watch enabled, then put the repository's own build back.
//
// The watch is switched on through the environment, never by writing a .env
// here: an earlier version of this file wrote one and deleted it afterwards,
// which quietly deleted the real .env of anyone who had one.
before(async () => {
  try {
    execFileSync('node', ['build.mjs'], {
      cwd: here,
      env: { ...process.env, MONITOR_REPO: 'husseinzaher/tajeerai' },
      encoding: 'utf8',
    });
    writeFileSync(scratch, readFileSync(here + 'worker.js', 'utf8'));
    worker = (await import('./.worker.monitor.test.mjs')).default;
  } finally {
    execFileSync('node', ['build.mjs'], { cwd: here, encoding: 'utf8' });
    if (existsSync(scratch)) unlinkSync(scratch);
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

test('the status endpoint says armed when the token is there', async () => {
  const res = await worker.fetch(new Request('https://tajeerai.com/__uptime-status'), { GITHUB_TOKEN: 't' });
  const body = await res.json();

  assert.equal(body.armed, true);
  assert.equal(body.token, true);
  assert.equal(body.reason, null);
  assert.equal(body.monitor.repo, 'husseinzaher/tajeerai');
});

test('the status endpoint says why it is not armed when the token is missing', async () => {
  // The failure this endpoint exists for: the watch keeps running and keeps
  // deciding to do nothing, and nothing else says so.
  const res = await worker.fetch(new Request('https://tajeerai.com/__uptime-status'), {});
  const body = await res.json();

  assert.equal(body.armed, false);
  assert.equal(body.token, false);
  assert.match(body.reason, /GITHUB_TOKEN is not set/);
});

test('the status endpoint is answered by the edge, not the origin', async () => {
  // It has to work when the origin is unreachable - that is when you need it.
  let reachedOrigin = false;
  globalThis.fetch = async () => { reachedOrigin = true; throw new Error('Connection refused'); };

  const res = await worker.fetch(new Request('https://tajeerai.com/__uptime-status'), { GITHUB_TOKEN: 't' });

  assert.equal(res.status, 200);
  assert.equal(reachedOrigin, false, 'the status endpoint went to the origin');
});

test('does nothing at all without a token, rather than throwing', async () => {
  stub({ health: { status: 503 } });
  const c = ctx();
  await worker.scheduled({}, {}, c);
  await c.done();

  assert.equal(calls.length, 0, 'it should not even probe without somewhere to report to');
});
