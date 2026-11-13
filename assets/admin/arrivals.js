/* Talli Parking — gate screen: arrivals.js

   The Arrivals tab: the list of cars, searched and ticked off.
 */

import { asTime, button, call, el, make, money, state, toast } from './core.js';
import { byTier, chosenHere, loadList, multiSite, siteName,
  tierClass, view } from './night.js';
import { openEdit } from './booking-edit.js';
import { isOperator } from './session.js';
import { inOtherSpace, sayPlaced, spaceName } from './placement.js';

/* --------------------------------------------------------- the list */

function matches(row) {
  if (!state.filter) return true;
  var f = state.filter.toLowerCase();
  // The plate as typed with or without a space, the booking reference from
  // the confirmation email, a name or a phone number.
  var plate = String(row.vehicle_rego || '').replace(/\s+/g, '').toLowerCase();
  if (plate && plate.indexOf(f.replace(/\s+/g, '')) > -1) return true;
  return [row.reference, row.customer_name, row.customer_phone]
    .some(function (v) { return v && String(v).toLowerCase().indexOf(f) > -1; });
}

export function renderList() {
  var list = el('ad-list');
  list.innerHTML = '';

  // The cars in the selector's scope (plan B6), then the search box.
  var all = view().rows;
  var rows = all.filter(matches);

  // Arrivals works the live night and only that one (plan B2). With none
  // live there is nothing to work, nothing to sell, and nothing to pick.
  el('ad-sell-open').hidden = !state.liveId;
  el('ad-lost-open').hidden = !state.liveId;
  if (!state.liveId) {
    list.appendChild(make('p', 'ad-empty', isOperator()
      ? 'No event is live at the gate. Open the night on Tonight and mark it live.'
      : 'No event is live at the gate yet. Andrew starts the night; this screen follows on its own.'));
    return;
  }

  if (!rows.length) {
    list.appendChild(make('p', 'ad-empty',
      all.length ? 'Nothing matches that.'
        : state.rows.length ? 'No bookings at these sites yet.'
        : 'No bookings for this event yet.'));
    return;
  }

  // One section per tier. The heading repeats the chip's count on purpose:
  // by the time you have scrolled to the Standard block the chips are off
  // the top of the screen, and "2/7 in" is the thing you came down here to
  // check.
  byTier(rows).forEach(function (g) {
    list.appendChild(groupHead(g));
    g.rows.forEach(function (r) { list.appendChild(rowCard(r)); });
  });
}

function groupHead(g) {
  var head = make('div', 'ad-group' + tierClass(g.code));
  head.appendChild(make('span', 'ad-group-name', g.code.replace(/_/g, ' ')));
  head.appendChild(make('span', 'ad-group-count',
    g.arrived + '/' + g.rows.length + ' in'));
  return head;
}

