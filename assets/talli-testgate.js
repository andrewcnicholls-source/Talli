/* =====================================================================
   Talli Parking — sign-in screen for the TEST SITE ONLY

   The test site is for Talli staff. Hosts work on production and never
   here. That split is not written in this file: it is a property of the
   data. The test Supabase project has its own host_user list, separate
   from production's, and only staff are put on it. A production host has
   no row on test, so their Google account gets a polite no.

   HOW: the same Google sign-in as the gate screen, and the same server
   check. gate-ops' `session` action resolves the Google token with
   Supabase Auth and asks host_access_for() whether that verified email is
   on the list — on the test project, the staff list. Signing in on the
   gate screen therefore opens the whole test site too, and the other way
   round: one sign-in, kept in localStorage across tabs, not a passphrase
   typed per tab.

   WHAT IT STILL IS NOT: edge security. The HTML and JS are served before
   this runs, and the pages hold nothing secret — the test database holds
   no customer data, and everything that writes is guarded server-side. If
   the pages themselves ever need hiding, Cloudflare Access in front of the
   staging hostname is the tool; this file can then go.

   The gate screen at /admin is exempt: it already signs in with Google
   and checks the same list on every request, so this would only show the
   same question twice. Local development (localhost) is exempt too:
   nobody stumbles onto it, and Google cannot send a token back to it.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  if (!CFG.isTest) return;
  if (/admin/i.test(window.location.pathname)) return;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return;

  // Checked once per tab, then trusted for the rest of it. Every page
  // load asking the server again would put a round trip in front of every
  // click on the test site for no gain: this is a signpost, not a vault.
  var KEY = 'talli.testsite.staff';

  function verified() {
    try { return window.sessionStorage.getItem(KEY) === 'yes'; }
    catch (e) { return false; }
  }
  function remember() {
    try { window.sessionStorage.setItem(KEY, 'yes'); } catch (e) { /* fine */ }
  }

  // Hide the page before it paints. Injected from here rather than living
  // in style.css so the rule exists only while the page is actually locked
  // — there is no state where a stylesheet could hide a live page.
  var hider = null;
  function hidePage() {
    hider = document.createElement('style');
    hider.textContent = 'body > *:not(.talli-gate) { display: none !important; }';
    (document.head || document.documentElement).appendChild(hider);
  }

  function unlock() {
    remember();
    if (hider && hider.parentNode) hider.parentNode.removeChild(hider);
    var panel = document.querySelector('.talli-gate');
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  // Public pages do not load the sign-in script — production never needs
  // it on them. The test site does, so fetch it here, on test only.
  function withAuth(then) {
    if (window.TalliAuth) return then();
    var s = document.createElement('script');
    s.src = '/assets/talli-auth.js';
    s.onload = then;
    s.onerror = function () { show({ message: 'Could not load sign-in. Refresh to try again.' }); };
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------ the card */

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function make(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  // One card, redrawn for each state: checking, signed out, not staff,
  // or could not check.
  function show(state) {
    whenReady(function () {
      var old = document.querySelector('.talli-gate');
      if (old) old.parentNode.removeChild(old);

      var wrap = make('div', 'talli-gate');
      var card = make('div', 'talli-gate-card');
      card.appendChild(make('h1', null, 'Talli test site'));
      card.appendChild(make('p', null,
        'This is the practice version of talli.co.nz, for Talli staff. ' +
        'The fixtures are made up and nothing here takes real money.'));

      if (state.message) {
        var err = make('p', 'talli-gate-error', state.message);
        err.setAttribute('role', 'alert');
        card.appendChild(err);
      }

      if (state.checking) {
        card.appendChild(make('p', 'talli-gate-wait', 'Checking who you are…'));
      } else if (state.retry) {
        var again = make('button', 'btn btn-primary', 'Try again');
        again.type = 'button';
        again.addEventListener('click', check);
        card.appendChild(again);
      } else {
        // Coming back here after Google is part of the sign-in, so tell it
        // where "here" is. Google returns through the gate screen's address,
        // which is already on Supabase's allow-list, and is sent straight on.
        var go = make('button', 'btn btn-primary', 'Sign in with Google');
        go.type = 'button';
        go.addEventListener('click', function () {
          window.TalliAuth.signInWithGoogle({
            chooseAccount: !!state.wrongAccount,
            returnTo: window.location.pathname + window.location.search,
          });
        });
        card.appendChild(go);
        if (state.wrongAccount) {
          card.appendChild(make('p', 'talli-gate-hint',
            'Pick the Google account you use for Talli staff.'));
        }
      }

      var foot = make('p', 'talli-gate-foot');
      var live = make('a', null, 'Go to the real site instead');
      live.href = 'https://talli.co.nz';
      foot.appendChild(live);
      card.appendChild(foot);

      wrap.appendChild(card);
      document.body.appendChild(wrap);
    });
  }

  /* ----------------------------------------------------------- the check */

  // The server is the only thing that can say who is staff here. The same
  // request the gate screen opens with; a 200 is a yes.
  function check() {
    var auth = window.TalliAuth;
    if (auth.landingError) {
      show({ message: auth.landingError });
      return;
    }
    if (!auth.hasSession()) {
      show({});
      return;
    }

    show({ checking: true });
    auth.accessToken()
      .then(function (token) {
        if (!token) return { status: 401 };
        return fetch(CFG.supabaseUrl + '/functions/v1/gate-ops', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: CFG.anonKey,
            Authorization: 'Bearer ' + token,
          },
          body: JSON.stringify({ action: 'session' }),
        }).then(function (res) {
          return res.json().then(
            function (data) { return { status: res.status, data: data }; },
            function () { return { status: res.status, data: {} }; });
        });
      })
      .then(function (r) {
        if (r.status === 200) {
          unlock();
        } else if (r.status === 401) {
          // Expired or revoked. Not kept: it would fail the same way again.
          auth.forget();
          show({ message: 'Your sign-in has expired. Sign in again.' });
        } else if (r.status === 403) {
          // A real Google account that is not on the test site's list —
          // most often a host, who belongs on talli.co.nz instead.
          auth.forget();
          show({
            wrongAccount: true,
            message: (r.data && r.data.code === 'NOT_A_HOST')
              ? 'That Google account is not on the staff list for the test site.'
              : (r.data && r.data.error) || 'That account cannot use the test site.',
          });
        } else {
          show({ retry: true, message: 'Could not check your sign-in just now.' });
        }
      })
      .catch(function () {
        show({ retry: true, message: 'Could not reach Talli. Check your connection.' });
      });
  }

  if (verified()) return;
  hidePage();
  withAuth(check);
})();
