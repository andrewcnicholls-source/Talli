/* Logging, inside the real edge runtime (supabase/functions/_shared/log.ts).

   The unit tests prove the logger in Node. These prove it where it runs:
   that a function's request is answered with its ref, that an unexpected
   database error reaches the log and not the screen, and that a browser's
   report lands in the log scrubbed. The edge runtime's log is the
   container's stdout, which is what Supabase ships to the Logs tab. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { stack, token } = require('../lib/stack');

const RUNTIME = 'supabase_edge_runtime_talli';

async function post(name, body, bearer) {
  const res = await fetch(`${stack.functionsUrl}/${name}`, {
    method: 'POST',
    headers: {
      apikey: stack.anonKey,
      Authorization: `Bearer ${bearer ?? stack.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ref: res.headers.get('x-talli-ref'), body: json, text };
}

// The runtime's log lines that are ours (JSON with an fn), newest last.
// Polled briefly: stdout reaches docker a moment after the response does.
async function linesWhere(pred) {
  for (let i = 0; i < 20; i++) {
    // docker logs replays the container's stdout and stderr on its own
    // two streams; warn and error lines are on stderr.
    const run = spawnSync('docker', ['logs', '--since', '5m', RUNTIME], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const out = (run.stdout || '') + '\n' + (run.stderr || '');
    const found = out.split('\n')
      .map((l) => { const at = l.indexOf('{"level"'); if (at < 0) return null; try { return JSON.parse(l.slice(at)); } catch { return null; } })
      .filter((l) => l && pred(l));
    if (found.length) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  return [];
}

test('a request is answered with its ref, and summarised in the log under it', async () => {
  const r = await post('check-setup', {}, await token('operator'));
  assert.equal(r.status, 200, r.text);
  assert.match(r.ref, /^[0-9A-F]{8}$/);
  const lines = await linesWhere((l) => l.ref === r.ref && l.event === 'request');
  assert.equal(lines.length, 1, 'no summary line for that ref');
  assert.equal(lines[0].fn, 'check-setup');
  assert.equal(lines[0].status, 200);
});

test('an unexpected database error is logged in full and shown as a ref alone', async () => {
  // An event id that is not a uuid: Postgres answers with its own words,
  // which gate-ops used to pass straight to the screen.
  const r = await post('gate-ops', {
    action: 'set_reserve', event_id: 'not-a-uuid', property_id: 'x', tier_code: 'standard', delta: 1,
  }, await token('operator'));
  assert.ok(r.status >= 400, r.text);
  assert.equal(r.body.code, 'UNEXPECTED', r.text);
  assert.equal(r.body.ref, r.ref);
  assert.ok(r.body.error.includes(r.ref));
  assert.ok(!/uuid|syntax|postgres/i.test(r.text), `database detail reached the screen: ${r.text}`);

  const lines = await linesWhere((l) => l.ref === r.ref);
  const logged = lines.find((l) => l.event === 'unexpected database error');
  assert.ok(logged, `no error line for ${r.ref}: ${JSON.stringify(lines)}`);
  assert.equal(logged.level, 'error');
  assert.match(logged.err.message, /uuid/i);
  const summary = lines.find((l) => l.event === 'request');
  assert.equal(summary.action, 'set_reserve');
  assert.equal(summary.scope, 'all');
});

test('a browser report is logged, scrubbed, without the query string', async () => {
  const marker = 'probe-' + Date.now();
  const r = await post('client-error', {
    kind: 'uncaught',
    message: `${marker} failed for jane.doe@example.com`,
    page: '/booking-confirmed.html?session_id=cs_test_secret123',
    source: 'https://staging.talli.pages.dev/assets/booking.js?v=2#x',
    line: 12, col: 3, ref: 'ABCD1234', environment: 'test',
  });
  assert.equal(r.status, 204, r.text);
  const [line] = await linesWhere((l) => l.fn === 'client-error' && String(l.message).includes(marker));
  assert.ok(line, 'the report did not reach the log');
  assert.equal(line.level, 'warn');
  assert.equal(line.page, '/booking-confirmed.html');
  assert.equal(line.source, 'https://staging.talli.pages.dev/assets/booking.js');
  assert.equal(line.server_ref, 'ABCD1234');
  assert.ok(!JSON.stringify(line).includes('jane.doe'), 'an email reached the log');
  assert.ok(!JSON.stringify(line).includes('cs_test_secret123'), 'the session id reached the log');
});

test('client-error turns away what is not a report', async () => {
  assert.equal((await post('client-error', 'not json')).status, 400);
  assert.equal((await post('client-error', { message: 'x'.repeat(20000) })).status, 413);
});
