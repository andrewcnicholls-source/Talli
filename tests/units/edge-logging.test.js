/* =====================================================================
   supabase/functions/_shared/log.ts — what the edge functions write to
   their logs, and what they let a caller see when something breaks.

   Three promises, each of which fails quietly if it is broken:

     a key, token or customer email never reaches the logs in the clear;
     every line of a request carries the same ref, and a 500 tells the
     caller that ref and nothing else;
     a named database error (SOLD_OUT: …) still reaches the screen, and
     any other database message does not.

   log.ts is plain TypeScript that Node loads directly (type stripping).

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(
  path.join(__dirname, '..', '..', 'supabase', 'functions', '_shared', 'log.ts')).href);

// Capture what would have gone to console, as parsed lines.
async function capture(fn) {
  const L = await load();
  const lines = [];
  const prev = L.setSink((level, text) => lines.push({ level, line: JSON.parse(text) }));
  try {
    await fn(L);
  } finally {
    L.setSink(prev);
  }
  return lines;
}

test('a line is JSON with level, function, event and the fields given', async () => {
  const lines = await capture((L) => L.logger('gate-ops').info('car checked in', { booking: 'b1' }));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].line, { level: 'info', fn: 'gate-ops', event: 'car checked in', booking: 'b1' });
  assert.equal(lines[0].level, 'info');
});

test('keys, tokens and signatures are redacted, by name and by shape', async () => {
  const stripeKey = 'sk_' + 'live_' + 'a'.repeat(24);
  const whsec = 'whsec_' + 'b'.repeat(24);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';
  const lines = await capture((L) => L.logger('x').error('boom', {
    password: 'hunter2',
    authorization: 'Bearer abc',
    stripe_secret: 'anything',
    note: `the key was ${stripeKey} and ${whsec}`,
    header: `Bearer ${jwt}`,
    nested: { apikey: 'k', ok: 'fine' },
  }));
  const text = JSON.stringify(lines[0].line);
  for (const secret of ['hunter2', stripeKey, whsec, jwt, '"abc"', 'anything']) {
    assert.ok(!text.includes(secret), `leaked ${secret}: ${text}`);
  }
  assert.equal(lines[0].line.password, '[redacted]');
  assert.equal(lines[0].line.nested.ok, 'fine');
});

test('a customer email is cut to its first letter and domain', async () => {
  const lines = await capture((L) => L.logger('x').warn('emailed', {
    to: 'jane.doe@example.co.nz', note: 'sent to bob@mail.com twice',
  }));
  assert.equal(lines[0].line.to, 'j***@example.co.nz');
  assert.equal(lines[0].line.note, 'sent to b***@mail.com twice');
});

test('errors keep message, code and a short stack; database errors keep details and hint', async () => {
  const pg = { message: 'duplicate key value', code: '23505', details: 'Key (x)=(1)', hint: null };
  const lines = await capture((L) => {
    L.logger('x').error('insert failed', { err: pg });
    L.logger('x').error('threw', { err: new TypeError('bad thing') });
  });
  assert.deepEqual(lines[0].line.err, { message: 'duplicate key value', code: '23505', details: 'Key (x)=(1)' });
  assert.equal(lines[1].line.err.name, 'TypeError');
  assert.equal(lines[1].line.err.message, 'bad thing');
  assert.ok(lines[1].line.err.stack.split('\n').length <= 6);
});

test('fields with a message and a stack are kept whole, not mistaken for an error', async () => {
  // A browser's report has both; client-error logs it as fields.
  const lines = await capture((L) => L.logger('client-error').warn('browser error', {
    kind: 'uncaught', message: 'x is undefined', page: '/book.html', stack: 'at book.js:1', line: 3,
  }));
  assert.deepEqual(lines[0].line, {
    level: 'warn', fn: 'client-error', event: 'browser error',
    kind: 'uncaught', message: 'x is undefined', page: '/book.html', stack: 'at book.js:1', line: 3,
  });
});

test('a field cannot overwrite level, function, event or ref', async () => {
  const lines = await capture((L) => L.logger('x').info('real', { level: 'error', fn: 'y', event: 'fake' }));
  assert.equal(lines[0].line.level, 'info');
  assert.equal(lines[0].line.fn, 'x');
  assert.equal(lines[0].line.event, 'real');
});

test('a circular field does not stop the line being written', async () => {
  const a = {}; a.self = a;
  const lines = await capture((L) => L.logger('x').info('loop', { a }));
  assert.equal(lines[0].line.event, 'loop');
});

const req = (method = 'POST') => new Request('https://fn.local/gate-ops', { method });

test('every line of a request carries the same ref, and the response says which', async () => {
  let res;
  const lines = await capture(async (L) => {
    const log = L.logger('gate-ops');
    res = await L.handle('gate-ops', log, async () => {
      log.info('working');
      L.annotate({ action: 'check_in' });
      return new Response('{}', { status: 200 });
    }, {}, req());
  });
  assert.equal(lines.length, 2);
  const ref = lines[0].line.ref;
  assert.match(ref, /^[0-9A-F]{8}$/);
  assert.equal(lines[1].line.ref, ref);
  assert.equal(res.headers.get('x-talli-ref'), ref);
  assert.equal(lines[1].line.event, 'request');
  assert.equal(lines[1].line.status, 200);
  assert.equal(lines[1].line.action, 'check_in');
  assert.equal(typeof lines[1].line.ms, 'number');
});

test('two requests at once do not share a ref', async () => {
  const lines = await capture(async (L) => {
    const log = L.logger('x');
    const slow = (ms) => () => new Promise((r) => setTimeout(() => { log.info('done'); r(new Response('')); }, ms));
    await Promise.all([L.handle('x', log, slow(20), {}, req()), L.handle('x', log, slow(5), {}, req())]);
  });
  const done = lines.filter((l) => l.line.event === 'done').map((l) => l.line.ref);
  assert.equal(new Set(done).size, 2);
});

test('a handler that throws is logged and answered with the ref alone', async () => {
  let res;
  const lines = await capture(async (L) => {
    res = await L.handle('x', L.logger('x'), async () => {
      throw new Error('relation "secret_table" does not exist');
    }, { cors: { 'Access-Control-Allow-Origin': '*' } }, req());
  });
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json();
  assert.equal(body.code, 'UNEXPECTED');
  assert.ok(!JSON.stringify(body).includes('secret_table'), 'database detail reached the caller');
  assert.ok(body.error.includes(body.ref));
  const unhandled = lines.find((l) => l.line.event === 'unhandled');
  assert.equal(unhandled.level, 'error');
  assert.match(unhandled.line.err.message, /secret_table/);
  assert.equal(lines.at(-1).line.status, 500);
  assert.equal(lines.at(-1).level, 'error');
});

test('4xx is a warning, and a preflight is not logged at all', async () => {
  const lines = await capture(async (L) => {
    const log = L.logger('x');
    await L.handle('x', log, () => new Response('', { status: 409 }), {}, req());
    await L.handle('x', log, () => new Response('ok'), {}, req('OPTIONS'));
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
});

test('a named database error reaches the screen; anything else is logged and hidden', async () => {
  let soldOut, other;
  const lines = await capture(async (L) => {
    const log = L.logger('gate-ops');
    await L.handle('gate-ops', log, async () => {
      soldOut = L.named(log, { message: 'SOLD_OUT: that tier has gone' });
      other = L.named(log, { message: 'insert or update on table "booking" violates foreign key constraint "booking_fk"', code: '23503' });
      return new Response('');
    }, {}, req());
  });
  assert.deepEqual(soldOut, { error: 'SOLD_OUT: that tier has gone', code: 'SOLD_OUT' });
  assert.equal(other.code, 'UNEXPECTED');
  assert.ok(!other.error.includes('booking_fk'));
  assert.match(other.error, new RegExp(other.ref));
  const logged = lines.find((l) => l.line.event === 'unexpected database error');
  assert.equal(logged.line.err.code, '23503');
});

test('outside a request there is no ref, and unexpected() still reads sensibly', async () => {
  const L = await load();
  assert.equal(L.currentRef(), null);
  assert.equal(L.unexpected().error, 'Something went wrong.');
});
