/* =====================================================================
   Arrivals, plan B5: a warden records a lost space and undoes it, and a
   full Standard still sells, saying where the car goes.

   The order and the counts are proved in the database suite; gate-ops'
   scoping in tests/functions/placement.test.js. These check the screen.
   ===================================================================== */
'use strict';
const { test, expect, signedIn } = require('./fixtures');
const { FIX, gate, rest, plate, forget } = require('../lib/stack');

const made = [];
const clearLost = () => rest(`lost_space?event_id=eq.${FIX.night}`, { method: 'DELETE' });

test.beforeEach(clearLost);
test.afterEach(async () => {
  await forget(made.splice(0));
  await clearLost();
});

async function openNight(page) {
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-live')).toContainText('Fixture night');
  // The night has loaded once the site picker has the block's two sites.
  await expect(page.locator('#ad-site option')).toHaveCount(2);
}

test('a warden records a lost space, sees it, and undoes it', async ({ page }) => {
  await signedIn(page, 'wardenGrib');
  await openNight(page);

  await page.click('#ad-lost-open');
  await expect(page.locator('#ad-lost')).toBeVisible();
  // Their own sites only.
  const sites = await page.locator('#ad-lost-site option').allTextContents();
  expect(sites.join(' ')).not.toMatch(/Paice/);

  // A reason is required.
  await page.click('#ad-lost-submit');
  await expect(page.locator('#ad-lost-error')).toHaveText(/why/);

  await page.locator('#ad-lost-reasons .ad-pick-opt', { hasText: 'Blocked' }).click();
  await page.fill('#ad-lost-note', 'skip bin');
  await page.click('#ad-lost-submit');
  await expect(page.locator('#ad-lost-list .ad-lost-item')).toHaveCount(1);
  await expect(page.locator('#ad-lost-list')).toContainText('skip bin');

  const [row] = await rest(`lost_space?event_id=eq.${FIX.night}&select=reason,undone_at,recorded_by`);
  expect(row.reason).toBe('blocked');
  expect(row.undone_at).toBeNull();
  expect(row.recorded_by).not.toBeNull();

  await page.locator('#ad-lost-list .ad-lost-undo').click();
  await expect(page.locator('#ad-lost-list .ad-lost-item')).toHaveCount(0);
  const [undone] = await rest(`lost_space?event_id=eq.${FIX.night}&select=undone_at`);
  expect(undone.undone_at).not.toBeNull();
});

test('a full Standard still sells, and says where the car goes', async ({ page }) => {
  // Every free Standard space at the anchor is lost, so the next walk-up
  // there goes to the neighbour's Standard.
  const list = await gate('operator', { action: 'list' });
  const t = list.body.tiers.find((x) => x.property_id === FIX.gribAnchor && x.code === 'standard');
  for (let i = 0; i < t.spots_left_gate; i++) {
    await gate('operator', { action: 'lose_space', property_id: FIX.gribAnchor,
      tier_code: 'standard', reason: 'blocked' });
  }

  await signedIn(page, 'wardenGrib');
  await openNight(page);
  await page.selectOption('#ad-site', FIX.gribAnchor);
  await page.click('#ad-sell-open');

  const tile = page.locator('#ad-sell-tiers .ad-pick-opt').first();
  await expect(tile).not.toHaveClass(/is-gone/);
  await expect(tile).toHaveClass(/is-on/);
  await expect(tile).toContainText(/full — takes a Standard space at/);

  const rego = plate('GS');
  made.push(rego);
  await page.fill('#ad-sell-rego', rego);
  await page.click('#ad-sell-submit');
  await expect(page.locator('#ad-sell')).toBeHidden();
  await expect(page.locator('#ad-toast')).toContainText(/send to/);

  const [row] = await rest(`booking?vehicle_rego=eq.${rego}&select=property_id,tier_code`);
  expect(row).toEqual({ property_id: FIX.gribNeighbour, tier_code: 'standard' });
});
