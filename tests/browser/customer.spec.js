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
// An area is picked on the map now; the pin itself is a 0x0 anchor and
// the pill drawn on it is what shows and takes the tap.
const pin = (page, text) => page.locator('#bk-map .bk-map-pin .bk-map-pill', { hasText: text });

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

  // "All" is the chip that is on; areas are picked on the map, not from a
  // list, which only shows the one picked.
  await expect(page.locator('input[name="bk-type"][value="all"]')).toBeChecked();
  await expect(page.locator('#bk-blocks .bk-map-prompt')).toBeVisible();
  await expect(page.locator('#bk-blocks .bk-area')).toHaveCount(0);

  await tap(pin(page, 'from $40'));
  const grib = page.locator('#bk-blocks .bk-area', { hasText: 'Gribblehurst (test)' });
  await expect(grib).toContainText('or within 100m');
  await expect(page.locator('#bk-blocks .bk-area')).toHaveCount(1);
  await tap(grib.locator('.bk-area-type', { hasText: 'Standard' }));
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
  // Night, area, type, pay: the details are typed, not tapped.
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
  // Directions are the booked block's /go/ page (plan A4), never Paice Ave's.
  const [booked] = await rest(`property?id=eq.${FIX.gribAnchor}&select=block:block_id(slug)`);
  await expect(page.locator('#cf-directions')).toHaveAttribute('href', '/go/' + booked.block.slug);

  const [row] = await rest(`booking?vehicle_rego=eq.${rego}&select=status,amount_cents`);
  expect(row).toEqual({ status: 'paid', amount_cents: 4000 });
});

test('the type chips filter the map and its prices', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.night)}?night=${FIX.night}`);
  const blocks = page.locator('#bk-blocks');

  await page.locator('label.bk-chip', { hasText: 'Valet' }).click();
  // Only Paice Ave sells Valet on this night: Gribblehurst's pin says full.
  await expect(pin(page, '$45')).toBeVisible();
  await expect(page.locator('#bk-map .bk-map-pin.is-full')).toHaveCount(1);

  await page.locator('label.bk-chip', { hasText: 'Priority' }).click();
  await expect(pin(page, '$50')).toBeVisible();
  await pin(page, '$50').click();
  await expect(blocks.locator('label.bk-card-block')).toHaveCount(1);
  await expect(blocks.locator('label.bk-card-block')).toContainText('Gribblehurst (test)');
  await expect(page.locator('#bk-summary-tier')).toContainText('Priority');
  await expect(page.locator('#bk-summary-price')).toHaveText('$50');

  // Changing the chip lets go of the block chosen for the other type.
  await page.locator('label.bk-chip', { hasText: 'Standard' }).click();
  await expect(page.locator('#bk-details')).toBeHidden();
  await expect(page.locator('input[name="bk-block"]:checked')).toHaveCount(0);
});

test('"All" is on, each area shows from its cheapest price, and a pin opens its types', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.night)}?night=${FIX.night}`);
  const blocks = page.locator('#bk-blocks');
  await expect(page.locator('label.bk-chip').first()).toHaveText('All');
  await expect(page.locator('input[name="bk-type"][value="all"]')).toBeChecked();
  await expect(pin(page, 'from $30')).toBeVisible();
  await expect(pin(page, 'from $40')).toBeVisible();
  await expect(blocks.locator('.bk-area')).toHaveCount(0);

  // A pin on the map opens that area at its types.
  await pin(page, 'from $40').click();
  const grib = blocks.locator('.bk-area', { hasText: 'Gribblehurst (test)' });
  await expect(grib.locator('.bk-card-area .bk-tier-price')).toHaveText('from $40');
  await expect(grib).toHaveClass(/is-open/);
  await expect(grib.locator('.bk-area-type')).toHaveCount(2);
  await expect(grib.locator('.bk-area-type', { hasText: 'Priority' }).locator('.bk-tier-price'))
    .toHaveText('$50');
  await expect(blocks.locator('.bk-area')).toHaveCount(1);

  await grib.locator('.bk-area-type', { hasText: 'Priority' }).click();
  await expect(page.locator('#bk-summary-tier')).toContainText('Priority');
  await expect(page.locator('#bk-summary-price')).toHaveText('$50');
  // The chosen area is picked out on the map.
  await expect(page.locator('.bk-map-pin.is-chosen')).toHaveCount(1);

  // In the chosen colour, with a tick.
  const chosen = page.locator('.bk-map-pin.is-chosen .bk-map-pill');
  await expect(chosen).toHaveCSS('background-color', 'rgb(23, 112, 63)');

  // Picking the other area on the map lets go of the choice in this one.
  // On a phone the two fixture areas (about 180m apart) overlap at this
  // zoom and the chosen pill sits on top, so the tap is sent to the pill
  // itself rather than to whatever is uppermost at that point.
  await pin(page, 'from $30').dispatchEvent('click');
  const paice = blocks.locator('.bk-area', { hasText: 'Paice' });
  await expect(paice).toHaveClass(/is-open/);
  await expect(grib).toHaveCount(0);
  await expect(page.locator('#bk-details')).toBeHidden();
});

