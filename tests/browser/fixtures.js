/* =====================================================================
   What every browser test starts from.

   1. The pages talk to the LOCAL stack. assets/talli-config.js sends any
      host that is not talli.co.nz to the shared test project; the suite
      must not write there (it is Andrew's device-testing database). So
      the config is served as it is, with two lines after it that point
      this one browser at the local stack. The file on disk is unchanged
      and the environment switch in it still runs first.
   2. Signing in is a real password session from the local auth server,
      placed where assets/talli-auth.js keeps a Google one. gate-ops then
      checks it exactly as it checks Google's.
   ===================================================================== */
'use strict';
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { stack, signIn, USERS } = require('../lib/stack');

const CONFIG = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'talli-config.js'), 'utf8');
const LOCAL = `\n;(function(){ window.TALLI.supabaseUrl = ${JSON.stringify(stack.apiUrl)};` +
  ` window.TALLI.anonKey = ${JSON.stringify(stack.anonKey)};` +
  // No Google Maps key locally: the booking page falls back to its own map.
  ` window.TALLI.googleMapsKey = ''; })();\n`;

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.route('**/assets/talli-config.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: CONFIG + LOCAL }));
    // Nothing leaves this machine: the hosted test project, production,
    // Google and map tiles are all out of bounds for the suite.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await use(page);
  },
});

// Open a page already signed in as one of the seeded test users.
async function signedIn(page, who) {
  const s = await signIn(USERS[who]);
  const session = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at,
  };
  await page.addInitScript((value) => {
    window.localStorage.setItem('talli.auth.session', value);
  }, JSON.stringify(session));
}

module.exports = { test, expect: base.expect, signedIn };
