/* =====================================================================
   Two buyers, one space, the same instant.

   The database suite proves the counting; this proves the locking. Many
   holds for one remaining space are fired at once over separate
   connections, and exactly one may win.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stack, FIX, rest, plate, forget } = require('../lib/stack');

const made = [];
test.after(() => forget(made));

test('only one of many simultaneous buyers gets the last space', async () => {
  // Fill the berm (2 Standard, none for the gate) down to its last space.
  const first = plate('RA'); made.push(first);
  await rest('rpc/hold_booking', { method: 'POST', body: {
    p_event_id: FIX.night, p_property_id: FIX.berm, p_tier_code: 'standard',
    p_email: 'race.test@example.com', p_rego: first,
  } });

  const buyers = Array.from({ length: 8 }, () => plate('RB'));
  made.push(...buyers);
  const results = await Promise.all(buyers.map((rego) =>
    fetch(`${stack.apiUrl}/rest/v1/rpc/hold_booking`, {
      method: 'POST',
      headers: {
        apikey: stack.serviceKey, Authorization: `Bearer ${stack.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_event_id: FIX.night, p_property_id: FIX.berm, p_tier_code: 'standard',
        p_email: 'race.test@example.com', p_rego: rego,
      }),
    }).then(async (r) => ({ status: r.status, body: await r.text() }))));

  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status !== 200);
  assert.equal(won.length, 1, JSON.stringify(results));
  for (const r of lost) assert.match(r.body, /SOLD_OUT/);

  const live = await rest(`booking?event_id=eq.${FIX.night}&property_id=eq.${FIX.berm}` +
    `&status=eq.held&select=id`);
  assert.equal(live.length, 2, 'the berm holds exactly its two cars');
});
