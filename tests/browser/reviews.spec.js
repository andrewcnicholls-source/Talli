/* =====================================================================
   Rate us (docs/plans/reviews-and-contact.md), as a customer and as
   Andrew see it.

   Done when: a customer rates the night from the bottom of the homepage,
   saying where they parked, is thanked and offered Google whatever they
   rated; and the operator finds it on the Insights tab.
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');
const { test, expect, signedIn } = require('./fixtures');
const { rest } = require('../lib/stack');

const tag = `TEST review browser ${crypto.randomBytes(3).toString('hex')}`;
test.afterAll(() =>
  rest(`review?comment=like.${encodeURIComponent(tag)}*`, { method: 'DELETE' }));

test('a customer rates the night from the homepage, and Andrew reads it', async ({ page }) => {
  await page.goto('/');
  const form = page.locator('#rate-form');
  await form.scrollIntoViewIfNeeded();

  // Stars are required, and saying so is the page's job, not the server's.
  await page.click('#rate-submit');
  await expect(page.locator('#rate-error')).toHaveText('Choose 1 to 5 stars.');

  await page.click('label[for="rate-2"]');
  await expect(page.locator('#rate-stars label.is-on')).toHaveCount(2);
  await page.fill('#rate-comment', `${tag}: queue at the gate`);

  // The thumbs are about a site, so they wait until one is picked.
  await expect(page.locator('#rate-thumbs')).toBeHidden();
  await page.selectOption('#rate-site', { label: '86 Paice Ave' });
  await expect(page.locator('#rate-thumbs')).toBeVisible();
  await page.locator('.rate-thumb', { hasText: 'Easy to get out?' }).getByLabel('No').check();
  await page.fill('#rate-name', 'Sam');

  await page.click('#rate-submit');
  await expect(page.locator('#rate-done')).toBeVisible();
  await expect(form).toBeHidden();
  // A two-star review is offered Google exactly as a five-star one is.
  await expect(page.locator('#rate-done a[href="review.html"]')).toBeVisible();

  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.click('#ad-tab-insights');
  const review = page.locator('#ad-reviews .ad-review', { hasText: tag });
  await expect(review).toBeVisible();
  await expect(review.locator('.ad-review-stars')).toHaveText('★★☆☆☆');
  await expect(review.locator('.ad-review-meta')).toContainText('86 Paice Ave');
  await expect(review.locator('.ad-review-meta')).toContainText('hard to get out');
  await expect(review.locator('.ad-review-who')).toHaveText('Sam');
});
