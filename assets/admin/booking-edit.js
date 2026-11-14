/* Talli Parking — gate screen: booking-edit.js

   One booking's edit sheet.
 */

import { call, el, hide, make, money, shortName, show, state, surchargeOn,
  text, toast } from './core.js';
import { loadList, tierClass, tiersFor } from './night.js';
import { inGateOrder } from './tonight.js';
import { pickTile, priceSlot } from './walk-up.js';
import { renderPlace } from './placement.js';

/* ----------------------------------------------------- one booking */

var METHOD_NAMES = {
  stripe: 'Card online', tap_to_pay: 'Card (tap to pay)', cash: 'Cash',
  bank_transfer: 'Bank transfer', free: 'Free / comp', other: 'Other',
  unpaid: 'Not paid yet',
};

// Everything that can be wrong about a booking once it exists: the plate,
// how to reach them, how they paid, and which type of space they actually
// took. Opened by tapping the row.
export function openEdit(r) {
  state.edit = r;
  state.editTier = r.tier_code;
  var form = el('ad-edit-form');
  form.reset();
  el('ad-edit-error').hidden = true;

  text(el('ad-edit-title'), r.vehicle_rego || 'Booking');
  var sub = [r.channel === 'gate' ? 'Sold at the gate' : 'Booked online'];
  if (r.arrived) sub.push('ticked in');
  if (r.in_checkout) sub.push('still paying online');
  text(el('ad-edit-sub'), sub.join(' · '));
  renderWhere(r);

  form.rego.value = r.vehicle_rego || '';
  form.editname.value = r.customer_name || '';
  form.editphone.value = r.customer_phone || '';
  form.editemail.value = r.customer_email || '';
  form.editlow.checked = !!r.vehicle_low_clearance;
  form.editnotes.value = r.notes || '';

  // A card payment on the website is Stripe's record, not ours to relabel;
  // an online checkout still running is about to be settled by Stripe. In
  // both cases the method is shown and left alone.
  var pay = el('ad-edit-payment');
  var online = r.payment_method === 'stripe';
  // Card, cash, bank transfer, or not yet — nothing else is taken now. A
  // booking recorded some other way before that (free, other) is shown as
  // it was, greyed out, rather than silently reading as the first option.
  // For a warden that includes tap to pay, which is not in their list.
  [].slice.call(pay.querySelectorAll('option.is-legacy')).forEach(function (o) {
    o.remove();
  });
  var method = r.payment_method || 'cash';
  if (![].some.call(pay.options, function (o) { return o.value === method; })) {
    var legacy = new Option(METHOD_NAMES[method] || method.replace(/_/g, ' '), method);
    legacy.disabled = true;
    legacy.className = 'is-legacy';
    pay.add(legacy);
  }
  pay.value = method;
  pay.disabled = online || !!r.in_checkout;
  var payHint = el('ad-edit-payment-hint');
  if (online || r.in_checkout) {
    text(payHint, r.in_checkout
      ? 'They are still paying on the website. This fills in when they finish.'
      : r.channel === 'gate'
        ? 'Paid by card by QR — Stripe holds that record.'
        : 'Paid by card on the website — Stripe holds that record.');
    show(payHint);
  } else {
    hide(payHint);
  }

  el('ad-edit-cancel').hidden = !r.owes;
  // A walk-up who owes can still pay by card, on their own phone. Not one
  // mid-checkout on the website: that is already a Stripe payment.
  el('ad-edit-qr').hidden = !(r.owes && r.channel === 'gate');

  // What they paid for the space, editable on the selected tile. Not for a
  // website sale: that price is whatever Stripe charged, and Stripe is the
  // record of it.
  state.editPrice = null;
  state.editPriceEditing = false;
  state.editPriceLocked = online || !!r.in_checkout;

  renderEditTiers();
  renderEditCharge();
  renderPlace(r);
  show(el('ad-edit'));
}

