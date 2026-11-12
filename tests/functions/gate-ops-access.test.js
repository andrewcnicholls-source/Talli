/* =====================================================================
   Who may use the gate screen, and what a warden may touch.

   Every request below is real: a real session from the local auth
   server, the real gate-ops function, the real database. Nothing is
   mocked, because the thing under test is precisely the server deciding
   for itself who is asking (CLAUDE.md, "Who may open the gate screen").
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stack, FIX, callFn, gate, rest, rpc, plate, forget, forgeToken, token } =
  require('../lib/stack');

const made = [];
test.after(() => forget(made));

async function bookAt(site, tier = 'standard') {
  const rego = plate('GA');
  made.push(rego);
  const id = await rpc('hold_booking', {
    p_event_id: FIX.night, p_property_id: site, p_tier_code: tier,
    p_email: 'gate.test@example.com', p_rego: rego,
  });
  return id;
}

test('no session at all is refused', async () => {
  // The anon key satisfies the gateway's JWT check. It must not satisfy
  // the function's: it is a well-formed token that belongs to nobody.
  const r = await callFn('gate-ops', { action: 'session' }, stack.anonKey);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_SESSION');
});

test('a validly signed token for a user the auth server does not know is refused', async () => {
  // Resolved, not decoded: a token that merely parses and verifies must
  // still name a real, current user.
  const forged = forgeToken({ sub: crypto.randomUUID(), email: 'operator.test@example.com' });
  const r = await callFn('gate-ops', { action: 'session' }, forged);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_SESSION');
});

test('a signed-in account that is not a host is refused by name', async () => {
  const r = await gate('outsider', { action: 'session' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_A_HOST');
});

test('the email comes from the token, never from the request', async () => {
  const r = await gate('outsider', { action: 'session', email: 'operator.test@example.com' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_A_HOST');
});

test('a warden with every block switched off is refused, never widened', async () => {
  const r = await gate('wardenNoGrants', { action: 'session' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NO_BLOCKS');
});

test('the operator gets in and is told so', async () => {
  const r = await gate('operator', { action: 'session' });
  assert.equal(r.status, 200);
  assert.equal(r.body.who.operator, true);
});

test('a warden gets in, as a warden, with their one block', async () => {
  const r = await gate('wardenGrib', { action: 'session' });
  assert.equal(r.status, 200);
  assert.equal(r.body.who.operator, false);
  assert.equal(r.body.who.blocks.length, 1);
});

test('a warden is refused every operator-only action', async () => {
  for (const action of ['set_price', 'set_capacity', 'set_reserve', 'set_event_status',
    'create_event', 'sites_setup', 'save_site', 'create_site', 'apply_price_template']) {
    const r = await gate('wardenGrib', { action, event_id: FIX.night });
    assert.equal(r.status, 403, `${action} should be refused`);
    assert.equal(r.body.code, 'OPERATOR_ONLY', `${action} should be refused by name`);
  }
});

test("a warden's list holds only their own block's sites and cars", async () => {
  const mine = await bookAt(FIX.gribAnchor);
  const theirs = await bookAt(FIX.paice);
  const r = await gate('wardenGrib', { action: 'list', event_id: FIX.night });
  assert.equal(r.status, 200);
  const ids = r.body.rows.map((x) => x.booking_id);
  assert.ok(ids.includes(mine), 'sees the car at Gribblehurst');
  assert.ok(!ids.includes(theirs), 'does not see the car at Paice Ave');
  const sites = new Set(r.body.tiers.map((t) => t.property_id));
  assert.deepEqual([...sites].sort(), [FIX.gribAnchor, FIX.gribNeighbour].sort());

  const all = await gate('operator', { action: 'list', event_id: FIX.night });
  const allIds = all.body.rows.map((x) => x.booking_id);
  assert.ok(allIds.includes(mine) && allIds.includes(theirs), 'the operator sees both');
});

test("a warden cannot touch another block's booking", async () => {
  const theirs = await bookAt(FIX.paice);
  const r = await gate('wardenGrib', { action: 'check_in', booking_id: theirs });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_YOUR_SITE');
  const [row] = await rest(`booking?id=eq.${theirs}&select=checked_in_at`);
  assert.equal(row.checked_in_at, null, 'and nothing happened to it');
});

test("a warden cannot sell at another block's site", async () => {
  const rego = plate('GS'); made.push(rego);
  const r = await gate('wardenGrib', {
    action: 'sell', event_id: FIX.night, property_id: FIX.paice,
    tier_code: 'standard', payment_method: 'cash', vehicle_rego: rego,
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_YOUR_SITE');
});

test('a warden sells a walk-up for cash at their own site, at the database price', async () => {
  const rego = plate('GW'); made.push(rego);
  const r = await gate('wardenGrib', {
    action: 'sell', event_id: FIX.night, property_id: FIX.gribAnchor,
    tier_code: 'standard', payment_method: 'cash', vehicle_rego: rego,
    amount_cents: 1, // not a field gate-ops reads; must change nothing
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.charge_cents, 4000);
  const [row] = await rest(`booking?id=eq.${r.body.booking_id}&select=status,amount_cents,channel`);
  assert.deepEqual(row, { status: 'paid', amount_cents: 4000, channel: 'gate' });
});

test('tap to pay is refused to a warden', async () => {
  const rego = plate('GT'); made.push(rego);
  const r = await gate('wardenGrib', {
    action: 'sell', event_id: FIX.night, property_id: FIX.gribAnchor,
    tier_code: 'standard', payment_method: 'tap_to_pay', vehicle_rego: rego,
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'OPERATOR_ONLY');
});

test('bank details reach a signed-in warden and nobody else', async () => {
  const ok = await gate('wardenGrib', { action: 'bank_details' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.account_number, 'the warden is given the account');
  const anon = await callFn('gate-ops', { action: 'bank_details' }, stack.anonKey);
  assert.equal(anon.status, 401);
  const outsider = await callFn('gate-ops', { action: 'bank_details' }, await token('outsider'));
  assert.equal(outsider.status, 403);
});
