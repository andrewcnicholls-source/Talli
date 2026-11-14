/* =====================================================================
   Settlement (plan B7), through gate-ops: Andrew's alone.

   The arithmetic — the split, spaces provided, moving cars, a price rise,
   a lost space, refunds, to the cent — is proved in the database suite
   (11_host_settlement). These check the function passes it through to the
   operator, refuses every part of it to a warden, and that nothing in a
   request body becomes an amount owed.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FIX, gate, rest, rpc, plate, forget } = require('../lib/stack');

const HOST_A = '11111111-1111-1111-1111-1111111111a1';

const made = [];
test.after(async () => {
  await forget(made);
  await rest(`host?id=eq.${HOST_A}`, {
    method: 'PATCH', body: { email: 'host.a@example.com', payout_notes: null },
  });
});

const ACTIONS = ['settlement', 'save_warden_allocation', 'settle_night', 'reopen_settlement',
  'save_settlement_setting', 'save_host_details'];

test('a warden is refused every part of settlement', async () => {
  for (const action of ACTIONS) {
    const r = await gate('wardenGrib', { action, event_id: FIX.night, block_id: 'x', lines: [] });
    assert.equal(r.status, 403, `${action} should be refused`);
    assert.equal(r.body.code, 'OPERATOR_ONLY', `${action} should be refused by name`);
  }
});

const gribOf = (report) => report.blocks.find((b) => b.name === 'Gribblehurst (test)');

test("the operator's report adds up, block by block, to the cent", async () => {
  const rego = plate('ST');
  made.push(rego);
  const id = await rpc('hold_booking', {
    p_event_id: FIX.night, p_property_id: FIX.gribAnchor, p_tier_code: 'standard',
    p_email: 'settlement.test@example.com', p_rego: rego,
  });
  await rpc('confirm_booking', { p_booking_id: id, p_payment_intent_id: null });

  const r = await gate('operator', { action: 'settlement', event_id: FIX.night });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.blocks.length >= 2, 'both areas on the fixture night');
  for (const b of r.body.blocks) {
    const f = b.figures;
    assert.equal(f.talli_cents + f.wardens_cents + f.hosts_cents, f.net_cents,
      `${b.name}: the shares add up to the takings`);
    assert.equal(f.hosts.reduce((n, h) => n + h.amount_cents, 0), f.hosts_cents,
      `${b.name}: the host lines add up to the hosts' pool`);
  }
  const grib = gribOf(r.body);
  assert.ok(grib.figures.parking_cents > 0, 'the booking is in its area');
  assert.equal(grib.figures.hosts.length, 2, 'both hosts in the area are listed');
});

test('an allocation that does not add up is refused, and a night on sale is not settled', async () => {
  const r = await gate('operator', { action: 'settlement', event_id: FIX.night });
  const grib = gribOf(r.body);
  const who = grib.people[0]?.host_user_id;
  assert.ok(who, 'someone is offered to allocate to');

  const off = await gate('operator', {
    action: 'save_warden_allocation', event_id: FIX.night, block_id: grib.block_id,
    lines: [{ host_user_id: who, amount_cents: grib.figures.wardens_cents + 1 }],
  });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'ALLOCATION_NOT_EQUAL');

  const settle = await gate('operator', {
    action: 'settle_night', event_id: FIX.night, block_id: grib.block_id,
  });
  assert.equal(settle.status, 409);
  assert.equal(settle.body.code, 'NIGHT_NOT_CLOSED');
});

test("a host's real email and payout notes are saved, and a bad email is refused", async () => {
  const bad = await gate('operator', { action: 'save_host_details', host_id: HOST_A, email: 'nope' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'BAD_EMAIL');

  const ok = await gate('operator', {
    action: 'save_host_details', host_id: HOST_A,
    email: 'Host.A.Real@Example.com', payout_notes: 'Invented test account',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.host.email, 'host.a.real@example.com');
  assert.equal(ok.body.host.payout_notes, 'Invented test account');
});

test('the percentages must add up to 100%', async () => {
  const r = await gate('operator', { action: 'save_settlement_setting', talli_parking_bps: 5000 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SPLIT_NOT_100');
});
