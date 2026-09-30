/* =====================================================================
   Talli Parking — host sign-in

   Google, through Supabase Auth, with no library. The rest of this site
   talks to Supabase with plain fetch and has no build step; pulling a
   bundled SDK off a CDN just to hold three tokens would have been the
   largest dependency in the repository, loaded on the one page that has
   to work on a cold phone at the end of a driveway.

   So this is the OAuth redirect flow written out:

     1. Send the browser to Supabase's /authorize?provider=google. It
        bounces to Google and back to `redirect_to` — which must be listed
        in the project's Auth redirect URLs or Supabase refuses it.
     2. Supabase returns the tokens in the URL fragment. Read them, store
        them, and take them straight back out of the address bar.
     3. Before any call, hand back an access token that is still good,
        refreshing it first if it is not.

   WHERE THE TOKENS LIVE: localStorage, deliberately, not sessionStorage.
   A phone that kills the tab between the 5pm setup and the 7pm kickoff
   must not come back to a sign-in screen. The trade is that the token
   survives on the device, which is the same trade every "keep me signed
   in" makes, and the session is an hour long and revocable server-side.

   WHAT THIS FILE IS NOT: an authorisation check. Nothing here decides
   whether someone may open the gate screen. Being signed in to Google
   proves only who you are; gate-ops asks the database whether that
   identity is a host, on every single request, and a browser cannot
   answer that question for itself.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var AUTH = CFG.supabaseUrl + '/auth/v1';
  var KEY = 'talli.auth.session';

  // Refresh this far ahead of expiry. Long enough that a slow 3G round
  // trip at the gate cannot land after the token has died.
  var SKEW_SECONDS = 120;

  var session = null;      // { access_token, refresh_token, expires_at }
  var refreshing = null;   // the one in-flight refresh, shared by all callers

  function now() { return Math.floor(Date.now() / 1000); }

  /* -------------------------------------------------------- storage */

  // Private windows and locked-down browsers throw on storage access.
  // Failing to read is not failing to be signed in — it means this tab
  // holds the session in memory only, which still works for one sitting.
  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function save(s) {
    session = s;
    try {
      if (s) window.localStorage.setItem(KEY, JSON.stringify(s));
      else window.localStorage.removeItem(KEY);
    } catch (e) { /* in-memory only for this tab */ }
  }

  function accept(payload) {
    if (!payload || !payload.access_token) return null;
    // expires_at is authoritative when Supabase sends it; expires_in is
    // relative to a clock we do have, which is why it is the fallback and
    // not the other way round.
    var expires = Number(payload.expires_at) ||
      (now() + (Number(payload.expires_in) || 3600));
    save({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || (session && session.refresh_token) || '',
      expires_at: expires,
    });
    return session;
  }

  /* ------------------------------------------------- the return trip */

  // Where Supabase is told to send the browser back to. The query string
  // is dropped on purpose: it ends up in the project's allowed-redirect
  // list, and a list of every URL anyone ever arrived with is not a list.
  function redirectTarget() {
    return window.location.origin + window.location.pathname;
  }

  // Supabase hands the tokens back in the fragment — or an error, if the
  // person cancelled at Google or the redirect URL is not allow-listed.
  // Either way the address bar is cleaned before anything else runs, so a
  // screenshot of the gate screen never carries a live token.
  function captureHash() {
    var hash = window.location.hash || '';
    if (hash.indexOf('access_token=') === -1 && hash.indexOf('error=') === -1) {
      return null;
    }

    var params = new URLSearchParams(hash.replace(/^#/, ''));
    try {
      window.history.replaceState(null, '',
        window.location.pathname + window.location.search);
    } catch (e) {
      window.location.hash = '';
    }

    if (params.get('error')) {
      return {
        error: params.get('error_description') || params.get('error'),
      };
    }

    accept({
      access_token: params.get('access_token'),
      refresh_token: params.get('refresh_token'),
      expires_in: params.get('expires_in'),
      expires_at: params.get('expires_at'),
    });
    return { signedIn: true };
  }

  /* ---------------------------------------------------------- tokens */

  function refresh() {
    if (refreshing) return refreshing;
    if (!session || !session.refresh_token) return Promise.resolve(null);

    refreshing = fetch(AUTH + '/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.anonKey },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('refresh rejected');
        return res.json();
      })
      .then(function (data) { return accept(data); })
      .catch(function () {
        // A refresh token that no longer works means signed out, and
        // saying so plainly beats retrying against a revoked session.
        save(null);
        return null;
      })
      .then(function (result) { refreshing = null; return result; });

    return refreshing;
  }

  // The one call every request makes. Resolves to a token that had not
  // expired at the moment it was handed over, or null for signed out.
  function accessToken() {
    if (!session) return Promise.resolve(null);
    if (session.expires_at - now() > SKEW_SECONDS) {
      return Promise.resolve(session.access_token);
    }
    return refresh().then(function (s) { return s ? s.access_token : null; });
  }

  /* ------------------------------------------------------ in and out */

  // chooseAccount forces Google's account picker. Worth having because
  // Google skips the picker when there is exactly one signed-in session,
  // so somebody who signed in with the wrong account has no way back: the
  // button just hands the same refused identity over again.
  function signInWithGoogle(opts) {
    window.location.href = AUTH + '/authorize?provider=google' +
      ((opts && opts.chooseAccount) ? '&prompt=select_account' : '') +
      '&redirect_to=' + encodeURIComponent(redirectTarget());
  }

  // Tell Supabase first so the refresh token dies server-side, then drop
  // the local copy. The local drop happens either way: a sign-out that
  // fails on a flat connection must still sign this phone out.
  function signOut() {
    var token = session && session.access_token;
    save(null);
    if (!token) return Promise.resolve();
    return fetch(AUTH + '/logout', {
      method: 'POST',
      headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + token },
    }).then(function () {}, function () {});
  }

  session = load();
  var landing = captureHash();

  window.TalliAuth = {
    // Set when this page load WAS the return trip from Google, so the
    // screen can report "you cancelled" rather than silently offering the
    // button again.
    landingError: (landing && landing.error) || null,
    hasSession: function () { return !!session; },
    accessToken: accessToken,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    forget: function () { save(null); },
  };
})();
