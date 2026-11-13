/* =====================================================================
   The Sites page (plan B3), through gate-ops as the screen calls it.

   Done when: a new site goes from address to on sale at three nights
   with no SQL and no visit to Tonight. That is the first test, step by
   step, using only the actions the Sites page sends. The rest are its
   guards, and that a warden is refused every one of them.

   The new site is taken off its nights and switched off at the end, so
   the suites after this one see the calendar they expect.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FIX, gate, rest, plate, forget } = require('../lib/stack');

const made = [];
const suffix = crypto.randomBytes(3).toString('hex');
let siteId = null;
let nights = [];

test.after(async () => {
  await forget(made);
  if (siteId) {
    await gate('operator', { action: 'set_site_nights', property_id: siteId, remove: nights });
    await gate('operator', { action: 'save_site_details', property_id: siteId, active: false });
  }
});

const ok = (r, what) => assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);

test('a new site goes from an address to on sale at three nights, with no SQL and no Tonight', async () => {
  // 1. The address and position, as the Places picker fills them in.
  const add = await gate('operator', {
    action: 'add_site',
    name: `TEST B3 ${suffix}`,
    address: `${suffix} Invented Road, Sandringham (test)`,
    new_host_name: `TEST B3 host ${suffix}`,
    new_block_name: `TEST B3 area ${suffix}`,
    lat: -36.8812, lng: 174.7415, walk_minutes: 12,
  });
  ok(add, 'add_site');
  siteId = add.body.property_id;

  // 2. Its usual spaces.
  ok(await gate('operator', {
    action: 'save_site', property_id: siteId, apply_upcoming: false,
    tiers: [{ code: 'standard', capacity: 3, online: 2 },
      { code: 'priority', capacity: 2, online: 1 },
      { code: 'valet', capacity: 0, online: 0 }],
  }), 'save_site');

  // 3. Three upcoming nights, ticked. The fixture night first: it is the
  //    one the gate is working and is always in the future.
  const setup = await gate('operator', { action: 'sites_setup' });
  ok(setup, 'sites_setup');
  const upcoming = setup.body.nights.map((n) => n.id);
  assert.ok(upcoming.includes(FIX.night), 'the fixture night is listed as upcoming');
  nights = [FIX.night, FIX.soldOutNight,
    ...upcoming.filter((id) => id !== FIX.night && id !== FIX.soldOutNight)].slice(0, 3);
  assert.equal(nights.length, 3, 'the test calendar has three nights to come');

  const tick = await gate('operator', { action: 'set_site_nights', property_id: siteId, add: nights });
  ok(tick, 'set_site_nights');
  assert.equal(tick.body.added, 3);

  // Joined pending, at its usual numbers: not yet on the website.
  const after = await gate('operator', { action: 'sites_setup' });
  const mine = after.body.sites.find((s) => s.property_id === siteId);
  assert.equal(mine.nights.length, 3);
  for (const n of mine.nights) {
    assert.equal(n.status, 'pending', 'joins each night pending');
    const std = n.tiers.find((t) => t.code === 'standard');
    assert.deepEqual([std.capacity, std.online, std.sold], [3, 2, 0], 'at its usual numbers');
  }
  assert.equal(mine.walk_minutes, 12);
  assert.equal(mine.is_anchor, true, 'the first site in its area is the anchor');

  // 4. Confirmed for sale, night by night: the deliberate tap.
  for (const id of nights) {
    ok(await gate('operator', {
      action: 'set_offer_status', event_id: id, property_id: siteId, status: 'confirmed',
    }), 'set_offer_status');
  }

  // On sale: the website can sell its online share on all three.
  const avail = await rest(`v_tier_availability?property_id=eq.${siteId}&code=eq.standard` +
    `&event_id=in.(${nights.join(',')})&select=event_id,spots_left,price_cents`);
  assert.equal(avail.length, 3);
  for (const a of avail) {
    assert.equal(a.spots_left, 2, `two for sale online on ${a.event_id}`);
  }
});

test("one night's numbers move that night only, and never below what has sold", async () => {
  assert.ok(siteId, 'the first test made a site');
  const rego = plate('SP'); made.push(rego);
  const sold = await gate('operator', {
    action: 'sell', event_id: FIX.night, property_id: siteId, tier_code: 'standard',
    payment_method: 'cash', vehicle_rego: rego,
  });
  ok(sold, 'sell');

  const set = await gate('operator', {
    action: 'save_site_night', event_id: FIX.night, property_id: siteId,
    tiers: [{ code: 'standard', capacity: 5, online: 4 }],
  });
  ok(set, 'save_site_night');
  const setup = await gate('operator', { action: 'sites_setup' });
  const mine = setup.body.sites.find((s) => s.property_id === siteId);
  const night = (id) => mine.nights.find((n) => n.event_id === id).tiers.find((t) => t.code === 'standard');
  assert.deepEqual([night(FIX.night).capacity, night(FIX.night).online, night(FIX.night).sold], [5, 4, 1]);
  assert.equal(night(FIX.soldOutNight).capacity, 3, 'another night is untouched');
  assert.equal(mine.defaults.find((d) => d.code === 'standard').capacity, 3, 'so is the usual number');

  const below = await gate('operator', {
    action: 'save_site_night', event_id: FIX.night, property_id: siteId,
    tiers: [{ code: 'standard', capacity: 0, online: 0 }],
  });
  assert.equal(below.status, 409);
  assert.equal(below.body.code, 'BELOW_SOLD');

  // Booked on the fixture night: it cannot be unticked, switched off or moved.
  const untick = await gate('operator', { action: 'set_site_nights', property_id: siteId, remove: [FIX.night] });
  assert.equal(untick.body.code, 'SITE_HAS_BOOKINGS');
  const off = await gate('operator', { action: 'save_site_details', property_id: siteId, active: false });
  assert.equal(off.body.code, 'SITE_HAS_BOOKINGS');
  await forget(made.splice(0));
});

test('details are edited from the page, and a bad one is refused before the database', async () => {
  assert.ok(siteId, 'the first test made a site');
  ok(await gate('operator', {
    action: 'save_site_details', property_id: siteId,
    fill_notes: 'Nose in, tight to the fence', site_guide_url: 'https://example.com/g.jpg',
  }), 'save_site_details');
  const [row] = await rest(`property?id=eq.${siteId}&select=fill_notes,site_guide_url,walk_minutes`);
  assert.deepEqual(row, { fill_notes: 'Nose in, tight to the fence',
    site_guide_url: 'https://example.com/g.jpg', walk_minutes: 12 }, 'a field not sent is left alone');

  const half = await gate('operator', { action: 'save_site_details', property_id: siteId, lat: -36.8 });
  assert.equal(half.status, 400, 'half a position');
  const link = await gate('operator', {
    action: 'save_site_details', property_id: siteId, site_guide_url: 'http://example.com',
  });
  assert.equal(link.body.code, 'BAD_LINK');
});

test('the reference site stays where it is', async () => {
  const r = await gate('operator', { action: 'save_site_details', property_id: FIX.paice, active: false });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERENCE_SITE');
  const [row] = await rest(`property?id=eq.${FIX.paice}&select=active`);
  assert.equal(row.active, true);
});

test("an area's anchor is one of its own sites", async () => {
  const [grib] = await rest(`property?id=eq.${FIX.gribAnchor}&select=block_id`);
  const wrong = await gate('operator', {
    action: 'set_block_anchor', block_id: grib.block_id, property_id: FIX.paice,
  });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'ANCHOR_NOT_IN_AREA');
  const leave = await gate('operator', {
    action: 'save_site_details', property_id: FIX.gribAnchor, active: false,
  });
  assert.ok(['SITE_IS_ANCHOR', 'SITE_HAS_BOOKINGS'].includes(leave.body.code),
    `the anchor does not leave its area: ${JSON.stringify(leave.body)}`);
});

test('a warden is refused every Sites page action, by name', async () => {
  for (const action of ['sites_setup', 'save_site_details', 'add_site', 'set_block_anchor',
    'set_site_nights', 'save_site_night']) {
    const r = await gate('wardenGrib', {
      action, event_id: FIX.night, property_id: FIX.gribAnchor, name: 'x', address: 'y',
    });
    assert.equal(r.status, 403, `${action} should be refused`);
    assert.equal(r.body.code, 'OPERATOR_ONLY', `${action} should be refused by name`);
  }
});
