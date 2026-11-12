/* =====================================================================
   Online checkout and the Stripe webhook.

   Stripe itself is not reachable from the local stack (its key there is
   a stand-in that Stripe refuses), so these cover what the functions
   decide before and after Stripe: what they refuse, that a refused
   checkout gives the space back, and that only a correctly signed
   webhook delivery confirms a booking — once.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FIX, callFn, rest, rpc, plate, forget } = require('../lib/stack');
const { deliver, sessionCompleted: completed } = require('../lib/stripe');

const made = [];
test.after(() => forget(made));

const checkout = (over = {}) => {
  const rego = over.vehicle_rego ?? plate('PC');
  made.push(rego);
  return callFn('create-checkout', {
    event_id: FIX.night, property_id: FIX.berm, tier_code: 'standard',
    email: 'buyer.test@example.com', name: 'Test Buyer', vehicle_rego: rego, ...over,
  });
};

const spotsLeft = async (event, site, code) => {
  const [row] = await rest(`v_tier_availability?event_id=eq.${event}` +
    `&property_id=eq.${site}&code=eq.${code}&select=spots_left`);
  return row.spots_left;
};

test('checkout needs a number plate', async () => {
  const r = await checkout({ vehicle_rego: '' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'PLATE_REQUIRED');
});

test('checkout will not sell a space held for the gate', async () => {
  const r = await checkout({ event_id: FIX.soldOutNight, property_id: FIX.paice });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.code, 'HELD_FOR_GATE');
});

test('a checkout Stripe refuses gives the space straight back', async () => {
  const before = await spotsLeft(FIX.night, FIX.berm, 'standard');
  const rego = plate('PR');
  // amount and price fields are not read; were they, this would be $0.01.
  const r = await checkout({ vehicle_rego: rego, amount_cents: 1, price_cents: 1 });
  assert.equal(r.status, 502, r.text);
  const rows = await rest(`booking?vehicle_rego=eq.${rego}&select=status,amount_cents`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].amount_cents, 3000, 'held at the database price, whatever was sent');
  assert.equal(await spotsLeft(FIX.night, FIX.berm, 'standard'), before);
});

// ---------------------------------------------------------------- webhook

async function heldBooking() {
  const rego = plate('PW');
  made.push(rego);
  return rpc('hold_booking', {
    p_event_id: FIX.night, p_property_id: FIX.gribNeighbour, p_tier_code: 'standard',
    p_email: 'buyer.test@example.com', p_rego: rego,
  });
}

test('a webhook with no signature is refused', async () => {
  const r = await callFn('stripe-webhook', JSON.stringify(completed('x')));
  assert.equal(r.status, 400);
});

test('a webhook signed with the wrong secret confirms nothing', async () => {
  const id = await heldBooking();
  const r = await deliver(completed(id), 'whsec_somebody_else');
  assert.equal(r.status, 400);
  const [row] = await rest(`booking?id=eq.${id}&select=status`);
  assert.equal(row.status, 'held');
});

test('a correctly signed delivery confirms the booking, and a repeat is ignored', async () => {
  const id = await heldBooking();
  const event = completed(id);
  const first = await deliver(event);
  assert.equal(first.status, 200, first.text);
  const [row] = await rest(`booking?id=eq.${id}&select=status`);
  assert.equal(row.status, 'paid');

  const again = await deliver(event);
  assert.equal(again.status, 200);
  assert.match(again.text, /duplicate/);
  const seen = await rest(`processed_webhook_event?stripe_event_id=eq.${event.id}&select=stripe_event_id`);
  assert.equal(seen.length, 1, 'handled once');
});
