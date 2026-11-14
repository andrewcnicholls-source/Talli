/* =====================================================================
   People (plan B8), on a phone, a tablet and a desktop.

   Andrew invites a warden from the Sites page with one area, switches a
   second area on, then deactivates them — by tapping, no SQL. A warden
   is not offered the section at all. The rules themselves are proved in
   the database and functions suites (12_warden_access, warden-access).
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');
const { test, expect, signedIn } = require('./fixtures');
const { rest } = require('../lib/stack');

let email = null;
test.afterEach(async () => {
  if (email) await rest(`host_user?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
  email = null;
});

test('a warden is invited, given a second area and switched off, by tapping', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  email = `b8.ui.${crypto.randomBytes(3).toString('hex')}@example.com`;
  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await page.click('#ad-tab-sites');

  const people = page.locator('#ad-people');
  await expect(people).toBeVisible();
  await expect(people.getByText('operator.test@example.com')).toBeVisible();

  await page.fill('#ad-people-email', email);
  await people.locator('.ad-people-invite label', { hasText: 'Gribblehurst (test)' }).click();
  await people.getByRole('button', { name: 'Invite' }).click();

  const card = people.locator('.ad-people-card', { hasText: email });
  await expect(card).toBeVisible();
  await expect(card).toContainText('not signed in yet');
  await expect(card.getByRole('checkbox', { name: 'Gribblehurst (test)' })).toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'Paice Ave' })).not.toBeChecked();

  await card.getByRole('checkbox', { name: 'Paice Ave' }).check();
  await expect(card.getByRole('checkbox', { name: 'Paice Ave' })).toBeChecked();
  await expect.poll(async () => {
    const [hu] = await rest(`host_user?email=eq.${encodeURIComponent(email)}&select=id`);
    return (await rest(`staff_block_access?host_user_id=eq.${hu.id}&active=eq.true&select=block_id`)).length;
  }).toBe(2);

  await card.getByRole('button', { name: 'Deactivate' }).click();
  await expect(card).toContainText('switched off');
  await expect(card.getByRole('button', { name: 'Reactivate' })).toBeVisible();
  const [row] = await rest(`host_user?email=eq.${encodeURIComponent(email)}&select=active,scope`);
  expect(row).toEqual({ active: false, scope: 'blocks' });
});

test('an invitation with no area says so and makes nothing', async ({ page }) => {
  email = `b8.ui.${crypto.randomBytes(3).toString('hex')}@example.com`;
  await signedIn(page, 'operator');
  await page.goto('/admin');
  await page.click('#ad-tab-sites');
  await page.fill('#ad-people-email', email);
  await page.locator('#ad-people').getByRole('button', { name: 'Invite' }).click();
  await expect(page.locator('#ad-people .ad-people-invite .ad-sheet-error')).toContainText('at least one area');
  expect(await rest(`host_user?email=eq.${encodeURIComponent(email)}&select=id`)).toEqual([]);
});

test('a warden is not offered People', async ({ page }) => {
  await signedIn(page, 'wardenGrib');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-tab-sites')).toBeHidden();
  await expect(page.locator('#ad-people')).toBeHidden();
});
