/* =====================================================================
   functions/_lib/site.js — the events pages (plan A2), without a network.

   1. The function picks its database by the same rule as the browser.
      assets/talli-config.js is run here, as a browser would run it, for
      each hostname, and the answer compared with projectFor(). If the
      two ever disagree, a page could render production data on a test
      host, or the other way round.
   2. What a series can hold cannot break the page: its text is escaped,
      and nothing in it can close the JSON-LD script early.
   3. noindex everywhere but production.

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = fs.readFileSync(path.join(ROOT, 'assets', 'talli-config.js'), 'utf8');
const load = () => import(pathToFileURL(path.join(ROOT, 'functions', '_lib', 'site.js')).href);

// What assets/talli-config.js decides for this hostname.
function browserProject(hostname) {
  const el = () => ({ setAttribute() {}, appendChild() {}, insertBefore() {} });
  const window = { location: { hostname } };
  const document = {
    readyState: 'complete',
    documentElement: el(),
    head: el(),
    body: Object.assign(el(), { firstChild: null }),
    createElement: el,
    querySelector: () => null,
    addEventListener() {},
  };
  vm.runInNewContext(CONFIG, { window, document });
  return { name: window.TALLI.environment, supabaseUrl: window.TALLI.supabaseUrl, anonKey: window.TALLI.anonKey };
}

const HOSTS = [
  'talli.co.nz', 'www.talli.co.nz', 'TALLI.CO.NZ',
  'talli.pages.dev', 'staging.talli.pages.dev', 'abc123.talli.pages.dev',
  'localhost', '127.0.0.1', 'talli.co.nz.example.com', 'eviltalli.co.nz', '',
];

test('the function and the browser choose the same project for every host', async () => {
  const site = await load();
  for (const host of HOSTS) {
    const fn = site.projectFor(host);
    const br = browserProject(host);
    assert.equal(fn.name, br.name, host);
    assert.equal(fn.supabaseUrl, br.supabaseUrl, host);
    assert.equal(fn.anonKey, br.anonKey, host);
  }
  assert.equal(site.projectFor('talli.co.nz').name, 'production');
  assert.equal(site.projectFor('staging.talli.pages.dev').name, 'test');
});

const NOW = new Date('2026-11-20T00:00:00Z');
const PROJECT = { name: 'test', supabaseUrl: 'https://proj.supabase.co', anonKey: 'k' };
const nasty = '</script><img src=x onerror=alert(1)>"\'&';
const series = () => ({
  id: 's1', slug: 'bruno-mars', name: 'Bruno ' + nasty, kind: 'concert', venue: 'Eden Park',
  summary: 'Three nights. ' + nasty, picture_path: 'series/s1/a b.png',
  nights: [
    { id: 'e1', name: 'Bruno Mars (one)', night_label: 'First show', venue: 'Eden Park',
      starts_at: '2026-11-27T07:00:00+00:00', online_sales_close_at: '2026-11-27T06:00:00+00:00',
      status: 'on_sale', picture_path: null },
    { id: 'e2', name: 'Bruno Mars (two)', night_label: null, venue: 'Eden Park',
      starts_at: '2026-11-28T07:00:00+00:00', online_sales_close_at: null,
      status: 'announced', picture_path: 'nights/e2.jpg' },
  ],
});

test('series text is escaped in the page and cannot end the JSON-LD early', async () => {
  const site = await load();
  const html = site.renderSeries(PROJECT, series(), { now: NOW, noindex: false });
  assert.ok(!html.includes('<img src=x'), 'markup from a series must not reach the page');
  const scripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  assert.equal(scripts.length, 1);
  const ld = JSON.parse(scripts[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  assert.equal(ld.length, 2, 'one Event per night');
  assert.equal(ld[0]['@type'], 'MusicEvent');
  assert.equal(ld[0].name, 'Bruno ' + nasty + ' — First show');
  assert.equal(ld[0].startDate, '2026-11-27T07:00:00+00:00');
  assert.equal(ld[0].location.name, 'Eden Park');
  assert.deepEqual(ld[0].image, ['https://proj.supabase.co/storage/v1/object/public/event-pictures/series/s1/a%20b.png']);
  assert.deepEqual(ld[1].image, ['https://proj.supabase.co/storage/v1/object/public/event-pictures/nights/e2.jpg'],
    'a night with its own picture uses it');
  assert.ok(!('offers' in ld[0]), 'prices are loaded in the browser, never in the markup');
});

test('a series page has its title, canonical, Open Graph and each night', async () => {
  const site = await load();
  const html = site.renderSeries(PROJECT, series(), { now: NOW, noindex: false });
  assert.match(html, /<link rel="canonical" href="https:\/\/talli\.co\.nz\/events\/bruno-mars">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/proj\.supabase\.co\/storage/);
  assert.match(html, /<title>Bruno &lt;\/script&gt;/);
  assert.ok(!/name="robots"/.test(html), 'production with nights to come is indexable');
  assert.match(html, /id="night-e1"[\s\S]*Book parking[\s\S]*id="night-e2"[\s\S]*Tell me when it opens/);
  assert.match(html, /href="\/book\?event=e1"/);
});

test('noindex on every non-production page, and on a series with nothing to come', async () => {
  const site = await load();
  const robots = /<meta name="robots" content="noindex, nofollow, noarchive">/;
  assert.match(site.renderSeries(PROJECT, series(), { now: NOW, noindex: true }), robots);
  assert.match(site.renderCatalogue(PROJECT, [], { noindex: true }), robots);
  assert.match(site.renderSeries(PROJECT, Object.assign(series(), { nights: [] }), { now: NOW, noindex: false }), robots);
  assert.match(site.renderNotFound({}), robots);
});

test('a night past its online close says so, and so does one not yet on sale', async () => {
  const site = await load();
  const n = series().nights[0];
  assert.equal(site.nightState(n, NOW).key, 'on_sale');
  assert.equal(site.nightState(n, new Date('2026-11-27T06:30:00Z')).key, 'closed');
  assert.equal(site.nightState(series().nights[1], NOW).key, 'soon');
});

test('the sitemap lists the static pages, the catalogue and every series', async () => {
  const site = await load();
  const xml = site.renderSitemap([{ slug: 'bruno-mars' }, { slug: 'blues' }]);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [
    ...site.STATIC_PAGES.map((p) => 'https://talli.co.nz' + p),
    'https://talli.co.nz/events',
    'https://talli.co.nz/events/bruno-mars',
    'https://talli.co.nz/events/blues',
  ]);
});

test('a slug that is not a slug is not looked up', async () => {
  const site = await load();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(url); return new Response('[]'); };
  try {
    for (const slug of ['', '../etc', 'a,b', 'Bruno', 'x)&or=(1', 'a--b']) {
      assert.equal(await site.loadSeries(PROJECT, slug, NOW), null, slug);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, []);
});

test('a database that will not answer gives 503, not a page that says nothing is on', async () => {
  const site = await load();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 500 });
  try {
    const cat = await site.handleCatalogue(new Request('https://talli.co.nz/events'), PROJECT, NOW);
    assert.equal(cat.status, 503);
    assert.equal(cat.headers.get('cache-control'), 'no-store');
    const map = await site.handleSitemap(new Request('https://talli.co.nz/sitemap.xml'), PROJECT, NOW);
    assert.equal(map.status, 200, 'the sitemap still lists the static pages');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('each route file reads the project its hostname names, and no other', async () => {
  const routes = [
    ['functions/events/index.js', {}],
    ['functions/events/[slug].js', { slug: 'bruno-mars' }],
    ['functions/sitemap.xml.js', {}],
  ];
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('[]'); };
  try {
    for (const [file, params] of routes) {
      const mod = await import(pathToFileURL(path.join(ROOT, file)).href);
      for (const [host, ref] of [['talli.co.nz', 'oxzwfemyavznykqixhvk'],
                                 ['staging.talli.pages.dev', 'uhdoverwvlxvyyctskle']]) {
        seen.length = 0;
        const res = await mod.onRequestGet({ request: new Request(`https://${host}/x`), params });
        assert.ok(res.status === 200 || res.status === 404, `${file} on ${host}: ${res.status}`);
        assert.ok(seen.length > 0, `${file} read nothing`);
        for (const url of seen) assert.ok(url.startsWith(`https://${ref}.supabase.co/rest/v1/`), `${file} on ${host} read ${url}`);
        assert.equal(res.headers.get('x-robots-tag'), host === 'talli.co.nz' ? null : 'noindex, nofollow, noarchive',
          `${file} on ${host}`);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
