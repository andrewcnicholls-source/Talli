/* =====================================================================
   The Site guide and the Locate Us card, plan A4.

   Done when: a warden opens the guide for their site in two taps — the
   Site guide tab, then the card to fill the screen — and a driver lands
   on the site's page and reaches navigation in one more tap. The pages
   as served are proved in tests/functions/site-guide.test.js; these check
   the screen and the page in a browser.
   ===================================================================== */
'use strict';
const { test, expect, signedIn } = require('./fixtures');
const { FIX, rest } = require('../lib/stack');

test('a warden opens the card for their block in two taps', async ({ page }) => {
  const block = (await rest(`property?id=eq.${FIX.gribAnchor}&select=block:block_id(slug)`))[0].block;

  await signedIn(page, 'wardenGrib');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();

  // Tap one: the Site guide tab.
  await page.click('#ad-tab-info');
  const card = page.locator('#ad-guide-card');
  await expect(card).toBeVisible();
  await expect(card.locator('svg')).toHaveAttribute('aria-label', new RegExp('/go/' + block.slug + '$'));
  await expect(card).not.toContainText('Paice');

  // Tap two: the card fills the screen.
  await card.click();
  const full = page.locator('#ad-guide-full');
  await expect(full).toBeVisible();
  const box = await full.locator('svg').boundingBox();
  const vp = page.viewportSize();
  expect(Math.max(box.width / vp.width, box.height / vp.height)).toBeGreaterThan(0.85);

  // Any tap closes it.
  await full.click();
  await expect(full).toBeHidden();
});

test('choosing one site shows that site\'s own card', async ({ page }) => {
  const site = (await rest(`property?id=eq.${FIX.gribNeighbour}&select=slug`))[0];
  await signedIn(page, 'wardenGrib');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.selectOption('#ad-scope', 'site:' + FIX.gribNeighbour);
  await page.click('#ad-tab-info');
  await expect(page.locator('#ad-guide-card svg'))
    .toHaveAttribute('aria-label', new RegExp('/go/' + site.slug + '$'));
});

test('scanning lands on the site\'s page, one tap from the map', async ({ page }) => {
  await page.goto('/go/86paice');
  await expect(page.locator('h1')).toHaveText('86 Paice Avenue');
  const google = page.locator('#go-google');
  await expect(google).toBeVisible();
  // On a phone the button is on the first screen, under the address.
  const b = await google.boundingBox();
  expect(b.y + b.height).toBeLessThan(page.viewportSize().height);
  await expect(google).toHaveAttribute('href', /google\.com\/maps\/dir\/\?api=1&destination=-?\d/);
  await expect(page.locator('.go-night-link').first()).toBeVisible();
});

test('Getting Here lists every area, and an old ?block= link goes to its /go/ page', async ({ page }) => {
  const block = (await rest(`property?id=eq.${FIX.gribAnchor}&select=block:block_id(id,slug)`))[0].block;
  await page.goto('/getting-here');
  await expect(page.locator('#gh-areas .gh-area')).not.toHaveCount(0);
  await expect(page.locator(`#gh-areas a[href="/go/${block.slug}"]`)).toHaveCount(1);

  await page.goto('/getting-here?block=' + block.id);
  await expect(page).toHaveURL(new RegExp('/go/' + block.slug + '$'));
  await expect(page.locator('main')).not.toContainText('Paice');
});
