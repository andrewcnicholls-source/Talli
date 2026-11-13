/* =====================================================================
   Where a car goes, and spaces lost on the night (plan B5), through
   gate-ops: what a warden may do, and only at their own sites.

   The order cars are placed in, and Standard spilling into Priority, are
   proved in the database suite (09_placement_oversell_lost). These check
   the function passes them through and keeps a warden to their block.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FIX, gate, rest, rpc, plate, forget } = require('../lib/stack');

const made = [];
test.after(async () => {
  await forget(made);
  await rest(`lost_space?event_id=eq.${FIX.night}`, { method: 'DELETE' });
});

async function onlineCar(site) {
  const rego = plate('PL');
  made.push(rego);
  const id = await rpc('hold_booking', {
    p_event_id: FIX.night, p_property_id: site, p_tier_code: 'standard',
    p_email: 'placement.test@example.com', p_rego: rego,
  });
  await rpc('confirm_booking', { p_booking_id: id, p_payment_intent_id: null });
  return id;
}

const tierAt = (list, site, code) =>
  list.body.tiers.find((t) => t.property_id === site && t.code === code);

test('a warden records a lost space at their own site, and can undo it', async () => {
  const before = tierAt(await gate('wardenGrib', { action: 'list' }), FIX.gribAnchor, 'priority');

  const r = await gate('wardenGrib', {
    action: 'lose_space', property_id: FIX.gribAnchor, tier_code: 'priority',
    reason: 'bad_parking', note: 'across two',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const after = await gate('wardenGrib', { action: 'list' });
  const t = tierAt(after, FIX.gribAnchor, 'priority');
  assert.equal(t.lost, (before.lost ?? 0) + 1);
  assert.equal(t.spots_left_gate, Math.max(0, before.spots_left_gate - 1));
  assert.ok(after.body.lost.some((l) => l.id === r.body.id), 'it is listed for the night');
  assert.ok(after.body.summary.lost >= 1, 'and is its own line in the totals');

  const undo = await gate('wardenGrib', { action: 'undo_lost_space', id: r.body.id });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const back = tierAt(await gate('wardenGrib', { action: 'list' }), FIX.gribAnchor, 'priority');
  assert.equal(back.spots_left_gate, before.spots_left_gate);
});

test('a lost space needs a reason, and a type the site has', async () => {
  const noWhy = await gate('wardenGrib', {
    action: 'lose_space', property_id: FIX.gribAnchor, tier_code: 'standard', reason: '',
  });
  assert.equal(noWhy.status, 409);
  assert.equal(noWhy.body.code, 'BAD_REASON');
  const noType = await gate('wardenGrib', {
    action: 'lose_space', property_id: FIX.gribAnchor, tier_code: 'valet', reason: 'blocked',
  });
  assert.equal(noType.status, 409);
  assert.equal(noType.body.code, 'NO_TIER');
});

test('a warden cannot lose, or undo, a space at another block', async () => {
  const r = await gate('wardenGrib', {
    action: 'lose_space', property_id: FIX.paice, tier_code: 'standard', reason: 'blocked',
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_YOUR_SITE');

  const theirs = await gate('operator', {
    action: 'lose_space', property_id: FIX.paice, tier_code: 'standard', reason: 'blocked',
  });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const undo = await gate('wardenGrib', { action: 'undo_lost_space', id: theirs.body.id });
  assert.equal(undo.status, 403);
  assert.equal(undo.body.code, 'NOT_YOUR_SITE');
  const [row] = await rest(`lost_space?id=eq.${theirs.body.id}&select=undone_at`);
  assert.equal(row.undone_at, null, 'and it is still lost');
});

test('ticking a car in says where it went', async () => {
  const id = await onlineCar(FIX.gribAnchor);
  const r = await gate('wardenGrib', {
    action: 'check_in', booking_id: id, property_id: FIX.gribAnchor,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.placed.property_id, FIX.gribAnchor);
  assert.equal(r.body.placed.space_code, 'standard');
  assert.equal(r.body.placed.no_room, false);
});

test('a warden moves a car within their block, never out of it', async () => {
  const id = await onlineCar(FIX.gribAnchor);
  await gate('wardenGrib', { action: 'check_in', booking_id: id, property_id: FIX.gribAnchor });

  const out = await gate('wardenGrib', {
    action: 'place', booking_id: id, property_id: FIX.paice, space_code: 'standard',
  });
  assert.equal(out.status, 403);
  assert.equal(out.body.code, 'NOT_YOUR_SITE');

  const valet = await gate('wardenGrib', {
    action: 'place', booking_id: id, property_id: FIX.gribNeighbour, space_code: 'valet',
  });
  assert.equal(valet.status, 409);
  assert.equal(valet.body.code, 'WRONG_SPACE');

  const moved = await gate('wardenGrib', {
    action: 'place', booking_id: id, property_id: FIX.gribNeighbour, space_code: 'standard',
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const [row] = await rest(`booking?id=eq.${id}&select=property_id,space_code`);
  assert.deepEqual(row, { property_id: FIX.gribNeighbour, space_code: null });
});

test('a full Standard tells the walk-up form where the next sale goes', async () => {
  // Lose every free Standard space at the anchor, as the operator.
  const t = tierAt(await gate('operator', { action: 'list' }), FIX.gribAnchor, 'standard');
  for (let i = 0; i < t.spots_left_gate; i++) {
    const r = await gate('operator', {
      action: 'lose_space', property_id: FIX.gribAnchor, tier_code: 'standard', reason: 'blocked',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const full = tierAt(await gate('wardenGrib', { action: 'list' }), FIX.gribAnchor, 'standard');
  assert.equal(full.spots_left_gate, 0);
  assert.ok(full.spill, 'the full tile still sells');
  assert.equal(full.spill.property_id, FIX.gribNeighbour);
  assert.equal(full.spill.space_code, 'standard');

  const rego = plate('PS'); made.push(rego);
  const sold = await gate('wardenGrib', {
    action: 'sell', property_id: FIX.gribAnchor, tier_code: 'standard',
    payment_method: 'cash', vehicle_rego: rego,
  });
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  assert.equal(sold.body.placed.property_id, FIX.gribNeighbour);
  assert.equal(sold.body.charge_cents, 4000, 'at the Standard price');
});
