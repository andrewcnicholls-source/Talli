/* =====================================================================
   Contact us (docs/plans/reviews-and-contact.md, slice 2), through
   submit-contact as the homepage form calls it and through gate-ops as
   the Insights tab reads it.

   Done when: a message is taken with the anon key and cannot be read
   back with it; bad input is refused by name; the honeypot keeps
   nothing; with no mail key (as locally and on test) the message waits
   unemailed; and only the operator sees and ticks off messages.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stack, callFn, gate, rest } = require('../lib/stack');

const tag = `TEST contact ${crypto.randomBytes(3).toString('hex')}`;
test.after(() => rest(`contact_message?message=like.${encodeURIComponent(tag)}*`, { method: 'DELETE' }));

const send = (body) => callFn('submit-contact', body);

test('a message is taken, waits unemailed, and the anon key cannot read it', async () => {
  const r = await send({ message: `${tag} six cars?`, name: 'Sam', email: 'sam@example.com' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true });

  const rows = await rest(`contact_message?message=eq.${encodeURIComponent(`${tag} six cars?`)}&select=name,email,emailed_at`);
  assert.deepEqual(rows, [{ name: 'Sam', email: 'sam@example.com', emailed_at: null }]);

  const anon = await fetch(`${stack.apiUrl}/rest/v1/contact_message?select=*`, {
    headers: { apikey: stack.anonKey, Authorization: `Bearer ${stack.anonKey}` },
  });
  const seen = anon.ok ? await anon.json() : [];
  assert.equal(seen.length, 0, 'contact_message is not readable with the anon key');
});

test('bad input is refused by name', async () => {
  assert.equal((await send({ message: '', email: 'a@example.com' })).body.code, 'NO_MESSAGE');
  assert.equal((await send({ message: `${tag} x` })).body.code, 'NO_REPLY');
  assert.equal((await send({ message: `${tag} x`, email: 'nope' })).body.code, 'BAD_EMAIL');
  assert.equal((await send({ message: `${tag} x`, phone: 'call me' })).body.code, 'BAD_PHONE');
});

test('the honeypot is thanked and nothing is kept', async () => {
  const r = await send({ message: `${tag} bot`, email: 'bot@example.com', website: 'http://spam.example' });
  assert.equal(r.status, 200);
  const rows = await rest(`contact_message?message=eq.${encodeURIComponent(`${tag} bot`)}&select=id`);
  assert.equal(rows.length, 0);
});

test('the operator lists and ticks off messages; a warden is refused', async () => {
  await send({ message: `${tag} ring me`, phone: '021 555 0101' });
  const list = await gate('operator', { action: 'contact_messages' });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const mine = list.body.messages.find((m) => m.message === `${tag} ring me`);
  assert.ok(mine, 'the message is listed');
  assert.equal(mine.handled, false);
  assert.equal(mine.emailed, false);

  const done = await gate('operator', { action: 'set_contact_handled', id: mine.id, handled: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const again = await gate('operator', { action: 'contact_messages' });
  assert.equal(again.body.messages.find((m) => m.id === mine.id).handled, true);

  const bad = await gate('operator', { action: 'set_contact_handled', id: mine.id, handled: 'yes' });
  assert.equal(bad.body.code, 'BAD_SWITCH');

  for (const action of ['contact_messages', 'set_contact_handled']) {
    const w = await gate('wardenGrib', { action, id: mine.id, handled: false });
    assert.equal(w.status, 403, action);
    assert.equal(w.body.code, 'OPERATOR_ONLY', action);
  }
});
