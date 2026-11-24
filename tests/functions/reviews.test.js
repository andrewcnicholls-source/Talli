/* =====================================================================
   Rate us (docs/plans/reviews-and-contact.md), through submit-review as
   the homepage form calls it, and through gate-ops as the Insights tab
   reads it.

   Done when: anyone can send a review with the anon key and nobody can
   read one back with it; a review from a booking lands against where
   the car actually was; the honeypot keeps nothing; and only the
   operator sees what was said.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FIX, stack, callFn, gate, rest, rpc, plate, forget } = require('../lib/stack');

const made = [];
const tag = `TEST review ${crypto.randomBytes(3).toString('hex')}`;

test.after(async () => {
  await rest(`review?comment=like.${encodeURIComponent(tag)}*`, { method: 'DELETE' });
  await forget(made);
});

const send = (body) => callFn('submit-review', body);

test('the sites to pick from are the active ones, by name and nothing more', async () => {
  const r = await send({ action: 'options' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const paice = r.body.sites.find((s) => s.id === FIX.paice);
  assert.deepEqual(paice, { id: FIX.paice, label: '86 Paice Ave' });
});

test('a homepage review is taken, and the anon key cannot read it back', async () => {
  const r = await send({ rating: 5, comment: `${tag} homepage`, name: 'Sam',
    property_id: FIX.paice, easy_to_find: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.from_booking, false);

  const [row] = await rest(`review?id=eq.${r.body.id}&select=rating,property_id,easy_to_find,source`);
  assert.deepEqual(row, { rating: 5, property_id: FIX.paice, easy_to_find: true, source: 'homepage' });

  // Straight at PostgREST with the anon key, as a browser could.
  const anon = await fetch(`${stack.apiUrl}/rest/v1/review?select=*`, {
    headers: { apikey: stack.anonKey, Authorization: `Bearer ${stack.anonKey}` },
  });
  const seen = anon.ok ? await anon.json() : [];
  assert.equal(seen.length, 0, 'the review table is not readable with the anon key');
});

test('bad input is refused by name', async () => {
  assert.equal((await send({ rating: 0 })).body.code, 'BAD_RATING');
  assert.equal((await send({ rating: 'five' })).body.code, 'BAD_RATING');
  assert.equal((await send({ rating: 4, property_id: 'nope' })).body.code, 'NO_SITE');
  assert.equal((await send({ rating: 4, comment: 'x'.repeat(2001) })).body.code, 'TOO_LONG');
  assert.equal((await send({ rating: 4, session_id: 'cs_not_a_booking' })).body.code, 'NO_BOOKING');
});

test('the honeypot is thanked and nothing is kept', async () => {
  const r = await send({ rating: 1, comment: `${tag} bot`, website: 'http://spam.example' });
  assert.equal(r.status, 200);
  const rows = await rest(`review?comment=eq.${encodeURIComponent(`${tag} bot`)}&select=id`);
  assert.equal(rows.length, 0);
});

test('a review from a booking goes where the car actually was, once', async () => {
  const rego = plate('RV');
  made.push(rego);
  const id = await rpc('hold_booking', {
    p_event_id: FIX.night, p_property_id: FIX.gribAnchor, p_tier_code: 'standard',
    p_email: 'review.test@example.com', p_rego: rego,
  });
  await rpc('confirm_booking', { p_booking_id: id, p_payment_intent_id: null });
  const session = `cs_test_${crypto.randomBytes(8).toString('hex')}`;
  await rest(`booking?id=eq.${id}`, { method: 'PATCH', body: {
    stripe_checkout_session_id: session, property_id: FIX.gribNeighbour } });

  const first = await send({ rating: 2, comment: `${tag} booking`, session_id: session,
    property_id: FIX.paice, easy_to_leave: false });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.from_booking, true);

  const again = await send({ rating: 4, comment: `${tag} booking, on reflection`, session_id: session });
  assert.equal(again.body.updated, true);

  const rows = await rest(`review?booking_id=eq.${id}&select=rating,property_id,event_id,source`);
  assert.deepEqual(rows, [{ rating: 4, property_id: FIX.gribNeighbour, event_id: FIX.night, source: 'booking' }]);
});

test('the operator reads the reviews; a warden is refused', async () => {
  const op = await gate('operator', { action: 'reviews' });
  assert.equal(op.status, 200, JSON.stringify(op.body));
  assert.ok(op.body.overall.count >= 2);
  assert.ok(op.body.latest.some((r) => (r.comment || '').startsWith(tag)));
  assert.ok(op.body.sites.some((s) => s.property_id === FIX.paice));

  const warden = await gate('wardenGrib', { action: 'reviews' });
  assert.equal(warden.status, 403);
  assert.equal(warden.body.code, 'OPERATOR_ONLY');
});
