/* check-setup reports on the project's configuration. Same three checks
   as gate-ops, before anything else runs. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stack, callFn, token } = require('../lib/stack');

test('check-setup refuses the anon key', async () => {
  const r = await callFn('check-setup', {}, stack.anonKey);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_SESSION');
});

test('check-setup refuses a signed-in non-host', async () => {
  const r = await callFn('check-setup', {}, await token('outsider'));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_A_HOST');
});

test('check-setup answers the operator', async () => {
  const r = await callFn('check-setup', {}, await token('operator'));
  assert.equal(r.status, 200, r.text);
});