// At the top of the sheet: the site this car is booked into, and its
// area — and, when it has been placed somewhere else, where it is now.
// Moving it is Parked at, further down.
function renderWhere(r) {
  var box = el('ad-edit-where');
  var bookedId = r.booked_property_id || r.property_id;
  var booked = siteRow(bookedId);
  if (!booked) { box.hidden = true; return; }
  box.innerHTML = '';
  box.appendChild(document.createTextNode('Booked into '));
  box.appendChild(make('strong', null, booked.name || 'a site'));
  if (booked.block_name) box.appendChild(document.createTextNode(' · ' + booked.block_name));
  if (r.property_id && r.property_id !== bookedId) {
    var now = siteRow(r.property_id);
    box.appendChild(document.createTextNode(' — ' + (r.arrived ? 'parked at ' : 'going to ')));
    box.appendChild(make('strong', null, (now && now.name) || 'another site'));
  }
  box.hidden = false;
}

function siteRow(id) {
  return (state.sites || []).filter(function (s) { return s.property_id === id; })[0] || null;
}

function renderEditTiers() {
  var r = state.edit;
  var wrap = el('ad-edit-tiers');
  wrap.innerHTML = '';
  var tiers = inGateOrder(tiersFor(r));

  tiers.forEach(function (t) {
    var current = t.code === r.tier_code;
    // Its own space is counted in its own tier, so the tier it is in is
    // never "full" as far as this booking is concerned.
    var full = !current && (t.manually_sold_out || t.spots_left_gate <= 0);
    var on = state.editTier === t.code;
    var opt = pickTile('ad-pick-opt' + tierClass(t.code) +
      (on ? ' is-on' : '') + (current ? ' is-current' : '') + (full ? ' is-gone' : ''),
      full || !!r.in_checkout, function () {
        if (state.editTier === t.code) return;
        state.editTier = t.code;
        // What the space is worth starts again from what the move means:
        // kept if paid, the new type's price if not.
        state.editPrice = null;
        state.editPriceEditing = false;
        renderEditTiers();
        renderEditCharge();
      });

    var line = make('span', 'ad-pick-line');
    line.appendChild(make('span', 'ad-pick-name', shortName(t)));
    var a = on ? editAmounts() : null;
    if (on && !state.editPriceLocked) {
      line.appendChild(priceSlot({
        cents: a.space,
        editing: state.editPriceEditing,
        label: 'Change what this car pays for the space',
        start: function () { state.editPriceEditing = true; renderEditTiers(); },
        input: function (cents) { state.editPrice = cents; renderEditCharge(); },
        done: function () {
          if (!(state.editPrice > 0)) state.editPrice = null;
          state.editPriceEditing = false;
          renderEditTiers();
          renderEditCharge();
        },
      }));
    } else {
      line.appendChild(make('span', 'ad-pick-price', money(on ? a.space : t.price_cents)));
    }
    opt.appendChild(line);

    var left = current ? 'booked as this'
      : full ? 'full — add a space on Tonight first'
      : t.spots_left_gate + ' left';
    if (on && a.space !== t.price_cents) left += ' · this car only, sign ' + money(t.price_cents);
    opt.appendChild(make('span', 'ad-pick-left', left));

    wrap.appendChild(opt);
  });
}

// What the booking will be worth once saved, worked out the way the
// database will: a paid booking that moves keeps what it paid; an unpaid
// one takes the new space's price. The database still records the figure.
function editAmounts() {
  var r = state.edit;
  var method = el('ad-edit-payment').value;
  var moved = state.editTier !== r.tier_code;
  var tier = tiersFor(r).filter(function (t) { return t.code === state.editTier; })[0];
  var paid = r.status === 'paid';
  // What the database will land on by itself, before any deal typed here.
  var natural = moved && !paid && tier ? tier.price_cents : (r.amount_cents || 0);
  var typed = state.editPriceLocked ? null : state.editPrice;
  var space = typed > 0 ? typed : natural;
  var repriced = typed > 0 && typed !== natural;
  var sub = space + (r.addons_cents || 0);
  var surcharge = method === r.payment_method && !moved && !repriced
    ? (r.surcharge_cents || 0)
    : surchargeOn(sub, method);
  return { method: method, moved: moved, tier: tier, paid: paid, total: sub + surcharge,
    typed: typed, natural: natural, repriced: repriced, space: space };
}

