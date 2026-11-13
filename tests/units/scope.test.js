/* =====================================================================
   assets/admin/scope.js — the selector's arithmetic (plan B6).

   "Done when: totals for each site add up to the block, and blocks to
   all, on every tab." Every tab's figures come from scopeNight(), so
   this proves it once, on a night made to be awkward: two blocks, a car
   moved from one site to another, card and cash, extras, a lost space,
   a pay-later walk-up and a hold mid-checkout.

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(
  path.join(__dirname, '..', '..', 'assets', 'admin', 'scope.js')).href);

const sites = [
  { property_id: 'p1', name: 'Paice', block_id: 'bP', block_name: 'Paice', is_anchor: true },
  { property_id: 'g1', name: 'Grib 72', block_id: 'bG', block_name: 'Gribblehurst', is_anchor: true },
  { property_id: 'g2', name: 'Grib 74', block_id: 'bG', block_name: 'Gribblehurst', is_anchor: false },
];

const tier = (property_id, code, capacity, sold, lost = 0) =>
  ({ property_id, code, capacity, sold, lost });
const tiers = [
  tier('p1', 'standard', 10, 4), tier('p1', 'priority', 4, 1),
  tier('g1', 'standard', 6, 5, 1), tier('g1', 'priority', 2, 0),
  tier('g2', 'standard', 5, 2),
];

let n = 0;
const row = (property_id, more) => Object.assign({
  booking_id: 'b' + (++n), property_id, status: 'paid', payment_method: 'stripe',
  channel: 'online', arrived: false, amount_cents: 3000, addons_cents: 0,
  surcharge_cents: 0, addons_pending: 0, addons: [],
}, more);
const rows = [
  row('p1', { arrived: true, surcharge_cents: 120 }),
  row('p1', { payment_method: 'cash', channel: 'gate', amount_cents: 2500 }),
  row('p1', { addons_cents: 500, addons_pending: 1,
    addons: [{ code: 'poncho', name: 'Poncho', qty: 1, handed: false }] }),
  row('g1', { arrived: true, payment_method: 'bank_transfer', channel: 'gate' }),
  // Booked at g1, parked at g2: it counts once, where it is.
  row('g2', { booked_property_id: 'g1', arrived: true, addons_cents: 1000,
    addons: [{ code: 'poncho', name: 'Poncho', qty: 2, handed: true }] }),
  row('g2', { status: 'held', payment_method: 'unpaid', channel: 'gate', owes: true }),
  row('g1', { status: 'held', in_checkout: true }),
];
const lost = [{ id: 'l1', property_id: 'g1', tier_code: 'standard' }];
const night = { rows, tiers, sites, lost };

const NUMBERS = ['total', 'arrived', 'unpaid_holds', 'owing', 'owing_cents', 'capacity',
  'filled', 'lost', 'free', 'cash_due_cents', 'taken_cents', 'online_cents', 'gate_cents',
  'addons_cents', 'surcharge_cents', 'extras_pending'];

function add(parts) {
  const out = {};
  for (const k of NUMBERS) out[k] = parts.reduce((s, p) => s + p.summary[k], 0);
  return out;
}
const pick = (summary) => Object.fromEntries(NUMBERS.map((k) => [k, summary[k]]));

test('sites add up to their block, and blocks to all, for every figure', async () => {
  const { scopeNight } = await load();
  const all = scopeNight(night, 'all');
  const paice = scopeNight(night, 'block:bP');
  const grib = scopeNight(night, 'block:bG');

  assert.deepEqual(add([scopeNight(night, 'site:p1')]), pick(paice.summary));
  assert.deepEqual(add([scopeNight(night, 'site:g1'), scopeNight(night, 'site:g2')]),
    pick(grib.summary));
  assert.deepEqual(add([paice, grib]), pick(all.summary));

  // And the rows themselves: every car in exactly one site.
  assert.equal(all.rows.length, rows.length);
  assert.equal(paice.rows.length + grib.rows.length, rows.length);
  assert.equal(all.lost.length, 1);
  assert.equal(grib.lost.length, 1);
  assert.equal(paice.lost.length, 0);
});

test('with every site in scope, the figures are the ones the server counts', async () => {
  const { scopeNight } = await load();
  const s = scopeNight(night, 'all').summary;
  assert.equal(s.total, 7);
  assert.equal(s.arrived, 3);
  assert.equal(s.capacity, 27);
  assert.equal(s.filled, 12);
  assert.equal(s.lost, 1);
  assert.equal(s.free, 27 - 12 - 1);
  // Paid: 3000+120, 2500, 3000+500, 3000, 3000+1000.
  assert.equal(s.taken_cents, 3120 + 2500 + 3500 + 3000 + 4000);
  assert.equal(s.online_cents, 3120 + 3500 + 4000);
  assert.equal(s.gate_cents, 2500 + 3000);
  assert.equal(s.owing, 1);
  assert.equal(s.unpaid_holds, 1);
  // Cash and bank transfer not yet arrived (the pay-later walk-up is
  // owed, not due): the cash car only.
  assert.equal(s.cash_due_cents, 2500);
});

test('the car moved to another site is counted where it is', async () => {
  const { scopeNight } = await load();
  assert.equal(scopeNight(night, 'site:g2').summary.arrived, 1);
  assert.equal(scopeNight(night, 'site:g1').summary.arrived, 1);
});

test('extras are counted per scope and add up', async () => {
  const { scopeNight } = await load();
  assert.deepEqual(scopeNight(night, 'all').extras,
    [{ code: 'poncho', name: 'Poncho', total: 3, pending: 1 }]);
  assert.deepEqual(scopeNight(night, 'block:bG').extras,
    [{ code: 'poncho', name: 'Poncho', total: 2, pending: 0 }]);
});

test('the selector offers a tree, and "all" only when it is theirs', async () => {
  const { scopeOptions } = await load();
  assert.deepEqual(scopeOptions(sites, true).map((o) => o.value),
    ['all', 'block:bP', 'site:p1', 'block:bG', 'site:g1', 'site:g2']);
  assert.deepEqual(scopeOptions(sites, false).map((o) => o.value),
    ['block:bP', 'site:p1', 'block:bG', 'site:g1', 'site:g2']);
  // A warden's night: only their block came down from the server.
  const theirs = sites.filter((s) => s.block_id === 'bG');
  assert.deepEqual(scopeOptions(theirs, false).map((o) => o.value),
    ['block:bG', 'site:g1', 'site:g2']);
});

test('a remembered choice is kept while the night offers it, and falls back when not', async () => {
  const { resolveScope } = await load();
  assert.equal(resolveScope('site:g2', sites, true), 'site:g2');
  assert.equal(resolveScope('site:gone', sites, true), 'all');
  assert.equal(resolveScope(null, sites, false), 'block:bP');
  // "all" remembered on a device a warden now uses: not theirs.
  assert.equal(resolveScope('all', sites.slice(1), false), 'block:bG');
});

test('the site a phone is taken to be at: the site, else the block anchor', async () => {
  const { hereSite } = await load();
  assert.equal(hereSite(sites, 'site:g2').property_id, 'g2');
  assert.equal(hereSite(sites, 'block:bG').property_id, 'g1');
  assert.equal(hereSite(sites, 'all').property_id, 'p1');
});
