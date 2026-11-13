/* =====================================================================
   The site guide and the Locate Us card (plan A4), against the local
   stack.

   Done when: a warden opens the guide for their site in two taps (the
   browser suite), a driver scanning the card lands on that site's page
   and reaches navigation in one more tap, the page offers the next
   events to book, and a booking in a second block never shows a Paice
   Ave direction. Here: the /go/ pages as served, what gate-ops gives a
   warden for the guide, and who may change a card.

   Pages come from tests/lib/serve.js, the real functions with the local
   stack in place of the hostname's project.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { FIX, gate, rest } = require('../lib/stack');

const PORT = 4175;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

// Most tests put picture rows in as gate-ops leaves them; one uploads a
// real file through gate-ops and fetches it back from the bucket.
const picPath = (site) => `site/${site}/${require('node:crypto').randomUUID()}.png`;

// The smallest PNG there is: one white pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

async function get(p) {
  const res = await fetch(BASE + p, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const slugOf = async (table, id) =>
  (await rest(`${table}?id=eq.${id}&select=slug`))[0].slug;

let paiceSlug;
let gribAnchorSlug;
let gribBlock;
const pictures = [];

test.before(async () => {
  paiceSlug = await slugOf('property', FIX.paice);
  gribAnchorSlug = await slugOf('property', FIX.gribAnchor);
  const p = (await rest(`property?id=eq.${FIX.gribAnchor}&select=block:block_id(id,slug)`))[0];
  gribBlock = p.block;

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
  if (pictures.length) await rest(`site_picture?id=in.(${pictures.join(',')})`, { method: 'DELETE' });
});

test('every site and block has a slug; a site\'s is its number and street', async () => {
  assert.equal(paiceSlug, '86paice', '86 Paice Avenue is /go/86paice');
  assert.ok(gribBlock.slug, 'the Gribblehurst block has a slug');
  const all = await rest('property?select=slug');
  assert.ok(all.every((r) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.slug)), 'every site has a well-formed slug');
});

test('scanning a site\'s card lands on its page, one tap from navigation', async () => {
  const r = await get(`/go/${paiceSlug}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /<h1>86 Paice Avenue<\/h1>/);
  // The two buttons, straight to the driveway's position.
  assert.match(r.text, /id="go-google" href="https:\/\/www\.google\.com\/maps\/dir\/\?api=1&amp;destination=-?\d/);
  assert.match(r.text, /id="go-apple" href="https:\/\/maps\.apple\.com\/\?daddr=-?\d/);
  // The directions come before the next events.
  assert.ok(r.text.indexOf('id="go-google"') < r.text.indexOf('Book your space here'));
});

test('the page offers the next events to book, each to its series page', async () => {
  const r = await get(`/go/${paiceSlug}`);
  const series = (await rest(`event?id=eq.${FIX.night}&select=event_series(slug)`))[0].event_series;
  assert.ok(r.text.includes(`href="/events/${series.slug}?night=${FIX.night}"`),
    'the fixture night links to its series page with that night chosen');
});

test('a booking in a second block never shows a Paice Ave direction', async () => {
  for (const slug of [gribBlock.slug, gribAnchorSlug]) {
    const r = await get(`/go/${slug}`);
    assert.equal(r.status, 200, `/go/${slug}`);
    const main = r.text.slice(r.text.indexOf('<header class="hero'), r.text.indexOf('<footer>'));
    assert.doesNotMatch(main, /paice/i, `/go/${slug} says nothing of Paice Ave above the footer`);
    assert.match(main, /Gribblehurst/);
  }
  // The block's page tells them a neighbour may be where they park.
  const block = await get(`/go/${gribBlock.slug}`);
  assert.match(block.text, /within 100m/);
});

test('the public page never shows the bank details', async () => {
  const bank = (await rest('bank_transfer_setting?select=account_name,account_number'))[0] || {};
  for (const slug of [paiceSlug, gribBlock.slug]) {
    const r = await get(`/go/${slug}`);
    if (bank.account_number) assert.ok(!r.text.includes(bank.account_number), 'no account number');
    if (bank.account_name) assert.ok(!r.text.includes(bank.account_name), 'no account name');
  }
});

test('a slug typed with capitals is sent to the lower-case page; an unknown one is a 404', async () => {
  const up = await get('/go/86PAICE');
  assert.equal(up.status, 301);
  assert.equal(up.headers.get('location'), '/go/86paice');
  assert.equal((await get('/go/no-such-place')).status, 404);
  assert.equal((await get('/go/<script>')).status, 404);
  const bare = await get('/go');
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), '/getting-here');
});

test('a switched-off site has no page', async () => {
  const host = (await rest(`property?id=eq.${FIX.paice}&select=host_id`))[0].host_id;
  const site = (await rest('property', {
    method: 'POST', prefer: 'return=representation',
    body: { host_id: host, name: 'TEST A4 switched off', address: '999 Nowhere Road, Sandringham (test)', active: false },
  }))[0];
  try {
    assert.equal(site.slug, '999nowhere');
    assert.equal((await get('/go/999nowhere')).status, 404);
  } finally {
    await rest(`property?id=eq.${site.id}`, { method: 'DELETE' });
  }
});

test('a warden\'s guide carries their sites\' cards and pictures, and nobody else\'s', async () => {
  const [grib] = await rest('site_picture', {
    method: 'POST', prefer: 'return=representation',
    body: { property_id: FIX.gribAnchor, path: picPath(FIX.gribAnchor), caption: 'TEST — pull up to the garage' },
  });
  const [paice] = await rest('site_picture', {
    method: 'POST', prefer: 'return=representation',
    body: { property_id: FIX.paice, path: picPath(FIX.paice) },
  });
  pictures.push(grib.id, paice.id);
  const up = { body: { picture: grib } };
  const paicePic = { body: { picture: paice } };

  const r = await gate('wardenGrib', { action: 'list' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.sites.map((s) => s.property_id);
  assert.ok(ids.includes(FIX.gribAnchor), 'their anchor is there');
  assert.ok(!ids.includes(FIX.paice), 'Paice Ave is not');
  const anchor = r.body.sites.find((s) => s.property_id === FIX.gribAnchor);
  assert.equal(anchor.slug, gribAnchorSlug);
  assert.equal(anchor.block_slug, gribBlock.slug);
  assert.deepEqual(anchor.pictures.map((p) => p.caption), ['TEST — pull up to the garage']);
  const all = JSON.stringify(r.body);
  assert.ok(!all.includes(paicePic.body.picture.path), 'no Paice Ave picture reaches the warden');

  // And the picture is on the public page.
  const page = await get(`/go/${gribAnchorSlug}`);
  assert.ok(page.text.includes(up.body.picture.path.split('/').pop()), 'the picture is on /go/');
  assert.ok(page.text.includes('TEST — pull up to the garage'), 'with its caption');
});

test('only Andrew changes a card\'s address or pictures', async () => {
  const tries = [
    { action: 'save_place_slug', kind: 'site', id: FIX.gribAnchor, slug: 'warden-was-here' },
    { action: 'upload_site_picture', property_id: FIX.gribAnchor, content_type: 'image/png', data: PNG },
    { action: 'save_site_picture', picture_id: pictures[0] || FIX.gribAnchor, caption: 'x' },
    { action: 'remove_site_picture', picture_id: pictures[0] || FIX.gribAnchor },
  ];
  for (const body of tries) {
    const r = await gate('wardenGrib', body);
    assert.equal(r.status, 403, `${body.action}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'OPERATOR_ONLY');
  }
  assert.equal(await slugOf('property', FIX.gribAnchor), gribAnchorSlug, 'the slug is unchanged');
});

test('an address is refused if taken or badly formed, and changes when it is free', async () => {
  const taken = await gate('operator', { action: 'save_place_slug', kind: 'block', id: gribBlock.id, slug: paiceSlug });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'SLUG_TAKEN', 'a site\'s slug is not free for a block');
  const bad = await gate('operator', { action: 'save_place_slug', kind: 'site', id: FIX.gribAnchor, slug: 'two  words' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'BAD_SLUG');

  const moved = await gate('operator', { action: 'save_place_slug', kind: 'site', id: FIX.gribAnchor, slug: 'TEST-a4-moved' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.slug, 'test-a4-moved');
  try {
    assert.equal((await get('/go/test-a4-moved')).status, 200);
    assert.equal((await get(`/go/${gribAnchorSlug}`)).status, 404, 'the old address is gone');
  } finally {
    await gate('operator', { action: 'save_place_slug', kind: 'site', id: FIX.gribAnchor, slug: gribAnchorSlug });
  }
});

test('a picture uploads to the public bucket and shows on the /go/ page', async () => {
  const up = await gate('operator', {
    action: 'upload_site_picture', property_id: FIX.gribNeighbour,
    content_type: 'image/png', data: PNG, caption: 'TEST — uploaded',
  });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  pictures.push(up.body.picture.id);
  assert.match(up.body.picture.path, new RegExp(`^site/${FIX.gribNeighbour}/[0-9a-f-]+\\.png$`));
  const { stack } = require('../lib/stack');
  const got = await fetch(`${stack.apiUrl}/storage/v1/object/public/site-pictures/${up.body.picture.path}`);
  assert.equal(got.status, 200, 'readable by anyone, as the /go/ page needs');
  const slug = await slugOf('property', FIX.gribNeighbour);
  const page = await get(`/go/${slug}`);
  assert.ok(page.text.includes(up.body.picture.path), 'on the site’s page');

  const rm = await gate('operator', { action: 'remove_site_picture', picture_id: up.body.picture.id });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  const gone = await fetch(`${stack.apiUrl}/storage/v1/object/public/site-pictures/${up.body.picture.path}`);
  assert.notEqual(gone.status, 200, 'and out of the bucket when removed');
});

test('a picture that is not one is refused', async () => {
  const r = await gate('operator', {
    action: 'upload_site_picture', property_id: FIX.paice,
    content_type: 'image/png', data: Buffer.from('not a picture').toString('base64'),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'BAD_PICTURE');
  const huge = await gate('operator', {
    action: 'upload_site_picture', property_id: FIX.paice, content_type: 'image/gif', data: PNG,
  });
  assert.equal(huge.status, 400, 'a type we do not take');
  const nobody = await gate('operator', {
    action: 'upload_site_picture', property_id: '00000000-0000-4000-8000-000000000000',
    content_type: 'image/png', data: PNG,
  });
  assert.equal(nobody.status, 404, 'a site that does not exist');
});

test('a picture’s caption and order change, and it comes off', async () => {
  const made = await rest('site_picture', {
    method: 'POST', prefer: 'return=representation',
    body: [
      { property_id: FIX.berm, path: picPath(FIX.berm), sort_order: 0, caption: 'one' },
      { property_id: FIX.berm, path: picPath(FIX.berm), sort_order: 1, caption: 'two' },
    ],
  });
  pictures.push(...made.map((m) => m.id));
  const [one, two] = made;
  assert.equal((await gate('operator', { action: 'save_site_picture', picture_id: two.id, caption: ' second ', move: -1 })).status, 200);
  const order = await rest(`site_picture?property_id=eq.${FIX.berm}&order=sort_order&select=id,caption`);
  assert.deepEqual(order.map((o) => o.id), [two.id, one.id], 'moved up');
  assert.equal(order[0].caption, 'second', 'caption trimmed');
  // These rows have no file behind them: the bucket call finds nothing,
  // which is logged, never surfaced. The picture is off the page either way.
  const rm = await gate('operator', { action: 'remove_site_picture', picture_id: one.id });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal((await rest(`site_picture?id=eq.${one.id}`)).length, 0);
});