export function renderEditCharge() {
  var r = state.edit;
  if (!r) return;
  var a = editAmounts();

  var hint = el('ad-edit-move-hint');
  if (a.moved && a.tier) {
    text(hint, a.paid
      ? 'Moves them to ' + shortName(a.tier) + ' and frees their ' +
        r.tier_code.replace(/_/g, ' ') + ' space. What they paid stays as it was — ' +
        'no refund, nothing extra to charge.'
      : 'Moves them to ' + shortName(a.tier) + '. Not paid yet, so they owe the ' +
        shortName(a.tier) + ' price.');
    show(hint);
  } else {
    hide(hint);
  }

  var nowPaying = r.owes && a.method !== 'unpaid';
  var label = a.method === 'unpaid' ? 'They owe'
    : nowPaying ? 'Charge them'
    : 'Paid';
  text(el('ad-edit-charge-label'), label);
  text(el('ad-edit-charge-total'), money(a.total));

  text(el('ad-edit-submit'), nowPaying
    ? 'Paid by ' + METHOD_NAMES[a.method].toLowerCase() + ' — ' + money(a.total)
    : 'Save');
}

export function submitEdit(e) {
  e.preventDefault();
  var r = state.edit;
  if (!r) return;
  var form = el('ad-edit-form');
  var btn = el('ad-edit-submit');
  var box = el('ad-edit-error');
  box.hidden = true;

  var params = {
    booking_id: r.booking_id,
    vehicle_rego: form.rego.value.trim(),
    name: form.editname.value.trim(),
    phone: form.editphone.value.trim(),
    // Blank leaves the address it has: a booking must keep one.
    email: form.editemail.value.trim(),
    vehicle_low_clearance: form.editlow.checked,
    notes: form.editnotes.value.trim(),
  };
  var pay = el('ad-edit-payment');
  if (!pay.disabled && pay.value !== r.payment_method) params.payment_method = pay.value;
  if (state.editTier && state.editTier !== r.tier_code) params.tier_code = state.editTier;

  var a = editAmounts();
  if (a.typed === false) {
    text(box, 'A price between $1 and $500 for the space.');
    show(box);
    return;
  }
  if (a.repriced) params.price_cents = a.typed;

  btn.disabled = true;
  call('edit_booking', params)
    .then(function (data) {
      hide(el('ad-edit'));
      var b = data.booking || {};
      var who = form.rego.value.trim().toUpperCase() || 'Booking';
      var said = [];
      if (params.tier_code) said.push('moved to ' + params.tier_code.replace(/_/g, ' '));
      if (params.price_cents) said.push('space now ' + money(params.price_cents));
      if (params.payment_method) {
        said.push(params.payment_method === 'unpaid' ? 'marked not paid'
          : 'paid ' + money(b.total_cents));
      }
      toast(who + ' — ' + (said.length ? said.join(', ') : 'saved'), 'good');
      state.edit = null;
      return loadList(true);
    })
    .catch(function (err) {
      text(box, err.message);
      show(box);
    })
    .finally(function () { btn.disabled = false; });
}

export function cancelUnpaid() {
  var r = state.edit;
  if (!r || !r.owes) return;
  if (!window.confirm('Cancel ' + (r.vehicle_rego || 'this booking') +
      '? The space goes back on sale.')) return;
  call('cancel_unpaid', { booking_id: r.booking_id })
    .then(function () {
      hide(el('ad-edit'));
      state.edit = null;
      toast((r.vehicle_rego || 'Booking') + ' cancelled', 'good');
      return loadList(true);
    })
    .catch(function (err) {
      var box = el('ad-edit-error');
      text(box, err.message);
      show(box);
    });
}
