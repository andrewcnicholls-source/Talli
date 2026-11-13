/* Talli Parking — gate screen: walk-up.js

   The walk-up sale sheet.
 */

import { button, call, el, hide, make, money, shortName, show, state,
  surchargeOn, text, toast } from './core.js';
import { chosenHere, loadList, multiSite, siteName, tiersHere } from './night.js';
import { inGateOrder } from './tonight.js';
import { openCardQr } from './card-qr.js';
import { sayPlaced, spillSays } from './placement.js';

// Still sellable at the gate: room of its own, or — Standard only — a
// space it spills into elsewhere in the block (plan B5).
function sellable(t) {
  return !t.manually_sold_out && (t.spots_left_gate > 0 || !!t.spill);
}

/* -------------------------------------------------------- walk-up sale */

// Opening the sheet does not wipe it. A walk-up closed half-typed — the
// driver went to find their wallet, the terminal would not connect — comes
// back as it was left. Only a sale that went through clears it.
export function openSell() {
  el('ad-sell-error').hidden = true;
  // The type picked last time may have filled up since.
  var still = tiersHere().filter(function (t) {
    return t.code === state.sellTier && sellable(t);
  })[0];
  if (!still) {
    state.sellTier = null;
    state.sellPrice = null;
  }
  state.sellPriceEditing = false;
  renderSellAt();
  renderSellTiers();
  renderSellExtras();
  renderSellCharge();
  show(el('ad-sell'));
}

// Said on the sheet, because with a block or all chosen at the top the
// site is not the one on screen: it is the block's anchor (plan B6).
function renderSellAt() {
  var line = el('ad-sell-at');
  if (!line) return;
  line.hidden = !multiSite() || !state.siteId;
  if (line.hidden) return;
  text(line, 'At ' + siteName(state.siteId) + (chosenHere() ? ''
    : ' — choose one site at the top to sell somewhere else.'));
}

function clearSell() {
  el('ad-sell-form').reset();
  state.sellTier = null;
  state.sellExtras = {};
  state.sellPrice = null;
  state.sellPriceEditing = false;
}

function renderSellTiers() {
  var wrap = el('ad-sell-tiers');
  wrap.innerHTML = '';
  var tiers = inGateOrder(tiersHere());

  // Default to the first thing still sellable, which once a type is full
  // is the next one up. That is the whole point of the ordering.
  if (!state.sellTier) {
    var first = tiers.filter(sellable)[0];
    state.sellTier = first ? first.code : null;
  }

  tiers.forEach(function (t) {
    var gone = !sellable(t);
    var on = state.sellTier === t.code;
    var deal = on && state.sellPrice > 0 && state.sellPrice !== t.price_cents;
    var opt = pickTile('ad-pick-opt' + (on ? ' is-on' : '') + (gone ? ' is-gone' : ''),
      gone, function () {
        if (state.sellTier === t.code) return;
        // A deal was struck for the spot it was typed against.
        state.sellTier = t.code;
        state.sellPrice = null;
        state.sellPriceEditing = false;
        renderSellTiers();
        renderSellCharge();
      });

    var line = make('span', 'ad-pick-line');
    line.appendChild(make('span', 'ad-pick-name', shortName(t)));
    if (on) {
      line.appendChild(priceSlot({
        cents: deal ? state.sellPrice : t.price_cents,
        editing: state.sellPriceEditing,
        label: 'Change the price for this car',
        start: function () { state.sellPriceEditing = true; renderSellTiers(); },
        input: function (cents) { state.sellPrice = cents; renderSellCharge(); },
        done: function () {
          // Left empty, or with something that is not a price: back to the sign.
          if (!(state.sellPrice > 0)) state.sellPrice = null;
          state.sellPriceEditing = false;
          renderSellTiers();
          renderSellCharge();
        },
      }));
    } else {
      line.appendChild(make('span', 'ad-pick-price', money(t.price_cents)));
    }
    opt.appendChild(line);

    var left = t.manually_sold_out ? 'marked sold out'
      : t.spots_left_gate > 0 ? t.spots_left_gate + ' left'
      : spillSays(t) || 'none left';
    // The sign is still the sign. Say so, so a deal never reads as a
    // price change for the next car.
    if (deal) left += ' · this car only, sign ' + money(t.price_cents);
    opt.appendChild(make('span', 'ad-pick-left', left));

    wrap.appendChild(opt);
  });
}

// A spot tile. Not a <button>: the selected one carries a price you can
// type into, and an input inside a button cannot be focused on every
// phone. So it is a div that behaves like one.
export function pickTile(cls, disabled, onPick) {
  var opt = make('div', cls);
  opt.setAttribute('role', 'button');
  if (disabled) {
    opt.setAttribute('aria-disabled', 'true');
    return opt;
  }
  opt.tabIndex = 0;
  opt.addEventListener('click', onPick);
  opt.addEventListener('keydown', function (e) {
    if (e.target !== opt) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); }
  });
  return opt;
}

