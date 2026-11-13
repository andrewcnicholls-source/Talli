/* =====================================================================
   Talli Parking — gate screen (entry module)

   Built for one hand, outdoors, at night. Two screens: Arrivals, which is
   the list — search a plate, tap the row, the car is ticked off — and
   Tonight, which is everything that moves during an event: how many spaces
   are really left, what the sign says, and what is still owed.

   All reads and writes go through the gate-ops edge function, which holds
   the service-role credentials and decides, on every request, whether the
   person signed in is a host. Nothing here can reach the database on its
   own — except the extras catalogue, which is public and read straight
   from PostgREST.

   Getting in is Google, via Supabase Auth. assets/talli-auth.js holds the
   tokens; this file only ever asks it for a current one. Nothing on this
   screen decides who is allowed in: a 401 or a 403 from the server is the
   only thing that puts the sign-in card back up.
   ===================================================================== */

/* Native ES modules, no bundler. admin.html loads this file with
   <script type="module">; everything else is imported from here. */

import { AUTH, REFRESH_MS, el, hide, state } from './core.js';
import { openSession, showSignIn } from './session.js';
import { dayKey, loadList, setSite, todayKey } from './night.js';
import { renderList } from './arrivals.js';
import { applyPricePick, paintPriceHint, paintPricePick, submitPrice } from './tonight.js';
import { loadInsight, renderInsight } from './insights.js';
import { openNew, renderNewTiers, saveTemplate, submitNew, tierDraft } from './new-event.js';
import { openSell, renderSellCharge, submitSell } from './walk-up.js';
import { cancelUnpaid, renderEditCharge, submitEdit } from './booking-edit.js';
import { closeCardQr, openCardQr } from './card-qr.js';
import { openCheck } from './check.js';
import { measureHead, showTab } from './tabs.js';
import { renderSiteForm } from './sites.js';
import { initSeries } from './series.js';

/* ------------------------------------------------------------------ init */

function init() {
  el('ad-signin').addEventListener('click', function () {
    AUTH.signInWithGoogle();
  });

  el('ad-lock-swap').addEventListener('click', function () {
    AUTH.signInWithGoogle({ chooseAccount: true });
  });

  el('ad-signout').addEventListener('click', function () {
    AUTH.signOut().then(function () {
      state.who = null;
      window.location.reload();
    });
  });

  el('ad-event').addEventListener('change', function () {
    state.eventId = this.value;
    loadList();
  });

  el('ad-search').addEventListener('input', function () {
    state.filter = this.value.trim();
    renderList();
  });

  el('ad-refresh').addEventListener('click', function () {
    if (state.tab === 'insights') loadInsight(); else loadList();
  });

  window.addEventListener('resize', measureHead);

  el('ad-tab-gate').addEventListener('click', function () { showTab('gate'); });
  el('ad-tab-night').addEventListener('click', function () { showTab('night'); });
  el('ad-site').addEventListener('change', function (e) { setSite(e.target.value); });
  el('ad-tab-insights').addEventListener('click', function () { showTab('insights'); });
  el('ad-tab-sites').addEventListener('click', function () { showTab('sites'); });
  el('ad-tab-info').addEventListener('click', function () { showTab('info'); });
  el('ad-site-pick').addEventListener('change', function (e) { renderSiteForm(e.target.value); });

  el('ad-insight-event').addEventListener('change', function () {
    state.insightId = this.value;
    state.insight = null;
    renderInsight();
    loadInsight();
  });

  el('ad-new-open').addEventListener('click', openNew);
  el('ad-new-close').addEventListener('click', function () { hide(el('ad-new')); });
  initSeries();
  el('ad-new-form').addEventListener('submit', submitNew);
  el('ad-new-save-template').addEventListener('click', saveTemplate);
  el('ad-new-tier-add').addEventListener('click', function () {
    state.newTiers.push(tierDraft());
    renderNewTiers();
  });

  el('ad-sell-open').addEventListener('click', openSell);
  el('ad-sell-close').addEventListener('click', function () { hide(el('ad-sell')); });
  el('ad-sell-form').addEventListener('submit', submitSell);
  // Cash and card are different numbers. Switching the method has to move
  // the figure being read out, not just what gets recorded.
  el('ad-sell-payment').addEventListener('change', renderSellCharge);

  el('ad-edit-close').addEventListener('click', function () { hide(el('ad-edit')); });
  el('ad-edit-form').addEventListener('submit', submitEdit);
  el('ad-edit-payment').addEventListener('change', renderEditCharge);
  el('ad-edit-cancel').addEventListener('click', cancelUnpaid);
  el('ad-edit-qr').addEventListener('click', function () {
    var r = state.edit;
    if (r && r.owes) openCardQr(r.booking_id, r.vehicle_rego);
  });
  el('ad-qr-close').addEventListener('click', closeCardQr);
  el('ad-qr-done').addEventListener('click', closeCardQr);

  el('ad-pricepick-select').addEventListener('change', paintPricePick);
  el('ad-pricepick-apply').addEventListener('click', applyPricePick);

  el('ad-price-close').addEventListener('click', function () { hide(el('ad-price')); });
  el('ad-price-form').addEventListener('submit', submitPrice);
  el('ad-price-input').addEventListener('input', paintPriceHint);

  el('ad-check-open').addEventListener('click', openCheck);
  el('ad-check-close').addEventListener('click', function () {
    el('ad-check').hidden = true;
  });

  // Someone else may be selling at the gate while this phone is open.
  setInterval(function () {
    if (document.hidden || el('ad-app').hidden) return;
    if (state.eventId) loadList(true);
    // A finished night does not move; tonight's "so far" does.
    var seen = state.insight && state.events.filter(function (e) {
      return e.id === state.insight.eventId;
    })[0];
    if (state.tab === 'insights' && seen && dayKey(seen.starts_at) === todayKey()) loadInsight();
  }, REFRESH_MS);

  // Google came back through here on the way to a test-site page that
  // asked for the sign-in. The browser is already leaving; do not start
  // the gate screen up behind it.
  if (AUTH.leaving) return;

  // Coming back from Google with the person having cancelled, or with a
  // redirect URL the project does not allow: say what happened rather
  // than showing the same button as if nothing had been pressed.
  if (AUTH.landingError) {
    showSignIn(AUTH.landingError);
    return;
  }

  // A session on this device gets straight back in — but only because
  // the server said so. openSession() failing routes through post()'s
  // 401/403 handling and puts the card up on its own; anything else
  // (offline, Supabase down) says so and leaves the button there to
  // press again.
  if (!AUTH.hasSession()) {
    showSignIn(null);
    return;
  }

  openSession().catch(function (err) {
    if (err && (err.status === 401 || err.status === 403)) return;
    showSignIn(err.message, err.code);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
