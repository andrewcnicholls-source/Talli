/* =====================================================================
   The Sites page's own small rules (plan B3): reading a map position
   pasted from Google Maps, and saying a database refusal in words.

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function sites() {
  globalThis.window = { TALLI: { supabaseUrl: 'https://proj.supabase.co' }, TalliAuth: {} };
  globalThis.document = { readyState: 'loading', addEventListener() {} };
  try {
    return await import(pathToFileURL(path.join(__dirname, '..', '..', 'assets', 'admin', 'sites.js')).href);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
}

test('a position is read from two numbers or a Google Maps link', async () => {
  const { parsePosition } = await sites();
  assert.deepEqual(parsePosition('-36.880692, 174.742279'), [-36.880692, 174.742279]);
  assert.deepEqual(parsePosition('https://www.google.com/maps/@-36.880692,174.742279,19z'),
    [-36.880692, 174.742279]);
  assert.equal(parsePosition('70 Gribblehurst Road'), null);
  assert.equal(parsePosition('-136.1, 174.7'), null, 'not a latitude');
  assert.equal(parsePosition(''), null);
});

test('a refusal by name is said in words, never as the code', async () => {
  const { explain } = await sites();
  const named = (code, message) => Object.assign(new Error(message), { code });
  assert.match(explain(named('SITE_HAS_BOOKINGS', 'SITE_HAS_BOOKINGS: x')), /booked here/);
  assert.match(explain(named('SITE_IS_ANCHOR', 'SITE_IS_ANCHOR: x')), /anchor first/);
  assert.equal(explain(named('BELOW_SOLD', 'BELOW_SOLD: 2 standard already sold for that night')),
    '2 standard already sold for that night');
  assert.equal(explain(new Error('Network down')), 'Network down');
});