var PENCIL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 ' +
  '2 14l.6-3.6z" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linejoin="round"/></svg>';

// The price on the selected tile, with a pencil beside it. Tap either and
// the figure becomes a box to type the deal into; leave the box and it is
// a figure again. Typing never redraws the tile — that would take the
// cursor out of the box mid-number.
export function priceSlot(o) {
  var slot = make('span', 'ad-pick-priceslot');
  // Taps in here are about the price, not about picking the tile.
  slot.addEventListener('click', function (e) { e.stopPropagation(); });
  slot.addEventListener('keydown', function (e) { e.stopPropagation(); });

  if (o.editing) {
    slot.appendChild(make('span', 'ad-pick-dollar', '$'));
    var input = make('input', 'ad-pick-input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = '1';
    input.max = '500';
    input.step = 'any';
    input.value = String(o.cents / 100);
    input.setAttribute('aria-label', o.label);
    input.addEventListener('input', function () { o.input(typedPrice(input)); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    input.addEventListener('blur', function () { o.done(); });
    slot.appendChild(input);
    // After it is in the page, so focus and the selection both land.
    setTimeout(function () { input.focus(); input.select(); }, 0);
    return slot;
  }

  var figure = make('button', 'ad-pick-price ad-pick-price-edit', money(o.cents));
  figure.type = 'button';
  figure.setAttribute('aria-label', o.label + ' (now ' + money(o.cents) + ')');
  figure.addEventListener('click', o.start);
  slot.appendChild(figure);

  var pencil = make('button', 'ad-pick-pencil');
  pencil.type = 'button';
  pencil.innerHTML = PENCIL;
  pencil.setAttribute('aria-label', o.label);
  pencil.addEventListener('click', o.start);
  slot.appendChild(pencil);
  return slot;
}

function renderSellExtras() {
  var wrap = el('ad-sell-extras');
  wrap.innerHTML = '';
  if (!state.catalogue.length) {
    wrap.appendChild(make('p', 'ad-empty', 'Catalogue unavailable.'));
    return;
  }
  state.catalogue.forEach(function (item) {
    var qty = state.sellExtras[item.code] || 0;
    var row = make('div', 'ad-sell-extra' + (qty ? ' is-picked' : ''));
    row.appendChild(make('span', 'ad-sell-extra-name', item.name));

    var step = make('span', 'ad-step');
    var less = button('ad-count-btn', '−', function () { bumpExtra(item, -1); });
    less.disabled = qty === 0;
    step.appendChild(less);
    step.appendChild(make('span', 'ad-count', String(qty)));
    step.appendChild(button('ad-count-btn', '+', function () { bumpExtra(item, 1); }));
    row.appendChild(step);

    wrap.appendChild(row);
  });
}

function bumpExtra(item, by) {
  var max = item.max_qty || 10;
  var next = Math.min(Math.max((state.sellExtras[item.code] || 0) + by, 0), max);
  if (next === 0) delete state.sellExtras[item.code];
  else state.sellExtras[item.code] = next;
  renderSellExtras();
  renderSellCharge();
}

// Mirrors addon_price_cents() in the database, the same way the booking page
// does: enough to be honest on screen while the database does the sum that
// is recorded. "2 for $5" means unit price × quantity is the wrong answer.
function extraTotal(item, qty) {
  if (qty <= 0) return 0;
  if (!item.bundle_qty || !item.bundle_price_cents) return item.price_cents * qty;
  return Math.min(
    item.price_cents * qty,
    Math.floor(qty / item.bundle_qty) * item.bundle_price_cents +
      (qty % item.bundle_qty) * item.price_cents
  );
}

function sellExtrasTotal() {
  return state.catalogue.reduce(function (sum, item) {
    return sum + extraTotal(item, state.sellExtras[item.code] || 0);
  }, 0);
}

/* -------------------------------------------- what to actually charge */

// The one line the marshal reads out loud. Everything above it is how the
// sale is described; this is the number the driver hands over, and it moves
// the moment the payment method does.
export function renderSellCharge() {
  var box = el('ad-sell-charge');
  var tier = tiersHere().filter(function (t) { return t.code === state.sellTier; })[0];
  if (!tier) {
    hide(box);
    return;
  }

  var method = el('ad-sell-payment').value;
  var later = method === 'unpaid';
  el('ad-sell-later-hint').hidden = !later;
  text(el('ad-sell-charge-total-label'), later ? 'They will owe' : 'Charge them');
  text(el('ad-sell-submit'), later ? 'Save — they pay later'
    : method === 'card_qr' ? 'Save and show the QR' : 'Take the money');
  var extras = sellExtrasTotal();
  // The sign price unless a deal was typed on the tile. A half-typed
  // number falls back to the sign here, as it does when the box is left.
  var spot = state.sellPrice > 0 ? state.sellPrice : tier.price_cents;
  var subtotal = spot + extras;
  var surcharge = surchargeOn(subtotal, method);

  text(el('ad-sell-charge-spot-name'), shortName(tier) +
    (spot !== tier.price_cents ? ' (sign ' + money(tier.price_cents) + ')' : ''));
  text(el('ad-sell-charge-spot'), money(spot));

  var extraRow = el('ad-sell-charge-extras-row');
  if (extras > 0) {
    text(el('ad-sell-charge-extras'), money(extras));
    show(extraRow);
  } else {
    hide(extraRow);
  }

  var surRow = el('ad-sell-charge-surcharge-row');
  if (surcharge > 0) {
    text(el('ad-sell-charge-surcharge'), money(surcharge));
    show(surRow);
  } else {
    hide(surRow);
  }

  text(el('ad-sell-charge-total'), money(subtotal + surcharge));
  show(box);
}

// A price typed for one car, in cents. null when the box is empty;
// false when what is in it is not a price the database will take.
function typedPrice(input) {
  var raw = String(input.value || '').trim();
  if (!raw) return null;
  var dollars = Number(raw);
  if (!isFinite(dollars) || dollars < 1 || dollars > 500) return false;
  return Math.round(dollars * 100);
}

export function submitSell(e) {
  e.preventDefault();
  var form = el('ad-sell-form');
  var tier = tiersHere().filter(function (t) { return t.code === state.sellTier; })[0];
  if (!tier) {
    var pick = el('ad-sell-error');
    text(pick, 'Pick a spot first.');
    show(pick);
    return;
  }
  if (!form.rego.value.trim()) {
    var noPlate = el('ad-sell-error');
    text(noPlate, 'Number plate first — it is how we find them later.');
    show(noPlate);
    form.rego.focus();
    return;
  }
  var price = state.sellPrice;
  if (price === false) {
    var bad = el('ad-sell-error');
    text(bad, 'Tap the price on the spot — between $1 and $500.');
    show(bad);
    return;
  }
  // Typing the sign price is the sign price — no need to record a deal.
  if (!price || price === tier.price_cents) price = null;

  var btn = el('ad-sell-submit');
  btn.disabled = true;
  el('ad-sell-error').hidden = true;

  var addons = Object.keys(state.sellExtras).map(function (code) {
    return { code: code, qty: state.sellExtras[code] };
  });

  // Card by QR is sold as owing, then paid on the driver's phone. Until
  // Stripe says so, owing is the truth, and it is what is left behind if
  // they give up.
  var byQr = form.payment.value === 'card_qr';

  call('sell', {
    event_id: state.eventId,
    property_id: tier.property_id,
    tier_code: tier.code,
    payment_method: byQr ? 'unpaid' : form.payment.value,
    vehicle_rego: form.rego.value.trim() || null,
    name: form.sellname.value.trim() || null,
    phone: form.sellphone.value.trim() || null,
    vehicle_low_clearance: form.selllow.checked,
    addons: addons,
    price_cents: price,
  })
    .then(function (data) {
      hide(el('ad-sell'));
      var plate = form.rego.value.trim().toUpperCase();
      var later = form.payment.value === 'unpaid';
      clearSell();
      if (byQr) {
        if (data.addons_failed) toast('Saved, but the extras did not save — add them by hand', 'bad');
        openCardQr(data.booking_id, plate);
        return loadList(true);
      }
      if (data.addons_failed) {
        toast('Space sold, but the extras did not save — take that cash', 'bad');
      } else if (sayPlaced(plate || 'Sold', data.placed, tier.property_id)) {
        // Said where it went: another site, or a Priority space.
      } else {
        // The charged figure comes back from the database rather than being
        // repeated from the screen, so a rate that changed mid-night shows
        // up here rather than being quietly wrong.
        var charged = data.charge_cents != null ? ' · ' + money(data.charge_cents) : '';
        toast((later ? 'Saved, to pay later' : 'Sold') + (plate ? ' — ' + plate : '') +
          charged, 'good');
      }
      return loadList(true);
    })
    .catch(function (err) {
      var box = el('ad-sell-error');
      box.textContent = err.message;
      show(box);
      // Andrew moved the gate to another night while this form was open.
      // Nothing was sold; bring the list round to the live night.
      if (err.code === 'NOT_LIVE_EVENT' || err.code === 'NO_LIVE_EVENT') loadList(true);
    })
    .finally(function () { btn.disabled = false; });
}
