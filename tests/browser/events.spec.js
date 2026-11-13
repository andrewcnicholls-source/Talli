/* =====================================================================
   The events catalogue (plan A2): from "what's on" to a series, where
   a night opens the booking flow on the same page (plan A3). Old links
   to /book?event=<id> come back to the series with that night chosen.

   The pages come from the real functions (tests/lib/serve.js runs them
   against the local stack). The price is filled in afterwards in the
   browser, from the same view the booking page reads.
   ===================================================================== */
'use strict';
const { test, expect } = require('./fixtures');
const { FIX, rest } = require('../lib/stack');

test('what\'s on → a series → its night, booked on the series page', async ({ page }) => {
  const [{ event_series: series }] =
    await rest(`event?id=eq.${FIX.night}&select=event_series(slug,name)`);

  await page.goto('/');
  await page.getByRole('link', { name: /See what's on/ }).click();
  await expect(page).toHaveURL(/\/events$/);

  const card = page.locator('.ev-card', { hasText: series.name });
  await expect(card.locator('.ev-from')).toHaveText(/^Parking from \$\d+/);
  await card.locator('a').click();
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}$`));
  await expect(page.locator('h1')).toHaveText(series.name);

  const night = page.locator(`#night-${FIX.night}`);
  await expect(night.locator('.ev-night-status')).toHaveText('On sale');
  await expect(night.locator('.ev-from')).toHaveText(/^Parking from \$\d+/);
  await night.getByRole('link', { name: 'Book parking' }).click();

  // The flow opens under the nights; the address names the night chosen.
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}\\?night=${FIX.night}$`));
  await expect(night).toHaveClass(/is-chosen/);
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
  await expect(page.locator('#bk-tier-event')).toContainText('Fixture night');
});

test('an old /book?event= link lands on the series page with that night chosen', async ({ page }) => {
  const [{ event_series: series }] =
    await rest(`event?id=eq.${FIX.night}&select=event_series(slug)`);
  await page.goto(`/book?event=${FIX.night}`);
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}\\?night=${FIX.night}$`));
  await expect(page.locator(`#night-${FIX.night}`)).toHaveClass(/is-chosen/);
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
  await expect(page.locator('label.bk-card-block').first()).toBeVisible();
});

test('a booking link to a night that is not listed leaves the page as it was', async ({ page }) => {
  await page.goto('/book?event=00000000-0000-4000-8000-000000000000');
  await expect(page.locator('label.bk-fixture').first()).toBeVisible();
  await expect(page.locator('#bk-tiers-step')).toBeHidden();
  await expect(page.locator('input[name="bk-event"]:checked')).toHaveCount(0);
});
