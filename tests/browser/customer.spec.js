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

async function chooseNight(page, name) {
  await page.goto('/book.html');
  await page.locator('label.bk-fixture', { hasText: name }).first().click();
}

test('a customer books a block and is sent to that block, not Paice Ave', async ({ page }) => {
  const rego = plate('BC');
  made.push(rego);

  await chooseNight(page, 'TEST — Fixture night');
  // Two areas sell this night, so the area comes first.
  await page.locator('label.bk-card', { hasText: 'Gribblehurst (test)' }).click();
  await page.locator('label.bk-card', { hasText: 'Standard' }).first().click();
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

  await page.click('#bk-submit');
  await expect(page.locator('#cf-headline')).toHaveText(/booked in/);

  // What the page asked for: a night, an area, a type. Never a price.
  expect(sent).toMatchObject({ event_id: FIX.night, tier_code: 'standard', vehicle_rego: rego });
  for (const key of Object.keys(sent)) expect(key).not.toMatch(/amount|price|cents|total/i);

  await expect(page.locator('#cf-come-to')).toContainText('Gribblehurst');
  await expect(page.locator('#cf-come-to')).not.toContainText('Paice');
  await expect(page.locator('#cf-directions')).toHaveAttribute('href', /getting-here\.html\?block=/);

  const [row] = await rest(`booking?vehicle_rego=eq.${rego}&select=status,amount_cents`);
  expect(row).toEqual({ status: 'paid', amount_cents: 4000 });
});

test('a night sold out online says walk-ups are still possible, never how many', async ({ page }) => {
  await chooseNight(page, 'TEST — Fixture night (sold out online)');
  const tiers = page.locator('#bk-tiers');
  await expect(tiers).toContainText(/sold out online/i);
  await expect(tiers).toContainText(/on the night/i);
  await expect(tiers).not.toContainText(/\b\d+ left\b/);
  await expect(page.locator('#bk-details')).toBeHidden();
});
