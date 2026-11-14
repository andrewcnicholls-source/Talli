/* =====================================================================
   Warden access (plan B8), through gate-ops.

   Done when Andrew can invite a warden by email with their areas, switch
   an area on or off, and deactivate them, all from the screen, without
   weakening any of this:

     - the three sign-in checks (the token resolved, the email confirmed,
       the email looked up in host_user);
     - NO_BLOCKS for a warden with every area off, never "everything";
     - the email comes from the verified token, never the request body.

   And, for every operator-only action there is, a warden is refused. The
   list is read from auth.ts itself, so a new action is covered the day it
   is added to OPERATOR_ONLY.

   The invitation is claimed the way a real one is: a brand-new account on
   the local auth server signs in, and gate-ops matches its verified email
   to the row Andrew made. Nothing is written into host_user by hand.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, stack, PASSWORD, FIX, gate, callFn, signIn, rest } = require('../lib/stack');

const AUTH_TS = path.join(ROOT, 'supabase', 'functions', 'gate-ops', 'auth.ts');

function operatorOnly() {
  const src = fs.readFileSync(AUTH_TS, 'utf8');
  const m = src.match(/export const OPERATOR_ONLY = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'OPERATOR_ONLY found in auth.ts');
  const names = [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.ok(names.length > 20, 'OPERATOR_ONLY read in full');
  return names;
}

test('a warden is refused every operator-only action, by name', async () => {
  for (const who of ['wardenGrib', 'wardenPaice']) {
    for (const action of operatorOnly()) {
      const r = await gate(who, {
        action, event_id: FIX.night, block_id: 'x', host_user_id: 'x', email: 'x@example.com',
        block_ids: [], on: true, active: true, lines: [], tiers: [],
      });
      assert.equal(r.status, 403, `${who}: ${action} should be refused`);
      assert.equal(r.body?.code, 'OPERATOR_ONLY', `${who}: ${action} should be refused by name`);
    }
  }
});

// --------------------------------------------------- a real invitation

const API = stack.apiUrl;
const admin = { apikey: stack.serviceKey, Authorization: `Bearer ${stack.serviceKey}`,
  'Content-Type': 'application/json' };

let newEmail = null;
let newUserId = null;

async function makeAccount(email) {
  const res = await fetch(`${API}/auth/v1/admin/users`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  assert.ok(res.ok, `local account made: ${JSON.stringify(body)}`);
  return body.id;
}

test.after(async () => {
  if (newEmail) await rest(`host_user?email=eq.${encodeURIComponent(newEmail)}`, { method: 'DELETE' });
  if (newUserId) await fetch(`${API}/auth/v1/admin/users/${newUserId}`, { method: 'DELETE', headers: admin });
});

async function gribBlock() {
  const [b] = await rest('block?name=eq.Gribblehurst%20(test)&select=id');
  return b.id;
}

async function asNew(body) {
  const s = await signIn(newEmail);
  return callFn('gate-ops', body, s.access_token);
}

test('an invited warden signs in, sees their one area, and follows every switch', async () => {
  const grib = await gribBlock();
  newEmail = `b8.${crypto.randomBytes(4).toString('hex')}@example.com`;

  // Not on the books yet: refused, exactly as any stranger is.
  newUserId = await makeAccount(newEmail);
  let r = await asNew({ action: 'session' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_A_HOST');

  // Andrew invites them, typed with capitals and spaces.
  r = await gate('operator', { action: 'invite_warden',
    email: `  ${newEmail.toUpperCase()} `, block_ids: [grib] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.email, newEmail, 'stored as one address, lower case');
  const id = r.body.host_user_id;

  const list = await gate('operator', { action: 'staff_list' });
  assert.equal(list.status, 200);
  const line = list.body.people.find((p) => p.host_user_id === id);
  assert.equal(line.scope, 'blocks', 'a warden, never an operator');
  assert.equal(line.claimed, false, 'unclaimed until they sign in');
  assert.deepEqual(line.blocks.map((g) => [g.block_id, g.active]), [[grib, true]]);
  assert.equal(line.invited_by, 'operator.test@example.com', 'who invited them is kept');

  // They sign in: the invitation is claimed, and they see one area.
  r = await asNew({ action: 'session' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.who.operator, false);
  assert.deepEqual(r.body.who.blocks, [grib]);

  // And they are a warden in every way: an operator action is refused.
  r = await asNew({ action: 'staff_list' });
  assert.equal(r.body.code, 'OPERATOR_ONLY');

  // Every area off: turned away, never widened.
  r = await gate('operator', { action: 'set_warden_block', host_user_id: id, block_id: grib, on: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await asNew({ action: 'session' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NO_BLOCKS');

  r = await gate('operator', { action: 'set_warden_block', host_user_id: id, block_id: grib, on: true });
  assert.equal(r.status, 200);
  r = await asNew({ action: 'session' });
  assert.equal(r.status, 200);

  // Deactivated: refused on the very next request, though still signed in.
  r = await gate('operator', { action: 'set_warden_active', host_user_id: id, active: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await asNew({ action: 'session' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_A_HOST');

  r = await gate('operator', { action: 'set_warden_active', host_user_id: id, active: true });
  assert.equal(r.status, 200);
  r = await asNew({ action: 'session' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.who.blocks, [grib]);
});

test('an invitation for someone already on the books, or with no area, is refused by name', async () => {
  const grib = await gribBlock();
  let r = await gate('operator', { action: 'invite_warden',
    email: 'Operator.Test@example.com', block_ids: [grib] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ALREADY_ON_BOOKS');

  r = await gate('operator', { action: 'invite_warden', email: 'not an email', block_ids: [grib] });
  assert.equal(r.body.code, 'BAD_EMAIL');

  r = await gate('operator', { action: 'invite_warden', email: 'b8.none@example.com', block_ids: [] });
  assert.equal(r.body.code, 'NO_BLOCKS_CHOSEN');

  r = await gate('operator', { action: 'invite_warden', email: 'b8.none@example.com',
    block_ids: [crypto.randomUUID()] });
  assert.equal(r.body.code, 'UNKNOWN_BLOCK');

  const none = await rest('host_user?email=eq.b8.none@example.com&select=id');
  assert.equal(none.length, 0, 'nothing was half-made');
});

test('an operator is never changed from the screen', async () => {
  const list = await gate('operator', { action: 'staff_list' });
  const me = list.body.people.find((p) => p.email === 'operator.test@example.com');
  assert.equal(me.scope, 'all');

  let r = await gate('operator', { action: 'set_warden_active', host_user_id: me.host_user_id, active: false });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_A_WARDEN');

  r = await gate('operator', { action: 'set_warden_block', host_user_id: me.host_user_id,
    block_id: await gribBlock(), on: false });
  assert.equal(r.body.code, 'NOT_A_WARDEN');

  // Still the operator.
  r = await gate('operator', { action: 'session' });
  assert.equal(r.status, 200);
  assert.equal(r.body.who.operator, true);
});

test('a switch that is not plainly on or off is not read as either', async () => {
  const [w] = await rest('host_user?email=eq.warden.test@example.com&select=id');
  for (const on of ['false', 0, null, undefined]) {
    const r = await gate('operator', { action: 'set_warden_block', host_user_id: w.id,
      block_id: await gribBlock(), on });
    assert.equal(r.status, 400, `on = ${JSON.stringify(on)}`);
    assert.equal(r.body.code, 'BAD_SWITCH');
  }
  const [g] = await rest(`staff_block_access?host_user_id=eq.${w.id}&select=active`);
  assert.equal(g.active, true, 'the seeded warden still has their area');
});
