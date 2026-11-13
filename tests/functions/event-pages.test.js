/* =====================================================================
   The events pages (plan A2), against the local stack.

   The "done when": a series page as served holds the event details and
   the JSON-LD with no JavaScript run, and a draft or cancelled night
   never appears — not on the series page, the catalogue or the sitemap.
   Nor does a series that has been switched off.

   The pages are fetched from tests/lib/serve.js, which runs the real
   functions with the local stack in place of the hostname's project —
   the same thing `curl` of staging would get, minus the hosted database.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { FIX, rest } = require('../lib/stack');

const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const HIDDEN = {
  draft: '7e57e000-0000-4000-8000-0000000000d1',
  cancelled: '7e57e000-0000-4000-8000-0000000000c1',
  offSeries: '7e57e000-0000-4000-8000-0000000000f1',
};
const OFF_SLUG = 'test-switched-off-series';

let server;
let series;

async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test.before(async () => {
  series = (await rest(`event?id=eq.${FIX.night}&select=event_series(id,slug,name)`))[0].event_series;
  const night = (await rest(`event?id=eq.${FIX.night}&select=starts_at`))[0];
  const at = (days) => new Date(new Date(night.starts_at).getTime() + days * 86400000).toISOString();
  const off = (await rest('event_series', {
    method: 'POST', prefer: 'return=representation',
    body: { slug: OFF_SLUG, name: 'TEST — Switched off series', active: false },
  }))[0];
  await rest('event', {
    method: 'POST',
    body: [
      { id: HIDDEN.draft, name: 'TEST — Hidden draft night', venue: 'Eden Park', starts_at: at(1),
        status: 'draft', series_id: series.id, night_label: 'Draft night' },
      { id: HIDDEN.cancelled, name: 'TEST — Hidden cancelled night', venue: 'Eden Park', starts_at: at(2),
        status: 'cancelled', series_id: series.id, night_label: 'Cancelled night' },
      { id: HIDDEN.offSeries, name: 'TEST — Switched off night', venue: 'Eden Park', starts_at: at(3),
        status: 'on_sale', series_id: off.id, night_label: 'Off night' },
    ],
  });

  server = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'serve.js'), String(PORT)],
    { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/index.html')).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the local site server did not start');
});

test.after(async () => {
  if (server) server.kill();
  await rest(`event?id=in.(${Object.values(HIDDEN).join(',')})`, { method: 'DELETE' });
  await rest(`event_series?slug=eq.${OFF_SLUG}`, { method: 'DELETE' });
});

test('a series page carries the details and JSON-LD in the HTML as served', async () => {
  const r = await get(`/events/${series.slug}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(r.text.includes(`<h1>${series.name}</h1>`), 'the series name is in the page');
  assert.ok(r.text.includes(`id="night-${FIX.night}"`), 'the fixture night is in the page');
  assert.ok(r.text.includes(`id="night-${FIX.soldOutNight}"`), 'so is the second');
  assert.ok(r.text.includes(`href="/book?event=${FIX.night}"`), 'each night links to booking');

  const block = r.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, 'JSON-LD is in the page');
  const ld = JSON.parse(block[1]);
  const starts = (await rest(`event?id=in.(${FIX.night},${FIX.soldOutNight})&select=id,starts_at&order=starts_at`));
  assert.deepEqual(ld.map((e) => e.url.split('#night-')[1]), starts.map((e) => e.id));
  for (const e of ld) {
    assert.equal(e['@context'], 'https://schema.org');
    assert.ok(e.name && e.startDate && e.location && e.location.name, JSON.stringify(e));
  }
  // Test is never indexed, in the header as well as the page.
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
});

test('a draft or cancelled night never appears', async () => {
  const pages = [
    (await get(`/events/${series.slug}`)).text,
    (await get('/events')).text,
  ];
  for (const html of pages) {
    for (const id of [HIDDEN.draft, HIDDEN.cancelled]) assert.ok(!html.includes(id), id);
    for (const word of ['Draft night', 'Cancelled night']) assert.ok(!html.includes(word), word);
  }
});

test('a switched-off series has no page and is listed nowhere', async () => {
  assert.equal((await get(`/events/${OFF_SLUG}`)).status, 404);
  assert.ok(!(await get('/events')).text.includes(OFF_SLUG));
  assert.ok(!(await get('/sitemap.xml')).text.includes(OFF_SLUG));
  assert.ok(!(await get('/events')).text.includes(HIDDEN.offSeries));
});

test('the catalogue lists the series with its nights, and the sitemap its page', async () => {
  const cat = await get('/events');
  assert.equal(cat.status, 200);
  assert.ok(cat.text.includes(`href="/events/${series.slug}"`));
  assert.ok(cat.text.includes(`data-event-ids="${FIX.night},${FIX.soldOutNight}"`));

  const map = await get('/sitemap.xml');
  assert.equal(map.status, 200);
  assert.match(map.headers.get('content-type'), /xml/);
  assert.ok(map.text.includes(`<loc>https://talli.co.nz/events/${series.slug}</loc>`));
  assert.ok(map.text.includes('<loc>https://talli.co.nz/events</loc>'));
});

test('an unknown series is a 404 page that is never indexed', async () => {
  const r = await get('/events/no-such-series');
  assert.equal(r.status, 404);
  assert.match(r.text, /noindex/);
});
