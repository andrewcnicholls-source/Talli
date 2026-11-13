/* =====================================================================
   A customer on the booking page.

   Everything is real except Stripe's hosted page, which the local stack
   cannot reach: when the page posts to create-checkout, the test checks
   what was sent, takes the same hold the function would, has the real
   stripe-webhook confirm it from a correctly signed delivery, and sends
   the browser to the real confirmation page.
   ===================================================================== */
'use strict';
const { test, expect } = require('./fixtures');
const { FIX, rest, rpc, plate, forget } = require('../lib/stack');
const { deliver, sessionCompleted } = require('../lib/stripe');

const made = [];
test.afterAll(() => forget(made));

// The fixture nights' series page (plan A3: the flow lives there).
async function seriesOf(night) {
  const [{ event_series: series }] = await rest(`event?id=eq.${night}&select=event_series(slug)`);
  return series.slug;
}

test('a customer books a block from the series page, and is sent to that block', async ({ page }) => {
  const rego = plate('BC');
  made.push(rego);
  const taps = [];
  const tap = async (locator) => { taps.push(locator); await locator.click(); };

  await page.goto(`/events/${await seriesOf(FIX.night)}`);
  await tap(page.locator(`#night-${FIX.night}`).getByRole('link', { name: 'Book parking' }));
  await expect(page.locator('#bk-tiers-step')).toBeVisible();

  // Standard is the chip that is on, and every block shows its Standard price.
  await expect(page.locator('input[name="bk-type"][value="standard"]')).toBeChecked();
  const grib = page.locator('label.bk-card-block', { hasText: 'Gribblehurst (test)' });
  await expect(grib.locator('.bk-tier-price')).toHaveText('$40');
  await expect(grib).toContainText('or within 100m');

  await tap(grib);
  await expect(page.locator('#bk-summary-price')).toHaveText('$40');
  await page.fill('#bk-name', 'Browser Buyer');
  await page.fill('#bk-email', 'browser.buyer@example.com');
  await page.fill('#bk-rego', rego);

  let sent = null;
  await page.route('**/functions/v1/create-checkout', async (route) => {
    sent = route.request().postDataJSON();
    const [block] = await rest(`block?name=eq.${encodeURIComponent('Gribblehurst (test)')}&select=id`);
    const site = await rpc('pick_block_property', {
      p_event_id: sent.event_id, p_block_id: sent.block_id, p_tier_code: sent.tier_code,
    });
    const id = await rpc('hold_booking', {
      p_event_id: sent.event_id, p_property_id: site, p_tier_code: sent.tier_code,
      p_email: sent.email, p_name: sent.name, p_rego: sent.vehicle_rego,
    });
    const event = sessionCompleted(id);
    await rest(`booking?id=eq.${id}`, { method: 'PATCH',
      body: { stripe_checkout_session_id: event.data.object.id } });
    const delivered = await deliver(event);
    expect(delivered.status).toBe(200);
    expect(sent.block_id).toBe(block.id);
    await route.fulfill({ json: {
      url: `/booking-confirmed.html?session_id=${event.data.object.id}`, booking_id: id,
    } });
  });

  await tap(page.locator('#bk-submit'));
  await expect(page.locator('#cf-headline')).toHaveText(/booked in/);
  // Night, block, pay: the details are typed, not tapped.
  expect(taps.length).toBeLessThanOrEqual(4);

  // What the page asked for: a night, an area, a type. Never an amount.
  // The one price-shaped field is the figure it showed, sent as an
  // expectation that checkout compares against the database and refuses on
  // (plan B1, PRICE_CHANGED) — it is never what is charged. Anything else
  // that looks like a price is still not allowed to leave the page.
  expect(sent).toMatchObject({ event_id: FIX.night, tier_code: 'standard', vehicle_rego: rego });
  expect(sent.expected_price_cents).toBe(4000);
  for (const key of Object.keys(sent)) {
    if (key === 'expected_price_cents') continue;
    expect(key).not.toMatch(/amount|price|cents|total/i);
  }

  await expect(page.locator('#cf-come-to')).toContainText('Gribblehurst');
  await expect(page.locator('#cf-come-to')).not.toContainText('Paice');
  await expect(page.locator('#cf-directions')).toHaveAttribute('href', /getting-here\.html\?block=/);

  const [row] = await rest(`booking?vehicle_rego=eq.${rego}&select=status,amount_cents`);
  expect(row).toEqual({ status: 'paid', amount_cents: 4000 });
});

test('the type chips filter the blocks and their prices', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.night)}?night=${FIX.night}`);
  const blocks = page.locator('#bk-blocks');
  await expect(blocks.locator('label.bk-card-block')).toHaveCount(2);

  await page.locator('label.bk-chip', { hasText: 'Valet' }).click();
  // Only Paice Ave sells Valet on this night.
  await expect(blocks.locator('label.bk-card-block')).toHaveCount(1);
  await expect(blocks).not.toContainText('Gribblehurst');
  await expect(blocks.locator('.bk-tier-price')).toHaveText('$45');

  await page.locator('label.bk-chip', { hasText: 'Priority' }).click();
  await expect(page.locator('label.bk-card-block', { hasText: 'Gribblehurst (test)' })
    .locator('.bk-tier-price')).toHaveText('$50');
  await page.locator('label.bk-card-block', { hasText: 'Gribblehurst (test)' }).click();
  await expect(page.locator('#bk-summary-tier')).toContainText('Priority');
  await expect(page.locator('#bk-summary-price')).toHaveText('$50');

  // Changing the chip lets go of the block chosen for the other type.
  await page.locator('label.bk-chip', { hasText: 'Standard' }).click();
  await expect(page.locator('#bk-details')).toBeHidden();
  await expect(page.locator('input[name="bk-block"]:checked')).toHaveCount(0);
});

test('a night sold out online says walk-ups are still possible, never how many', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.soldOutNight)}?night=${FIX.soldOutNight}`);
  const blocks = page.locator('#bk-blocks');
  const paice = blocks.locator('label.bk-card-block', { hasText: 'Paice' });
  await expect(paice).toHaveClass(/is-soldout/);
  await expect(paice.locator('input')).toBeDisabled();
  const note = blocks.locator('.bk-soldout-note');
  await expect(note).toHaveText(/Sold out online — walk-up spaces on the night/);
  await expect(note).toContainText('86 Paice Ave');
  await expect(blocks).not.toContainText(/\b\d+ (left|walk-up|space)/);
  await expect(page.locator('#bk-details')).toBeHidden();

  // Priority still has one online, so it is still for sale.
  await page.locator('label.bk-chip', { hasText: 'Priority' }).click();
  await expect(blocks.locator('label.bk-card-block').first()).not.toHaveClass(/is-soldout/);
});

test('/book still sells a night chosen from its own list', async ({ page }) => {
  await page.goto('/book.html');
  await page.locator('label.bk-fixture', { hasText: 'TEST — Fixture night' }).first().click();
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
  await page.locator('label.bk-card-block', { hasText: 'Gribblehurst (test)' }).click();
  await expect(page.locator('#bk-summary-price')).toHaveText('$40');
  await expect(page.locator('#bk-details')).toBeVisible();
});