function rowCard(r) {
  var addons = r.addons || [];
  var owing = (r.addons_pending || 0) > 0;

  var card = make('div', 'ad-row' + (r.arrived ? ' is-arrived' : '') +
    (r.owes ? ' is-owing' : r.status === 'held' ? ' is-held' : '') +
    (owing ? ' has-extras' : ''));

  // The left side of the row opens the booking. The buttons on the right
  // stay what they were, so ticking a car in is still one tap.
  var main = make('div', 'ad-row-main');
  main.setAttribute('role', 'button');
  main.tabIndex = 0;
  main.setAttribute('aria-label', 'Edit ' + (r.vehicle_rego || 'booking'));
  main.addEventListener('click', function () { openEdit(r); });
  main.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(r); }
  });

  var top = make('div', 'ad-row-top');
  top.appendChild(make('span', 'ad-rego', r.vehicle_rego || '— no plate —'));
  main.appendChild(top);

  var who = [r.customer_name, r.customer_phone].filter(Boolean).join(' · ');
  if (who) main.appendChild(make('div', 'ad-who', who));

  var meta = make('div', 'ad-meta');
  if (r.tier_code) {
    meta.appendChild(make('span', 'ad-chip' + tierClass(r.tier_code),
      r.tier_code.replace(/_/g, ' ')));
  }
  if (r.arrival_from && r.arrival_until) {
    meta.appendChild(make('span', 'ad-chip', asTime(r.arrival_from) + '–' + asTime(r.arrival_until)));
  }
  // Which driveway — where they are if they are in, where they were booked
  // if not. Only worth saying when there is more than one.
  if (multiSite() && r.property_id) {
    var at = siteName(r.property_id);
    var moved = r.booked_property_id && r.booked_property_id !== r.property_id;
    meta.appendChild(make('span', 'ad-chip is-site',
      (r.arrived ? '@ ' : '→ ') + at + (moved ? ' (booked ' + siteName(r.booked_property_id) + ')' : '')));
  }
  // A Standard car in a Priority space (plan B5): the warden who parks the
  // next Priority car needs to know that space is gone.
  if (inOtherSpace(r)) {
    meta.appendChild(make('span', 'ad-chip' + tierClass(r.space_code),
      'in a ' + spaceName(r.space_code) + ' space'));
  }
  if (r.owes) {
    meta.appendChild(make('span', 'ad-chip is-warn', 'owes ' + rowTotal(r)));
  } else if (r.payment_method && r.payment_method !== 'stripe') {
    meta.appendChild(make('span', 'ad-chip is-cash',
      r.payment_method.replace(/_/g, ' ') + ' ' +
      rowTotal(r)));
  }
  // Read before the car is waved past the crossing, not after it has
  // grounded on it. Loud on purpose — it is a decision, not a detail.
  if (r.vehicle_low_clearance) {
    meta.appendChild(make('span', 'ad-chip is-low', 'low car'));
  }
  if (r.status === 'held' && !r.owes) {
    meta.appendChild(make('span', 'ad-chip is-warn', 'unpaid hold'));
  }
  if (meta.childNodes.length) main.appendChild(meta);

  // Paid for a fortnight ago and easy to forget. Loud enough to catch the
  // eye while the car is still in front of you.
  if (addons.length) {
    var bag = make('div', 'ad-bag' + (owing ? '' : ' is-done'));
    addons.forEach(function (line) {
      bag.appendChild(make('span', 'ad-bag-item' + (line.handed ? ' is-done' : ''),
        (line.qty > 1 ? line.qty + '× ' : '') + line.name));
    });
    main.appendChild(bag);
  }

  card.appendChild(main);

  var actions = make('div', 'ad-row-actions');

  var tick = make('button', 'ad-tick' + (r.arrived ? ' is-on' : ''),
    r.arrived ? 'Here' : 'Tick in');
  tick.type = 'button';
  tick.disabled = !!state.busy[r.booking_id];
  tick.addEventListener('click', function () { toggleArrived(r, tick); });
  actions.appendChild(tick);

  if (r.owes) {
    actions.appendChild(button('ad-pay', 'Pay', function () { openEdit(r); }));
  }

  if (addons.length) {
    actions.appendChild(button('ad-hand' + (owing ? '' : ' is-on'),
      owing ? 'Hand over' : 'Handed',
      function () { toggleHandedOver(r); }));
  }

  card.appendChild(actions);

  return card;
}

function rowTotal(r) {
  return money((r.amount_cents || 0) + (r.addons_cents || 0) + (r.surcharge_cents || 0));
}

function toggleArrived(r, btn) {
  var action = r.arrived ? 'undo_check_in' : 'check_in';
  state.busy[r.booking_id] = true;
  btn.disabled = true;

  var params = { booking_id: r.booking_id };
  // One tap puts the car at the site chosen at the top. With a block or
  // all chosen there is no one site this phone is at, so the car is
  // placed from its own site, and the database proposes from there.
  var here = chosenHere();
  if (!r.arrived && multiSite()) {
    var at = here ? here.property_id : r.property_id;
    if (at) params.property_id = at;
  }

  call(action, params)
    .then(function (data) {
      r.arrived = !r.arrived;
      var who = r.vehicle_rego || 'Booking';
      if (r.arrived && params.property_id) {
        // The database placed it (plan B5). Said loudly when the car has
        // to go to another site, or into another type of space.
        var placed = data && data.placed;
        if (!sayPlaced(who, placed, params.property_id)) {
          toast(who + ' in at ' + siteName(placed ? placed.property_id : params.property_id), 'good');
        }
        return loadList(true);
      }
      toast(who + (r.arrived ? ' ticked in' : ' un-ticked'), 'good');
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () {
      delete state.busy[r.booking_id];
      btn.disabled = false;
    });
}

function toggleHandedOver(r) {
  var handed = (r.addons_pending || 0) > 0;
  call('hand_over', { booking_id: r.booking_id, handed: handed })
    .then(function () {
      toast(handed ? 'Extras handed over' : 'Marked as not handed over', 'good');
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); });
}
