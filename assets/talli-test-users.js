/* =====================================================================
   Talli Gate — "sign in as a test user", on the TEST SITE ONLY

   Device testing needs to see the gate screen as a warden, and Andrew has
   one Google account. So on the test site the sign-in card also offers the
   invented accounts from supabase/test-only/seed-test-users.sql, signed in
   by password. Each is an ordinary Supabase session; gate-ops resolves it,
   insists on a confirmed email and looks it up in host_user exactly as it
   does a Google one. Nothing on the server knows this file exists.

   On production this file does nothing: the first statement returns. And
   if it somehow ran there, TalliAuth.signInWithPassword refuses off the
   test site, and production's password provider is switched off anyway.
   scripts/check.sh asserts the guard below stays the first thing here.

   The password is not a secret. Everything these accounts reach is test
   data and Stripe test mode.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  if (!CFG.isTest) return;

  var PASSWORD = 'talli-test-only';
  var USERS = [
    ['operator.test@example.com', 'Operator (sees everything)'],
    ['warden.test@example.com', 'Warden — Gribblehurst (test)'],
    ['warden.paice.test@example.com', 'Warden — Paice Ave'],
    ['warden.nogrants.test@example.com', 'Warden with every block off'],
    ['outsider.test@example.com', 'Signed in, not a host'],
  ];

  function build() {
    var host = document.getElementById('ad-lock-signin');
    if (!host || !window.TalliAuth) return;

    var box = document.createElement('div');
    box.className = 'ad-lock-test';
    box.id = 'ad-lock-test';

    var lead = document.createElement('p');
    lead.textContent = 'Test site only: or sign in as one of the invented test users.';
    box.appendChild(lead);

    var select = document.createElement('select');
    select.className = 'ad-select';
    select.id = 'ad-test-user';
    select.setAttribute('aria-label', 'Test user');
    USERS.forEach(function (u) { select.appendChild(new Option(u[1], u[0])); });
    box.appendChild(select);

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline';
    button.id = 'ad-test-signin';
    button.textContent = 'Sign in as test user';
    box.appendChild(button);

    button.addEventListener('click', function () {
      button.disabled = true;
      window.TalliAuth.signInWithPassword(select.value, PASSWORD)
        .then(function () { window.location.reload(); })
        .catch(function (err) {
          button.disabled = false;
          var error = document.getElementById('ad-lock-error');
          if (!error) return;
          // The usual reason, said plainly: the provider is a dashboard
          // switch on the test project (DEPLOYMENT.md § 0c).
          error.textContent = /disabled/i.test(err.message)
            ? 'Password sign-in is switched off on this project. See DEPLOYMENT.md § 0c.'
            : err.message;
          error.hidden = false;
        });
    });

    host.appendChild(box);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
