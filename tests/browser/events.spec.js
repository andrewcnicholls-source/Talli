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
  // The card opens the series at its nights: the #ev-nights anchor.
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}(#ev-nights)?$`));
  await expect(page.locator('h1')).toHaveText(series.name);

  const night = page.locator(`#night-${FIX.night}`);
  await expect(night.locator('.ev-night-status')).toHaveText('On sale');
  // Where it is: a tag of its own, before the status, not on the date line.
  await expect(night.locator('.ev-night-tags > span').first()).toHaveClass('ev-night-venue');
  await expect(night.locator('.ev-night-venue')).not.toBeEmpty();
  await expect(night.locator('.ev-night-meta')).not.toContainText('·');
  await expect(night.locator('.ev-from')).toHaveText(/^Parking from \$\d+/);
  await night.getByRole('link', { name: 'Book parking' }).click();

  // The flow opens under the nights; the address names the night chosen.
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}\\?night=${FIX.night}$`));
  await expect(night).toHaveClass(/is-chosen/);
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
  await expect(page.locator('#bk-tier-event')).toContainText('Fixture night');
});

// Where a jump lands: the heading just under the sticky top bar, with a
// little white space — not under the bar, and not a screen further down.
// A page too short to bring it that high may stop at its end instead.
async function landsUnderBar(page, selector) {
  await expect.poll(() => page.evaluate((sel) => {
    const bar = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const gap = document.querySelector(sel).getBoundingClientRect().top - bar;
    const atEnd = Math.ceil(window.scrollY + window.innerHeight) >=
      document.documentElement.scrollHeight - 1;
    return (gap >= 4 && gap <= 32) || (atEnd && gap > 32) ? 'ok' : 'gap ' + Math.round(gap) + 'px';
  }, selector), { timeout: 5000 }).toBe('ok');
}

test('the What\'s on card lands on 01 Pick your night, and Book parking on 02', async ({ page }) => {
  const [{ event_series: series }] =
    await rest(`event?id=eq.${FIX.night}&select=event_series(slug,name)`);
  await page.goto('/events');
  await page.locator('.ev-card', { hasText: series.name }).locator('a').click();
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}#ev-nights$`));
  await page.waitForLoadState('load');
  await landsUnderBar(page, '#ev-nights');

  await page.locator(`#night-${FIX.night}`).getByRole('link', { name: 'Book parking' }).click();
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
  await landsUnderBar(page, '#bk-tiers-step');
});

test('an old /book?event= link lands on the series page with that night chosen', async ({ page }) => {
  const [{ event_series: series }] =
    await rest(`event?id=eq.${FIX.night}&select=event_series(slug)`);
  await page.goto(`/book?event=${FIX.night}`);
  await expect(page).toHaveURL(new RegExp(`/events/${series.slug}\\?night=${FIX.night}$`));
  await expect(page.locator(`#night-${FIX.night}`)).toHaveClass(/is-chosen/);
  await expect(page.locator('#bk-tiers-step')).toBeVisible();
  await expect(page.locator('#bk-map .bk-map-pin .bk-map-pill').first()).toBeVisible();
});

test('a booking link to a night that is not listed leaves the page as it was', async ({ page }) => {
  await page.goto('/book?event=00000000-0000-4000-8000-000000000000');
  await expect(page.locator('label.bk-fixture').first()).toBeVisible();
  await expect(page.locator('#bk-tiers-step')).toBeHidden();
  await expect(page.locator('input[name="bk-event"]:checked')).toHaveCount(0);
});
