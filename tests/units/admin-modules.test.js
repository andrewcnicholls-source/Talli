/* =====================================================================
   assets/admin/ — the gate screen as native ES modules (plan S0).

   The split from one 3,000-line closure into modules is only safe if
   every module links: each import names a file that exists and an export
   it really has. A browser that finds one missing does not run any of the
   gate screen — on a phone in the dark, that is a blank page. Node links
   modules by the same rules, so importing the entry module here is the
   cheapest place to catch it.

   Fake window and document, just enough for the modules to evaluate.
   Nothing is rendered, nothing is fetched.

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'assets', 'admin');

test('every gate-screen module links, and main.js waits for the page', async () => {
  const listeners = [];
  globalThis.window = { TALLI: { supabaseUrl: 'https://proj.supabase.co' }, TalliAuth: {} };
  globalThis.document = {
    readyState: 'loading',
    addEventListener(type, fn) { listeners.push([type, fn]); },
  };
  try {
    await import(pathToFileURL(path.join(DIR, 'main.js')).href);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
  assert.deepEqual(listeners.map(([type]) => type), ['DOMContentLoaded'],
    'main.js should start the screen once, when the page is ready');
});

test('main.js reaches every module in assets/admin/', () => {
  // A module nothing imports is dead code that still ships, or a part of
  // the screen that silently stopped being wired up.
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([\w-]+\.js)'/g)) visit(m[1]);
  };
  visit('main.js');
  assert.deepEqual(files.filter((f) => !seen.has(f)), []);
});

test('admin.html loads the gate screen as one module, and not the old file', () => {
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map((m) => m[0]);
  const admin = scripts.filter((s) => /assets\/admin[/.]/.test(s));
  assert.deepEqual(admin, ['<script type="module" src="assets/admin/main.js">']);
  assert.equal(fs.existsSync(path.join(ROOT, 'assets', 'admin.js')), false,
    'assets/admin.js is back: two copies of the gate screen');
});
