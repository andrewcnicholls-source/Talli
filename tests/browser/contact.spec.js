/* =====================================================================
   Contact us (docs/plans/reviews-and-contact.md, slice 2), as a customer,
   as the person at the gate, and as Andrew see it.

   Done when: a customer sends a message from the homepage and Andrew
   finds it on Insights and ticks it off; the "Text Andrew" link carries
   the number from TALLI.contact; and a car's sheet offers call and text
   with the plate already in the message.
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');
const { test, expect, signedIn } = require('./fixtures');
const { FIX, rest, rpc, plate, forget } = require('../lib/stack');

const tag = `TEST contact browser ${crypto.randomBytes(3).toString('hex')}`;
const made = [];
test.afterAll(async () => {
  await rest(`contact_message?message=like.${encodeURIComponent(tag)}*`, { method: 'DELETE' });
  await forget(made);
});

test('a customer sends a message from the homepage, and Andrew ticks it off', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#contact [data-talli-sms]')).toHaveAttribute('href', /^sms:\+6421347028/);
  await expect(page.locator('#contact [data-talli-phone]')).toHaveAttribute('href', 'tel:+6421347028');

  // A message nobody can answer is stopped before it is sent.
  await page.fill('#contact-message', `${tag}: six cars on Saturday?`);
  await page.click('#contact-submit');
  await expect(page.locator('#contact-error')).toContainText('email or a phone number');

  await page.fill('#contact-email', 'sam@example.com');
  await page.fill('#contact-name', 'Sam');
  await page.click('#contact-submit');
  await expect(page.locator('#contact-done')).toBeVisible();
  await expect(page.locator('#contact-form')).toBeHidden();

  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.click('#ad-tab-insights');
  const msg = page.locator('#ad-messages .ad-message', { hasText: tag });
  await expect(msg).toBeVisible();
  await expect(msg.locator('a[href^="mailto:sam@example.com"]')).toBeVisible();
  await msg.getByRole('button', { name: 'Mark as answered' }).click();
  await expect(page.locator('#ad-messages .ad-message.is-done', { hasText: tag })).toBeVisible();
});

test('a car’s sheet offers call and text, with the plate in the message', async ({ page }) => {
  const rego = plate('CT');
  made.push(rego);
  const id = await rpc('hold_booking', {
    p_event_id: FIX.night, p_property_id: FIX.paice, p_tier_code: 'standard',
    p_email: 'contact.test@example.com', p_rego: rego, p_phone: '021 555 0101',
  });
  await rpc('confirm_booking', { p_booking_id: id, p_payment_intent_id: null });

  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.fill('#ad-search', rego);
  await page.getByRole('button', { name: `Edit ${rego}` }).click();
  await expect(page.locator('#ad-edit')).toBeVisible();

  await expect(page.locator('#ad-reach-call')).toHaveAttribute('href', 'tel:0215550101');
  const lights = page.locator('#ad-reach-quick a', { hasText: 'Lights on' });
  const href = decodeURIComponent(await lights.getAttribute('href'));
  expect(href).toContain('sms:0215550101?&body=');
  expect(href).toContain(rego);
  expect(href).toContain('your lights are on');
});
