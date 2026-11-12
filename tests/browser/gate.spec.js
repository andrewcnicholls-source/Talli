/* =====================================================================
   The gate screen, signed in as the operator and as a warden.

   gate-ops decides what each may see and do (tests/functions covers
   that it refuses the rest). These check the screen offers the right
   things, at phone, tablet and desktop size.
   ===================================================================== */
'use strict';
const { test, expect, signedIn } = require('./fixtures');
const { FIX, PASSWORD, rest, rpc, plate, forget } = require('../lib/stack');

const made = [];
let gribCar;
let paiceCar;

test.beforeAll(async () => {
  gribCar = plate('GG');
  paiceCar = plate('GP');
  made.push(gribCar, paiceCar);
  for (const [site, rego] of [[FIX.gribAnchor, gribCar], [FIX.paice, paiceCar]]) {
    const id = await rpc('hold_booking', {
      p_event_id: FIX.night, p_property_id: site, p_tier_code: 'standard',
      p_email: 'gate.browser@example.com', p_rego: rego,
    });
    await rpc('confirm_booking', { p_booking_id: id, p_payment_intent_id: null });
  }
});
test.afterAll(() => forget(made));

async function openNight(page) {
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.selectOption('#ad-event', FIX.night);
  await expect(page.locator('#ad-list .ad-row').first()).toBeVisible();
}

test('a warden sees their own block and nothing else', async ({ page }) => {
  await signedIn(page, 'wardenGrib');
  await openNight(page);

  await expect(page.locator('#ad-list')).toContainText(gribCar);
  await expect(page.locator('#ad-list')).not.toContainText(paiceCar);

  const sites = await page.locator('#ad-site option').allTextContents();
  expect(sites.join(' ')).toMatch(/Gribblehurst/);
  expect(sites.join(' ')).not.toMatch(/Paice/);

  // Arrivals and Site info only.
  await expect(page.locator('#ad-tab-night')).toBeHidden();
  await expect(page.locator('#ad-tab-sites')).toBeHidden();
  await expect(page.locator('#ad-tab-insights')).toBeHidden();
});

test('a warden sells a walk-up: cash by default, no tap to pay', async ({ page }) => {
  const rego = plate('GW');
  made.push(rego);
  await signedIn(page, 'wardenGrib');
  await openNight(page);

  await page.click('#ad-sell-open');
  await expect(page.locator('#ad-sell')).toBeVisible();
  await expect(page.locator('#ad-sell-payment')).toHaveValue('cash');
  await expect(page.locator('#ad-sell-payment option[value="tap_to_pay"]')).toHaveCount(0);

  await page.fill('#ad-sell-rego', rego);
  await page.click('#ad-sell-submit');
  await expect(page.locator('#ad-sell')).toBeHidden();
  await expect(page.locator('#ad-list')).toContainText(rego);

  const [row] = await rest(`booking?vehicle_rego=eq.${rego}&select=status,channel,payment_method,property_id`);
  expect(row.status).toBe('paid');
  expect(row.channel).toBe('gate');
  expect(row.payment_method).toBe('cash');
  expect([FIX.gribAnchor, FIX.gribNeighbour]).toContain(row.property_id);
});

test('the operator sees every block, and the operator tabs', async ({ page }) => {
  await signedIn(page, 'operator');
  await openNight(page);
  await expect(page.locator('#ad-list')).toContainText(gribCar);
  await expect(page.locator('#ad-list')).toContainText(paiceCar);
  await expect(page.locator('#ad-tab-night')).toBeVisible();
});

test('a signed-in stranger is told they are not a host', async ({ page }) => {
  await signedIn(page, 'outsider');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeHidden();
  await expect(page.locator('#ad-lock')).toContainText(/not set up as a Talli host/);
});

test('on the test site, the card signs in as a test user with no Google account', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.locator('#ad-lock-test')).toBeVisible();
  await page.selectOption('#ad-test-user', 'warden.test@example.com');
  // No password is built into the page: it has to be typed.
  await page.click('#ad-test-signin');
  await expect(page.locator('#ad-app')).toBeHidden();
  await page.fill('#ad-test-password', 'not the password');
  await page.click('#ad-test-signin');
  await expect(page.locator('#ad-lock-error')).toBeVisible();
  await page.fill('#ad-test-password', PASSWORD);
  await page.click('#ad-test-signin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-who')).toHaveText('warden.test@example.com');
  await expect(page.locator('#ad-tab-night')).toBeHidden();
});
