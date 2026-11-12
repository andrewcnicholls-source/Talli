/* Talli Parking — gate screen: core.js

   Shared by every part of the gate screen: configuration, the state the
   screen is working from, small DOM and money helpers, and the one way
   anything reaches gate-ops.
 */

import { fatal } from './session.js';

export var CFG = window.TALLI || {};
var FN = CFG.supabaseUrl + '/functions/v1/gate-ops';
export var REST = CFG.supabaseUrl + '/rest/v1';
export var TZ = 'Pacific/Auckland';
export var AUTH = window.TalliAuth;
export var REFRESH_MS = 30000;
// The running order at the gate. Config can override it, but the default
// lives here too: this branch and the test-environment branch each rewrote
// talli-config.js, and whichever way that merge is resolved, the walk-up
// form still has to come up on Standard.
export var GATE_ORDER = CFG.gateTierOrder || ['standard', 'priority', 'valet'];

// The order the arrivals side reads in, which is not the order you sell in.
// Selling goes cheapest first — hold the quick exits back. Working the gate
// goes the other way: Priority and Valet are the cars that need something
// done to them the moment they appear, so they come first and Standard,
// which mostly just parks itself, comes last.
export var ARRIVAL_ORDER = CFG.arrivalTierOrder || ['priority', 'valet', 'standard'];

export var state = {
  // Who the server said we are, from the `session` action. Display only —
  // every request is authorised again on its own.
  who: null,
  events: [],
  eventId: null,
  tab: 'gate',
  rows: [],
  tiers: [],
  // The driveways selling this event, and the one this phone is standing
  // at. With one site (most nights at Paice Ave) none of this shows.
  sites: [],
  siteId: null,
  extras: [],       // what has been pre-purchased and still needs handing over
  catalogue: [],    // what we sell
  summary: null,
  // The Insights tab's night, held apart from the one the gate is working.
  insightId: null,
  insight: null,
  filter: '',
  busy: {},
  sellTier: null,
  sellExtras: {},
  // A deal for this one car, typed on the selected spot's price: cents,
  // or null for the sign. editPrice is the same for the edit sheet.
  sellPrice: null,
  sellPriceEditing: false,
  editPrice: null,
  editPriceEditing: false,
  editPriceLocked: false,
  // The booking open in the edit sheet, and the space it is being moved to.
  edit: null,
  editTier: null,
  priceTier: null,
  // The new-event modal. templates and properties come down when it opens;
  // newTiers is what is being edited, held as objects rather than read back
  // off the inputs so the parts the form does not show survive an edit.
  templates: [],
  properties: [],
  defaultProperty: null,
  newTemplate: null,
  newTiers: [],
  // Not on the form — how long the night runs is the same for every
  // fixture — but a template that says otherwise should not lose it the
  // moment somebody edits a price.
  newEndMinutes: 150,
  // Basis points. 400 = 4%. Comes down with the night's state so the screen
  // and the database never disagree about what a card costs.
  surchargeBps: 0,
};

export function el(id) { return document.getElementById(id); }
export function show(n) { if (n) n.hidden = false; }
export function hide(n) { if (n) n.hidden = true; }
export function text(n, v) { if (n) n.textContent = v; return n; }

export function money(cents) {
  var d = (cents || 0) / 100;
  return '$' + (cents % 100 === 0 ? d.toFixed(0) : d.toFixed(2));
}

// The sign price is the cash price. Card costs us a percentage to accept, so
// card sales — the terminal here, and every sale on the website — pay it.
// Mirrors card_surcharge_cents() in the database; the database still decides
// what the booking records.
// card_qr is the walk-up form's name for "card, on their own phone": it
// is recorded as 'stripe' once paid, and carries the same surcharge.
var CARD_METHODS = ['stripe', 'tap_to_pay', 'card_qr'];

export function surchargeOn(cents, paymentMethod) {
  if (!state.surchargeBps) return 0;
  if (CARD_METHODS.indexOf(paymentMethod) === -1) return 0;
  return Math.round((cents || 0) * state.surchargeBps / 10000);
}

export function asTime(iso) {
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString('en-NZ', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s/g, '').toLowerCase();
}
export function asDate(iso) {
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString('en-NZ', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
}

export function make(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

export function button(cls, label, onClick) {
  var b = make('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// "Standard — best value, expect to wait" is a sentence for the website.
// On the gate screen there is room for the first two words.
export function shortName(tier) {
  return String(tier.label || tier.code).split(/\s+—\s+/)[0];
}

/* ---------------------------------------------------------- transport */

// Every call carries the signed-in host's access token, refreshed first
// if it was about to expire. `apikey` is still the anon key — that is the
// project identifier Supabase's gateway wants, and is not what authorises
// anything.
export function call(action, params) {
  var body = Object.assign({ action: action }, params || {});
  return post(FN, body);
}

export function post(url, body) {
  return AUTH.accessToken().then(function (token) {
    // No token, or a refresh that came back refused. The server would
    // say the same thing a round trip later; saying it here means a
    // phone that lost its session mid-shift lands on the sign-in card
    // rather than on a spinner it cannot get past.
    if (!token) {
      var out = new Error('Your session has expired. Sign in again.');
      out.status = 401;
      out.code = 'NO_SESSION';
      fatal(out);
      throw out;
    }
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        var err = new Error(data.error || ('Request failed (' + res.status + ')'));
        err.status = res.status;
        err.code = data.code;
        // Handled once, here, rather than at each of the dozen call
        // sites: whatever the screen was doing, a refused identity means
        // the same thing and has the same answer. The error still throws
        // so the caller stops; toast() knows to stay quiet behind the
        // sign-in card.
        fatal(err);
        throw err;
      }
      return data;
    });
  });
}

export function toast(message, kind) {
  var t = el('ad-toast');
  // Nothing to say over the sign-in card: the message there is the one
  // that matters, and a toast on top of it just covers the button.
  if (!el('ad-lock').hidden) return;
  t.textContent = message;
  t.className = 'ad-toast' + (kind ? ' is-' + kind : '');
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { hide(t); }, 3500);
}
