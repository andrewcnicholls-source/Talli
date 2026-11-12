/* Talli Parking — gate screen: session.js

   Sign in and role: who the server says is here, and what that person
   is offered.
 */

import { AUTH, CFG, REST, call, el, hide, show, state, text } from './core.js';
import { renderEvents } from './night.js';
import { renderPricePicker } from './tonight.js';
import { stopCardWatch } from './card-qr.js';
import { showTab } from './tabs.js';

/* ------------------------------------------------------------ sign in */

// Three states, and only the server moves us between them: checking,
// signed out, in. There is no client-side rule about who may be here —
// the `session` call either comes back with an identity or it does not.
export function openSession() {
  return call('session').then(function (data) {
    state.who = data.who || null;
    state.events = data.events || [];
    hide(el('ad-lock'));
    show(el('ad-app'));
    renderWho();
    applyRole();
    loadCatalogue();
    if (isOperator()) loadTemplates();
    renderEvents();
  });
}

// Shown when there is no usable session, and when the server turned one
// down. A refused token is not kept: leaving it in storage means every
// reload spends a round trip re-learning the same no.
export function showSignIn(message, code) {
  hide(el('ad-app'));
  hide(el('ad-lock-wait'));
  show(el('ad-lock'));
  show(el('ad-lock-signin'));

  var box = el('ad-lock-error');
  if (message) {
    box.textContent = message;
    show(box);
  } else {
    hide(box);
  }

  // Signed in to Google, correctly, as somebody who is not a host. The
  // ordinary button is a dead end here — Google skips its own picker
  // when there is one session, so pressing it hands over the same
  // refused account again. This is the way out.
  var swap = el('ad-lock-swap');
  if (code === 'NOT_A_HOST') show(swap); else hide(swap);
}

// A 401 means the session is gone or was never good; a 403 means it is a
// real Google account that is not a host. Both land back on the card, but
// the second one has to say so or the person just presses the same button
// again and gets the same silence.
function signedOut(err) {
  AUTH.forget();
  state.who = null;
  state.bank = null;
  // A half-finished walk-up sale behind the card is a walk-up sale
  // somebody will try to submit again after signing back in.
  ['ad-new', 'ad-sell', 'ad-price', 'ad-check', 'ad-qr'].forEach(function (id) {
    hide(el(id));
  });
  stopCardWatch();
  showSignIn(err && err.message, err && err.code);
}

// Andrew sees every tab. A warden works Arrivals only, for their blocks;
// the server enforces that, and this just stops offering what it refuses.
export function isOperator() {
  return !state.who || state.who.operator !== false;
}

function applyRole() {
  var op = isOperator();
  el('ad-tab-night').hidden = !op;
  el('ad-tab-insights').hidden = !op;
  el('ad-tab-sites').hidden = !op;
  el('ad-new-open').hidden = !op;
  offerTapToPay(op);
  // Site info is a warden's second tab, and Andrew's too.
  if (!op && state.tab !== 'gate' && state.tab !== 'info') showTab('gate');
}

// Tap to pay runs through Andrew's terminal and Andrew's Stripe account,
// which a warden has neither of. So a warden is not offered it, on the
// walk-up form or when fixing a booking. The option is taken out of the
// list rather than hidden, because Safari on a phone shows a hidden
// <option> anyway. gate-ops refuses it from a warden as well; this only
// stops offering what the server would refuse.
var tapOptions = null;

function offerTapToPay(yes) {
  if (!tapOptions) {
    tapOptions = ['ad-sell-payment', 'ad-edit-payment'].map(function (id) {
      var select = el(id);
      var opt = select.querySelector('option[value="tap_to_pay"]');
      return { select: select, opt: opt, next: opt.nextSibling };
    });
  }
  tapOptions.forEach(function (t) {
    if (yes && !t.opt.parentNode) t.select.insertBefore(t.opt, t.next);
    if (!yes && t.opt.parentNode) t.select.removeChild(t.opt);
  });
  // A walk-up half-typed by Andrew on this phone before a warden signed in.
  var sell = el('ad-sell-payment');
  if (!yes && !sell.value) sell.value = 'cash';
}

function renderWho() {
  var node = el('ad-who');
  if (!node) return;
  text(node, state.who ? state.who.email : '');
}

// Any call, anywhere on the screen, can be the one that discovers the
// session died. Route those back to the card rather than letting them
// surface as a toast the person cannot act on.
// A warden asking for something that is not theirs (another block's car,
// Andrew's price levers) is refused, not signed out.
var SCOPE_REFUSALS = ['OPERATOR_ONLY', 'NOT_YOUR_SITE'];

export function fatal(err) {
  if (err && (err.status === 401 ||
      (err.status === 403 && SCOPE_REFUSALS.indexOf(err.code) === -1))) {
    signedOut(err);
    return true;
  }
  return false;
}

// The pricing templates, for the dropdown under Prices. The new-event
// modal fetches the same list when it opens; this is the copy the gate
// screen needs without opening anything. A failure here is quiet on
// purpose: it costs the dropdown, and nothing else on the night.
function loadTemplates() {
  return call('event_form')
    .then(function (data) {
      state.templates = data.templates || [];
      state.properties = data.properties || [];
      state.defaultProperty = data.default_property_id || null;
      renderPricePicker();
    })
    .catch(function () {});
}

// The extras catalogue is public — the same rows the booking page reads.
function loadCatalogue() {
  fetch(REST + '/addon?active=is.true&order=sort_order.asc' +
        '&select=code,name,price_cents,bundle_qty,bundle_price_cents,max_qty', {
    headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey },
  })
    .then(function (res) { return res.ok ? res.json() : []; })
    .then(function (items) { state.catalogue = items || []; })
    .catch(function () { state.catalogue = []; });
}
