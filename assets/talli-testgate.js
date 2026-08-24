/* =====================================================================
   Talli Parking — passphrase screen for the TEST SITE ONLY

   WHAT THIS IS FOR, honestly stated: keeping the test site out of Google
   and away from a customer who lands on it by accident and tries to book
   a fixture that does not exist. It is a signpost with a lock on it.

   WHAT IT IS NOT: security. The passphrase is in this file, and this file
   is public. Anyone who opens dev tools can read it and walk straight in.
   That is an accepted trade: the test database holds no customer data, and
   the things that could actually cost something — writing bookings, the
   gate screen, taking payment — are all guarded server-side by the
   GATE_PASSPHRASE secret and the service-role key, neither of which is
   reachable from a browser.

   If real access control is ever wanted here, the right answer is
   Netlify's own password protection (Site settings -> Access & security),
   which is enforced at the edge before a byte of HTML is served. It needs
   a paid Netlify plan. Turn it on and delete this file.

   The gate screen at /admin.html is deliberately exempt: it already has a
   passphrase of its own that is checked server-side, and asking for two in
   a row on a phone in the rain helps nobody.
   ===================================================================== */
(function () {
  'use strict';

  if (!window.TALLI || !window.TALLI.isTest) return;
  if (/admin/i.test(window.location.pathname)) return;

  var KEY = 'talli.testsite.unlocked';
  var PASSPHRASE = 'talli-test';

  // Private windows and locked-down browsers throw on storage access.
  // Failing to read is not failing to unlock, so treat it as "still locked"
  // and let them type it again.
  function unlocked() {
    try { return window.sessionStorage.getItem(KEY) === 'yes'; }
    catch (e) { return false; }
  }
  function remember() {
    try { window.sessionStorage.setItem(KEY, 'yes'); } catch (e) { /* fine */ }
  }

  if (unlocked()) return;

  // Hide the page before it paints. Injected from here rather than living
  // in style.css so the rule exists only while the page is actually locked
  // — there is no state where a stylesheet could hide a live page.
  var hider = document.createElement('style');
  hider.textContent = 'body > *:not(.talli-gate) { display: none !important; }';
  (document.head || document.documentElement).appendChild(hider);

  function unlock() {
    remember();
    if (hider.parentNode) hider.parentNode.removeChild(hider);
    var panel = document.querySelector('.talli-gate');
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  function render() {
    var wrap = document.createElement('div');
    wrap.className = 'talli-gate';

    var card = document.createElement('form');
    card.className = 'talli-gate-card';

    var h = document.createElement('h1');
    h.textContent = 'Talli test site';

    var p = document.createElement('p');
    p.textContent =
      'This is the practice version of talli.co.nz. The fixtures are made ' +
      'up and nothing here takes real money.';

    var input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Passphrase';
    input.autocomplete = 'current-password';
    input.setAttribute('aria-label', 'Passphrase');

    var err = document.createElement('p');
    err.className = 'talli-gate-error';
    err.setAttribute('role', 'alert');
    err.hidden = true;
    err.textContent = 'Not that one.';

    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn btn-primary';
    btn.textContent = 'Let me in';

    var foot = document.createElement('p');
    foot.className = 'talli-gate-foot';
    var live = document.createElement('a');
    live.href = 'https://talli.co.nz';
    live.textContent = 'Go to the real site instead';
    foot.appendChild(live);

    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(input);
    card.appendChild(err);
    card.appendChild(btn);
    card.appendChild(foot);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    input.focus();

    card.addEventListener('submit', function (e) {
      e.preventDefault();
      if (input.value.trim() === PASSPHRASE) {
        unlock();
      } else {
        err.hidden = false;
        input.value = '';
        input.focus();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
