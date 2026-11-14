/* =====================================================================
   Settlement (plan B7), on a phone, a tablet and a desktop.

   Andrew opens a closed night at the foot of the Sites page, sees each
   host's spaces and what they are owed, gives the wardens' amount to the
   one warden who worked it, and settles it — then reopens it.

   The night is its own, made yesterday and already closed, with one cash
   walk-up at each Gribblehurst (test) site, so the figures are known:
   two $40 cars → parking $80 → wardens $16, hosts $40 ($20 each), Talli
   $24. It is removed afterwards. The arithmetic itself is proved in the
   database suite (11_host_settlement).
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');
const { test, expect, signedIn } = require('./fixtures');
const { FIX, rest, plate } = require('../lib/stack');

let night = null;

async function makeNight() {
  const id = crypto.randomUUID();
  const starts = new Date(Date.now() - 26 * 3600 * 1000);
  const at = (h) => new Date(starts.getTime() + h * 3600 * 1000).toISOString();
  await rest('event', { method: 'POST', body: {
    id, name: `TEST B7 settled ${id.slice(0, 6)}`, venue: 'Eden Park',
    starts_at: starts.toISOString(), gates_open_at: at(-1.5), expected_end_at: at(3),
    online_sales_close_at: at(-1), status: 'on_sale',
  } });
  const offers = await rest('event_offer', { method: 'POST', prefer: 'return=representation', body: [
    { event_id: id, property_id: FIX.gribAnchor, status: 'confirmed' },
    { event_id: id, property_id: FIX.gribNeighbour, status: 'confirmed' },
  ] });
  await rest('offer_tier', { method: 'POST', body: offers.map((o) => ({
    event_offer_id: o.id, code: 'standard', label: 'Standard', price_cents: 4000,
    zone_codes: [], bay_kind: 'no_clear_exit', guarantees_clear_exit: false, sort_order: 1,
    active: true, capacity: 3, gate_reserve: 0,
    arrival_from: at(-3), arrival_until: at(0), departure_by: at(4),
  })) });
  const [warden] = await rest('host_user?email=eq.warden.test@example.com&select=id');
  await rest('booking', { method: 'POST', body: [FIX.gribAnchor, FIX.gribNeighbour].map((site) => ({
    event_id: id, property_id: site, booked_property_id: site, tier_code: 'standard',
    customer_email: 'settlement.test@example.com', vehicle_rego: plate('B7'),
    amount_cents: 4000, channel: 'gate', status: 'paid', payment_method: 'cash',
    paid_at: new Date().toISOString(), cash_collected_by: warden.id, checked_in_by: warden.id,
  })) });
  // Closing it takes the snapshot of the spaces each site provided.
  await rest(`event?id=eq.${id}`, { method: 'PATCH', body: { status: 'closed' } });
  return id;
}

test.beforeEach(async () => { night = await makeNight(); });
test.afterEach(async () => {
  if (!night) return;
  await rest(`booking?event_id=eq.${night}`, { method: 'DELETE' });
  await rest(`event?id=eq.${night}`, { method: 'DELETE' });
  night = null;
});

test('a closed night is settled from the Sites page, by tapping', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.click('#ad-tab-sites');

  const settle = page.locator('#ad-settle');
  await expect(settle).toBeVisible();
  await page.selectOption('#ad-settle-night', night);
  await expect(settle.locator('#ad-settle-night')).toHaveValue(night);

  const card = settle.locator('.ad-settle-block', { hasText: 'Gribblehurst (test)' });
  await expect(card).toContainText('Not settled');
  await expect(card).toContainText('Spaces as they were when the night closed');
  // Each host provided 3 spaces, and is owed half the hosts' $40.
  const hosts = card.locator('.ad-settle-host');
  await expect(hosts).toHaveCount(2);
  for (const h of await hosts.all()) {
    await expect(h).toContainText('3 spaces');
    await expect(h).toContainText('$20');
  }
  await expect(card.locator('.ad-settle-h', { hasText: 'Wardens' })).toContainText('$16');
  await expect(card).toContainText('Cash held');

  // The one warden who worked it is offered the whole amount.
  const amount = card.getByLabel('Amount for warden.test@example.com');
  await expect(amount).toHaveValue('16.00');
  await expect(card.locator('.ad-settle-left')).toHaveText('Adds up.');
  await amount.fill('10');
  await expect(card.locator('.ad-settle-left')).toContainText('$6 still to allocate');
  await amount.fill('16');
  await card.getByRole('button', { name: 'Save wardens’ split' }).click();
  await expect(page.locator('#ad-toast')).toContainText('Wardens’ split saved');

  await card.getByRole('button', { name: 'Settle Gribblehurst (test)' }).click();
  await expect(card).toContainText('Settled');
  await expect(card).toContainText('frozen');
  await expect(amount).toBeDisabled();

  await card.getByRole('button', { name: 'Reopen Gribblehurst (test)' }).click();
  await expect(card).toContainText('Not settled');
  await expect(amount).toBeEnabled();
});

test('a warden is never shown settlement', async ({ page }) => {
  await signedIn(page, 'wardenGrib');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-tab-sites')).toBeHidden();
  await expect(page.locator('#ad-settle')).toBeHidden();
});
