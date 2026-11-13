/* =====================================================================
   Event series from the gate screen (plan A1).

   "Done when: test holds a series with three nights and a picture, all
   editable from the screen." So this does exactly that, as Andrew: makes
   a series from the Tonight tab with a picture, then puts two more nights
   in it, and reads it all back.

   Its own three draft nights, so nothing else's fixture is moved.
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');
const { test, expect, signedIn } = require('./fixtures');
const { rest } = require('../lib/stack');

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let nights = [];
let seriesName;
let tag;

test.beforeEach(async ({}, info) => {
  tag = info.project.name + '-' + crypto.randomBytes(2).toString('hex');
  seriesName = `TEST — Series ${tag}`;
  nights = await rest('event', {
    method: 'POST',
    prefer: 'return=representation',
    body: [1, 2, 3].map((n) => ({
      name: `TEST — Unsorted ${tag} ${n}`,
      starts_at: new Date(Date.now() + (60 + n) * 86400000).toISOString(),
      status: 'draft',
    })),
  });
});

test.afterEach(async () => {
  await rest(`event?id=in.(${nights.map((n) => n.id).join(',')})`, { method: 'DELETE' });
  // The series made here, and the ones the three nights started in.
  await rest(`event_series?name=like.*${tag}*`, { method: 'DELETE' });
});

async function openSeriesFor(page, night) {
  // The event picker is Tonight's alone (plan B2).
  await page.click('#ad-tab-night');
  await page.selectOption('#ad-event', night.id);
  await page.click('#ad-series-open');
  await expect(page.locator('#ad-series')).toBeVisible();
  // Loaded when the picker has more than its placeholder.
  await expect(page.locator('#ad-series-pick option[value="__new"]')).toHaveCount(1);
}

test('a series with three nights and a picture, made on the screen', async ({ page }) => {
  await signedIn(page, 'operator');
  await page.goto('/admin');
  await expect(page.locator('#ad-app')).toBeVisible();

  // Night one: a new series, with its picture.
  await openSeriesFor(page, nights[0]);
  await page.selectOption('#ad-series-pick', '__new');
  await page.fill('#ad-series-name', seriesName);
  await page.selectOption('#ad-series-kind', 'concert');
  await page.fill('#ad-series-summary', 'Three nights at Eden Park.');
  await page.fill('#ad-series-night', 'Night 1');
  await page.setInputFiles('#ad-series-file',
    { name: 'poster.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('#ad-series-pic')).toBeVisible();
  await page.click('#ad-series-save');
  await expect(page.locator('#ad-series')).toBeHidden();
  await expect(page.locator('#ad-status-series')).toHaveText(`Series: ${seriesName} · Night 1`);

  // Nights two and three join it.
  for (const [i, label] of [[1, 'Night 2'], [2, 'Night 3']]) {
    await openSeriesFor(page, nights[i]);
    await page.selectOption('#ad-series-pick', { label: seriesName });
    await expect(page.locator('#ad-series-name')).toHaveValue(seriesName);
    await page.fill('#ad-series-night', label);
    await page.click('#ad-series-save');
    await expect(page.locator('#ad-series')).toBeHidden();
    await expect(page.locator('#ad-status-series')).toHaveText(`Series: ${seriesName} · ${label}`);
  }

  // Read back from the screen: three nights, the picture, the address.
  await openSeriesFor(page, nights[2]);
  await expect(page.locator('#ad-series-nights li')).toHaveCount(3);
  await expect(page.locator('#ad-series-nights li.is-this')).toContainText('Night 3');
  await expect(page.locator('#ad-series-pic')).toBeVisible();
  const slug = await page.inputValue('#ad-series-slug');
  expect(slug).toMatch(/^test-series-/);

  // And from the database.
  const rows = await rest(`event?id=in.(${nights.map((n) => n.id).join(',')})` +
    '&select=night_label,series:series_id(name,picture_path)&order=starts_at');
  expect(rows.map((r) => r.night_label)).toEqual(['Night 1', 'Night 2', 'Night 3']);
  expect(new Set(rows.map((r) => r.series.name))).toEqual(new Set([seriesName]));
  expect(rows[0].series.picture_path).toMatch(/\.png$/);
});
