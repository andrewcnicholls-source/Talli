/* =====================================================================
   The selector at the top of the gate screen, plan B6: all, a block, or
   one site, and every tab follows it.

   The arithmetic is proved in tests/units/scope.test.js; the warden's
   options in gate.spec.js. These check the screen: the figures on
   Arrivals and the Event tab add up from site to block to all, and the
   choice is still there after a reload.
   ===================================================================== */
'use strict';
const { test, expect, signedIn } = require('./fixtures');
const { FIX } = require('../lib/stack');

async function openNight(page) {
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-live')).toContainText('Fixture night');
  await expect(page.locator('#ad-scope option[value="all"]')).toHaveCount(1);
}

const cents = (s) => Math.round(Number(String(s).replace(/[^0-9.]/g, '')) * 100);

// Arrived and booked from the headline, and the money taken.
async function arrivals(page) {
  const [arrived, total] = (await page.locator('#ad-stat-arrived').textContent())
    .split('/').map(Number);
  return { arrived, total, taken: cents(await page.locator('#ad-stat-taken').textContent()) };
}

async function eventTab(page) {
  const lead = page.locator('#ad-money .ad-money-row.is-lead').first();
  return {
    filled: Number(await page.locator('#ad-board-filled').textContent()),
    capacity: Number(await page.locator('#ad-board-capacity').textContent()),
    taken: cents(await lead.locator('strong').textContent()),
  };
}

function sum(list) {
  const out = {};
  for (const x of list) for (const k of Object.keys(x)) out[k] = (out[k] || 0) + x[k];
  return out;
}

// The scope tree as the screen offers it: { all, blocks: [{ value, sites }] }.
async function tree(page) {
  const opts = await page.locator('#ad-scope option').evaluateAll(
    (os) => os.map((o) => o.value));
  const blocks = [];
  for (const v of opts) {
    if (v.startsWith('block:')) blocks.push({ value: v, sites: [] });
    else if (v.startsWith('site:') && blocks.length) blocks[blocks.length - 1].sites.push(v);
  }
  return blocks;
}

async function figures(page, value, read) {
  await page.selectOption('#ad-scope', value);
  await expect(page.locator('#ad-scope')).toHaveValue(value);
  return read(page);
}

async function addsUp(page, read) {
  const blocks = await tree(page);
  expect(blocks.length).toBeGreaterThan(1);
  const blockFigures = [];
  for (const b of blocks) {
    const whole = await figures(page, b.value, read);
    const parts = [];
    for (const s of b.sites) parts.push(await figures(page, s, read));
    expect(sum(parts), `${b.value} is its sites added up`).toEqual(whole);
    blockFigures.push(whole);
  }
  const all = await figures(page, 'all', read);
  expect(sum(blockFigures), 'all is the blocks added up').toEqual(all);
}

test('Arrivals: each site adds up to its block, and the blocks to all', async ({ page }) => {
  await signedIn(page, 'operator');
  await openNight(page);
  await addsUp(page, arrivals);
});

test('Event tab: each site adds up to its block, and the blocks to all', async ({ page }) => {
  await signedIn(page, 'operator');
  await openNight(page);
  await page.click('#ad-tab-night');
  await expect(page.locator('#ad-pane-night')).toBeVisible();
  await addsUp(page, eventTab);
});

test('the list follows the selector, and the choice survives a reload', async ({ page }) => {
  await signedIn(page, 'operator');
  await openNight(page);

  await page.selectOption('#ad-scope', 'site:' + FIX.gribNeighbour);
  // Every car on the list is at the chosen site.
  const chips = await page.locator('#ad-list .ad-chip.is-site').allTextContents();
  for (const c of chips) expect(c).not.toMatch(/Paice/);

  await page.reload();
  await expect(page.locator('#ad-app')).toBeVisible();
  await expect(page.locator('#ad-scope')).toHaveValue('site:' + FIX.gribNeighbour);

  // Site info is about the chosen site.
  await page.click('#ad-tab-info');
  await expect(page.locator('#ad-info-site')).not.toContainText('Paice');

  await page.selectOption('#ad-scope', 'all');
});
