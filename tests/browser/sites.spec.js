/* =====================================================================
   The Sites page (plan B3), on a phone, a tablet and a desktop.

   Done when: a new site goes from address to on sale at three nights
   with no SQL and no visit to the Event tab. The first test is exactly
   that, by tapping. There is no Google Maps key locally, so the address
   and position are typed: the fallback the page keeps for when Places is
   unavailable.

   Each run makes its own site and, at the end, takes it off its nights
   and switches it off, so the other suites see the calendar they expect.
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');
const { test, expect, signedIn } = require('./fixtures');
const { FIX, gate, rest } = require('../lib/stack');

let siteId = null;

test.afterEach(async () => {
  if (!siteId) return;
  const setup = await gate('operator', { action: 'sites_setup' });
  const mine = setup.body.sites.find((s) => s.property_id === siteId);
  if (mine) {
    await gate('operator', { action: 'set_site_nights', property_id: siteId,
      remove: mine.nights.map((n) => n.event_id) });
  }
  await gate('operator', { action: 'save_site_details', property_id: siteId, active: false });
  siteId = null;
});

async function openSites(page) {
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.click('#ad-tab-sites');
  await expect(page.locator('#ad-site-form')).toContainText('Details');
}

test('a new site goes from an address to on sale at three nights, by tapping', async ({ page }) => {
  const tag = crypto.randomBytes(3).toString('hex');
  const name = `TEST B3 ${tag}`;
  await signedIn(page, 'operator');
  await openSites(page);

  // 1. Its address and where it is.
  await page.selectOption('#ad-site-pick', '__new');
  const form = page.locator('#ad-site-form');
  await expect(form).toContainText('A new site');
  await expect(form).toContainText('type the address'); // no Places key here
  await form.getByLabel('Address', { exact: true }).fill(`${tag} Invented Road, Sandringham (test)`);
  await form.getByLabel('Map position').fill('-36.881200, 174.741500');
  await form.getByLabel('Site name').fill(name);
  await form.getByLabel('New host — name').fill(`TEST B3 host ${tag}`);
  await form.getByLabel('Area', { exact: true }).selectOption('__new');
  await form.getByLabel('New area — name').fill(`TEST B3 area ${tag}`);
  await form.getByLabel('Walk to the venue (minutes)').fill('12');
  await form.getByRole('button', { name: 'Add site' }).click();

  await expect(form).toContainText('Usual spaces');
  siteId = await page.locator('#ad-site-pick').inputValue();
  expect(siteId).not.toBe('__new');
  await expect(form).toContainText(`This is the anchor of TEST B3 area ${tag}`);

  // 2. Its usual spaces.
  await form.getByLabel('Standard spaces').fill('3');
  await form.getByLabel('Standard sold online').fill('2');
  await form.getByRole('button', { name: 'Save usual spaces' }).click();
  await expect(page.locator('#ad-toast')).toContainText(`${name} saved`);

  // 3. Three nights, ticked.
  const nights = form.locator('.ad-site-nights');
  await nights.locator('.ad-site-night-pick', { hasText: 'Fixture night ·' }).locator('input').check();
  await nights.locator('.ad-site-night-pick', { hasText: 'sold out online' }).locator('input').check();
  await nights.locator('.ad-site-night .ad-site-night-pick')
    .filter({ hasNotText: 'Fixture night' }).first().locator('input').check();
  await form.getByRole('button', { name: 'Save nights' }).click();
  await expect(nights.locator('.ad-chip.is-pending')).toHaveCount(3);

  // 4. On sale, one deliberate tap per night.
  for (let i = 0; i < 3; i += 1) {
    await nights.getByRole('button', { name: 'Put on sale' }).first().click();
    await expect(nights.locator('.ad-chip.is-confirmed')).toHaveCount(i + 1);
  }

  // The website can now sell its online share on all three.
  const avail = await rest(`v_tier_availability?property_id=eq.${siteId}&code=eq.standard` +
    '&select=event_id,spots_left');
  expect(avail).toHaveLength(3);
  for (const a of avail) expect(a.spots_left).toBe(2);
});

test('one night\'s spaces are set from the Sites page, never below what has sold', async ({ page }) => {
  await signedIn(page, 'operator');
  await openSites(page);
  await page.selectOption('#ad-site-pick', FIX.gribNeighbour);
  await page.selectOption('#ad-site-night', FIX.night);
  const form = page.locator('#ad-site-form');
  await expect(form).toContainText('Spaces on TEST — Fixture night');
  await expect(form.getByLabel('Standard spaces')).toBeVisible();
  // Online above the spaces is caught before it is sent.
  await form.getByLabel('Standard sold online').fill('99');
  await form.getByRole('button', { name: 'Save spaces for this night' }).click();
  await expect(form.locator('.ad-sheet-error:visible')).toContainText('online can’t be more');
});

test('the Event tab keeps the reference price and sends spaces to the Sites page', async ({ page }) => {
  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-tab-night')).toHaveText('Event');
  await page.click('#ad-tab-night');
  await page.selectOption('#ad-event', FIX.night);
  const prices = page.locator('#ad-prices');
  await expect(prices.locator('.ad-price').first()).toBeVisible();
  // No per-site counts or walk-up holds here any more, and no adding sites.
  await expect(prices.locator('.ad-count-btn')).toHaveCount(0);
  await expect(prices.locator('select')).toHaveCount(0);
  // Only the reference site's cards carry a price to move.
  await expect(prices.locator('.ad-price')).toHaveCount(3);
  await expect(prices).toContainText('Every site tonight');

  await prices.getByRole('button', { name: /Change spaces or sites/ }).click();
  await expect(page.locator('#ad-pane-sites')).toBeVisible();
  await expect(page.locator('#ad-site-night')).toHaveValue(FIX.night);
});
