/* =====================================================================
   Booking history, through gate-ops (20261130100000_talli_booking_history).

   Done when a booking opened on the gate screen says who made it, when,
   and what has happened since — named by the person's name — and:

     - "who" is the verified caller, never anything in the request body;
     - a warden reads the history only of a booking they could edit;
     - a warden is invited with a name, and only the operator renames.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FIX, gate, rest, plate, forget } = require('../lib/stack');

const made = [];
test.after(() => forget(made));

async function nameOf(who) {
  const r = await gate(who, { action: 'session' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const email = r.body.who.email;
  const [row] = await rest(`host_user?email=eq.${encodeURIComponent(email)}&select=id,name`);
  return row;
}

test('a gate sale says who made it, by name, and what happened', async () => {
  const rego = plate('BH'); made.push(rego);
  const sold = await gate('wardenGrib', {
    action: 'sell', event_id: FIX.night, property_id: FIX.gribAnchor,
    tier_code: 'standard', payment_method: 'cash', vehicle_rego: rego,
    by: '00000000-0000-0000-0000-000000000000', // not a field gate-ops reads
  });
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const me = await nameOf('wardenGrib');

  const r = await gate('wardenGrib', { action: 'booking_history', booking_id: sold.body.booking_id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const kinds = r.body.lines.map((l) => l.kind);
  for (const k of ['created', 'paid', 'checked_in']) assert.ok(kinds.includes(k), `has ${k}: ${kinds}`);
  for (const l of r.body.lines) assert.equal(l.by_name, me.name, `${l.kind} names the warden`);
  assert.equal(r.body.lines[0].kind, 'created', 'oldest first');
});

test('an edit at the gate is put down to the person who made it', async () => {
  const rego = plate('BE'); made.push(rego);
  const sold = await gate('operator', {
    action: 'sell', event_id: FIX.night, property_id: FIX.gribAnchor,
    tier_code: 'standard', payment_method: 'unpaid', vehicle_rego: rego,
  });
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const e = await gate('wardenGrib', {
    action: 'edit_booking', booking_id: sold.body.booking_id, payment_method: 'bank_transfer',
  });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const me = await nameOf('wardenGrib');
  const op = await nameOf('operator');

  const r = await gate('operator', { action: 'booking_history', booking_id: sold.body.booking_id });
  const created = r.body.lines.find((l) => l.kind === 'created');
  const pay = r.body.lines.find((l) => l.kind === 'payment');
  assert.equal(created.by_name, op.name, 'the operator made it');
  assert.equal(pay.by_name, me.name, 'the warden marked it paid');
  assert.equal(pay.before.payment_method, 'unpaid');
  assert.equal(pay.after.payment_method, 'bank_transfer');
});

test("a warden cannot read the history of another block's booking", async () => {
  const rego = plate('BP'); made.push(rego);
  const sold = await gate('operator', {
    action: 'sell', event_id: FIX.night, property_id: FIX.paice,
    tier_code: 'standard', payment_method: 'cash', vehicle_rego: rego,
  });
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const edit = await gate('wardenGrib', {
    action: 'edit_booking', booking_id: sold.body.booking_id, notes: 'x',
  });
  const r = await gate('wardenGrib', { action: 'booking_history', booking_id: sold.body.booking_id });
  assert.equal(r.status, edit.status, 'refused as editing it is');
  assert.equal(r.body.code, edit.body.code);
  assert.equal(r.body.lines, undefined, 'and nothing is read out');
});

test('a warden cannot be invited without a name', async () => {
  const [b] = await rest('block?name=eq.Gribblehurst%20(test)&select=id');
  const r = await gate('operator', { action: 'invite_warden',
    email: 'history.noname@example.com', block_ids: [b.id] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_NAME');
  const rows = await rest('host_user?email=eq.history.noname@example.com&select=id');
  assert.equal(rows.length, 0, 'and nobody was invited');
});

test('the operator corrects a name, and People shows it', async () => {
  const me = await nameOf('wardenPaice');
  try {
    const r = await gate('operator', { action: 'rename_staff', host_user_id: me.id, name: '  Paice Person ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = await gate('operator', { action: 'staff_list' });
    const row = list.body.people.find((p) => p.host_user_id === me.id);
    assert.equal(row.name, 'Paice Person');

    const blank = await gate('operator', { action: 'rename_staff', host_user_id: me.id, name: ' ' });
    assert.equal(blank.status, 409);
    assert.equal(blank.body.code, 'NO_NAME');
  } finally {
    await rest(`host_user?id=eq.${me.id}`, { method: 'PATCH', body: { name: me.name } });
  }
});
