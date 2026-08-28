/* =====================================================================
   Talli Parking — front-end configuration and environment switch

   ONE codebase serves two sites. Which backend a page talks to is decided
   here, by hostname, at load time — nothing is swapped at deploy time and
   there is no build step to get wrong.

     talli.co.nz            -> PRODUCTION  (real customers, real money)
     anything else          -> TEST        (talli-test, fake fixtures)

   The default is deliberately TEST. A page opened from a preview URL, a
   local file, or a hostname nobody thought about lands on the test
   backend. The failure mode of guessing wrong is then a wasted test, not
   a real booking against real inventory.

   Both anon keys are public by design. Row-level security only exposes
   listed events and active tiers; the `booking` table has no public policy
   at all — bookings are written solely by the create-checkout edge
   function under the service role.
   ===================================================================== */
(function () {
  'use strict';

  var PRODUCTION = {
    name: 'production',
    supabaseUrl: 'https://oxzwfemyavznykqixhvk.supabase.co',
    anonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94endmZW15YXZ6bnlrcWl4aHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2OTg4MDUsImV4cCI6MjEwMjI3NDgwNX0.' +
      'iBO1h71PWSbFVkqMZ8dxIJnVWmjjbRMIvO_OpCi-syQ',
  };

  var TEST = {
    name: 'test',
    supabaseUrl: 'https://uhdoverwvlxvyyctskle.supabase.co',
    anonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZG92ZXJ3dmx4dnl5Y3Rza2xlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzU2NTAsImV4cCI6MjEwMjg1MTY1MH0.' +
      'XTVReAgSp7l7D-mc-wgU8HBp4WHiiw9aFkEA8DIvdEE',
  };

  // Only these hostnames are the real thing. Everything else is test.
  //
  // The Pages project's own talli.pages.dev is deliberately NOT here.
  // It serves the same commit as production, so leaving it out means it
  // talks to the test database behind a red banner rather than standing
  // up a second, unwatched copy of the live booking page.
  var PRODUCTION_HOSTS = [
    'talli.co.nz',
    'www.talli.co.nz',
  ];

  var host = (window.location.hostname || '').toLowerCase();
  var env = PRODUCTION_HOSTS.indexOf(host) !== -1 ? PRODUCTION : TEST;
  var isTest = env !== PRODUCTION;

  window.TALLI = {
    environment: env.name,
    isTest: isTest,
    supabaseUrl: env.supabaseUrl,
    anonKey: env.anonKey,

    // Six tiers is too much to put in front of someone on a phone. These three
    // carry the page; the rest sit behind "more options". Order is deliberate —
    // best value first, then the two upsells.
    headlineTiers: ['standard', 'priority', 'valet'],

    // The running order at the gate, which is not the order the database
    // sorts by. You sell the cheap spaces first and keep the quick exits
    // back: Standard until it's gone, then Priority, then Valet. Anything
    // else the fixture offers falls in behind these.
    gateTierOrder: ['standard', 'priority', 'valet'],
  };

  if (!isTest) return;

  /* ------------------------------------------------------------------
     From here down: test-site only. None of it can run on production,
     because the function has already returned.

     Two jobs. Mark the page unmistakably, and keep it out of Google.
     ------------------------------------------------------------------ */

  // Set on <html> as early as possible so the stylesheet can recolour the
  // gate screen before anything is painted.
  document.documentElement.setAttribute('data-talli-env', 'test');

  // Belt and braces alongside the header Cloudflare sends. A crawler that
  // ignores one may still honour the other.
  var robots = document.createElement('meta');
  robots.name = 'robots';
  robots.content = 'noindex, nofollow, noarchive';
  (document.head || document.documentElement).appendChild(robots);

  // A banner on every page, in the normal flow so it never fights the
  // sticky header underneath it.
  function addBanner() {
    if (document.querySelector('.talli-env-banner')) return;
    var bar = document.createElement('div');
    bar.className = 'talli-env-banner';
    bar.setAttribute('role', 'status');
    bar.textContent = 'TEST SITE — fake fixtures, not the live booking page';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addBanner);
  } else {
    addBanner();
  }
})();