test('an extra shows its price top right and its stepper bottom right', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.night)}?night=${FIX.night}`);
  await pin(page, 'from $40').click();
  await page.locator('#bk-blocks .bk-area-type', { hasText: 'Standard' }).click();
  const card = page.locator('#bk-extras .bk-extra').first();
  await expect(card).toBeVisible();
  // The picture loads from the site root, on the series page too.
  await expect.poll(() => card.locator('img').evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  // Measured in one go: the page is still scrolling to this step, so
  // separate measurements would each see it somewhere else.
  const m = await card.evaluate((c) => {
    const r = (sel) => c.querySelector(sel).getBoundingClientRect();
    return { box: c.getBoundingClientRect(), price: r('.bk-extra-price'),
      step: r('.bk-step-count'), name: r('.bk-extra-name') };
  });
  // Right-hand column, price above the stepper, both right of the name.
  expect(m.price.x).toBeGreaterThan(m.name.x + m.name.width);
  expect(m.step.x).toBeGreaterThan(m.name.x);
  expect(m.price.bottom).toBeLessThanOrEqual(m.step.top + 1);
  expect(m.price.top - m.box.top).toBeLessThan(m.box.height / 2);
  expect(m.step.bottom).toBeGreaterThan(m.box.top + m.box.height / 2);
});

test('a night sold out online says walk-ups are still possible, never how many', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.soldOutNight)}?night=${FIX.soldOutNight}`);
  const blocks = page.locator('#bk-blocks');
  // One area on this night: it is listed under the map, nothing to pick.
  await page.locator('label.bk-chip', { hasText: 'Standard' }).click();
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
  await pin(page, 'from $40').click();
  await page.locator('#bk-blocks .bk-area-type', { hasText: 'Standard' }).click();
  await expect(page.locator('#bk-summary-price')).toHaveText('$40');
  await expect(page.locator('#bk-details')).toBeVisible();
});

test('step 2 does not lean on the sign in the driveway, or announce the surcharge', async ({ page }) => {
  await page.goto(`/events/${await seriesOf(FIX.night)}?night=${FIX.night}`);
  const step = page.locator('#bk-tiers-step');
  await expect(step).toBeVisible();
  await expect(pin(page, 'from $40')).toBeVisible();
  await expect(step).not.toContainText(/sign in the driveway/i);
  await expect(step).not.toContainText(/surcharge/i);
});

test('a series with one night on sale opens the booking on it without a tap', async ({ page }) => {
  // Find a series with exactly one night on sale, as Robbie Williams is.
  const nights = await rest('event?status=eq.on_sale&starts_at=gt.' + new Date().toISOString() +
    '&series_id=not.is.null&select=id,series_id,event_series(slug)');
  const bySeries = {};
  for (const n of nights) (bySeries[n.series_id] = bySeries[n.series_id] || []).push(n);
  const one = Object.values(bySeries).find((list) => list.length === 1);
  test.skip(!one, 'no series with a single night on sale in the fixtures');
  const night = one[0];
  await page.goto(`/events/${night.event_series.slug}`);
  await expect(page.locator(`#night-${night.id}`)).toHaveClass(/is-chosen/);
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
});
