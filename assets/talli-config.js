/* =====================================================================
   Talli Parking — front-end configuration

   Everything here is public by design. The Supabase anon key is safe in
   the browser: row-level security only exposes on-sale events and active
   tiers, and the `booking` table has no public policy at all — bookings
   are written solely by the create-checkout edge function under the
   service role.

   Two projects sit behind the same pages, and which one a page talks to is
   decided by where it is being served from:

     talli.co.nz            live. The real customers, the real money.
     anything else          test. Netlify previews, branch deploys, the
                            talli-test site, a file opened off the desktop.

   The real business has a real domain, so that is the one thing treated as
   real. Everything else is a rehearsal and defaults to the test project —
   getting that backwards means a rehearsal writing into the real database,
   which is the kind of mistake nobody notices until it matters.

   ?env=live or ?env=test overrides either way and sticks for the tab, so it
   survives a checkout round-trip. The gate screen says which one it is on
   in its header: a night run against the wrong database would be a very
   quiet kind of disaster.
   ===================================================================== */
(function () {
  'use strict';

  var ENVS = {
    live: {
      supabaseUrl: 'https://oxzwfemyavznykqixhvk.supabase.co',
      anonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94endmZW15YXZ6bnlrcWl4aHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2OTg4MDUsImV4cCI6MjEwMjI3NDgwNX0.' +
        'iBO1h71PWSbFVkqMZ8dxIJnVWmjjbRMIvO_OpCi-syQ',
    },
    test: {
      supabaseUrl: 'https://uhdoverwvlxvyyctskle.supabase.co',
      anonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZG92ZXJ3dmx4dnl5Y3Rza2xlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzU2NTAsImV4cCI6MjEwMjg1MTY1MH0.' +
        'XTVReAgSp7l7D-mc-wgU8HBp4WHiiw9aFkEA8DIvdEE',
    },
  };

  var KEY = 'talli.env';

  function chosen() {
    var asked = null;
    try {
      asked = new URLSearchParams(window.location.search).get('env');
    } catch (e) { /* very old browser; live it is */ }

    if (asked === 'test' || asked === 'live') {
      try { sessionStorage.setItem(KEY, asked); } catch (e) { /* private mode */ }
      return asked;
    }

    var stuck = null;
    try { stuck = sessionStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (stuck && ENVS[stuck]) return stuck;

    // The custom domain, and only the custom domain, is the live business.
    var host = String(window.location.hostname || '').toLowerCase();
    return (host === 'talli.co.nz' || host === 'www.talli.co.nz') ? 'live' : 'test';
  }

  var env = chosen();

  window.TALLI = {
    env: env,
    isTest: env === 'test',
    supabaseUrl: ENVS[env].supabaseUrl,
    anonKey: ENVS[env].anonKey,

    // Six tiers is too much to put in front of someone on a phone. These three
    // carry the page; the rest sit behind "more options". Order is deliberate —
    // best value first, then the two upsells.
    headlineTiers: ['standard', 'priority', 'valet'],
  };
})();
