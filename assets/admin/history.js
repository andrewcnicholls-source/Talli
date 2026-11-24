/* Talli Parking — gate screen: history.js

   One booking's history, at the bottom of its edit sheet: who made it,
   when, and everything that has happened to it since
   (20261130100000_talli_booking_history).

   The database writes a line per thing that happened. Lines written in
   one moment — a gate sale is made, paid and checked in at once — are
   shown as one entry, because to the person reading it that was one
   thing somebody did.
 */

import { asDate, asTime, make, METHOD_NAMES, money } from './core.js';

var DETAIL_NAMES = {
  rego: 'rego', name: 'name', phone: 'phone', email: 'email',
  low_clearance: 'low clearance', notes: 'notes',
};

var ENDINGS = {
  cancelled: 'Cancelled', expired: 'Hold ran out', refunded: 'Refunded',
  no_show: 'No-show', checked_in: 'Checked in', paid: 'Paid',
};

function method(m) {
  return METHOD_NAMES[m] || (m ? String(m).replace(/_/g, ' ') : null);
}

function changedDetails(before, after) {
  var names = [];
  Object.keys(DETAIL_NAMES).forEach(function (k) {
    if ((before || {})[k] !== (after || {})[k]) names.push(DETAIL_NAMES[k]);
  });
  return names.length ? 'Changed ' + names.join(', ') : 'Details saved';
}

// What one line says on its own, or null when another line in the same
// moment already says it.
function say(l, kinds, siteName) {
  var b = l.before || {};
  var a = l.after || {};
  switch (l.kind) {
    case 'created': {
      var parts = [a.channel === 'online' ? 'Booked online' : 'Added at the gate'];
      if (method(a.payment_method)) parts.push(method(a.payment_method));
      if (kinds.checked_in) parts.push('checked in');
      return parts.join(' · ');
    }
    case 'payment':
      // Before history said who, cancelling an unpaid walk-up was written
      // as a payment line with a status and no method.
      if (!a.payment_method && a.status === 'cancelled') return 'Cancelled';
      return 'Payment: ' + method(b.payment_method) + ' → ' + method(a.payment_method);
    case 'paid':
      if (kinds.created || kinds.payment) return null;
      return method(a.payment_method) ? 'Paid · ' + method(a.payment_method) : 'Paid';
    case 'checked_in':
      return kinds.created ? null : 'Checked in';
    case 'moved':
      // A gate sale placed as it is made is not a move anyone made.
      if (kinds.created) return null;
      var where = siteName && a.property_id && siteName(a.property_id);
      return where ? 'Moved to ' + where : 'Moved';
    case 'details':
      return changedDetails(b, a);
    case 'tier':
      return 'Type: ' + (b.tier_code || '?') + ' → ' + (a.tier_code || '?');
    case 'price':
      return 'Price: ' + money(b.amount_cents) + ' → ' + money(a.amount_cents);
    default:
      return ENDINGS[l.kind] || l.kind;
  }
}

// lines: what gate-ops' booking_history gives, oldest first.
// siteName: optional, a property id to the name the screen shows for it.
export function historyEntries(lines, siteName) {
  var groups = [];
  (lines || []).slice().sort(function (x, y) {
    return new Date(x.at) - new Date(y.at);
  }).forEach(function (l) {
    var g = groups[groups.length - 1];
    if (!g || g.at !== l.at) { g = { at: l.at, lines: [] }; groups.push(g); }
    g.lines.push(l);
  });

  return groups.map(function (g) {
    var kinds = {};
    g.lines.forEach(function (l) { kinds[l.kind] = true; });
    var said = g.lines.map(function (l) { return say(l, kinds, siteName); })
      .filter(Boolean);
    var first = g.lines[0];
    return {
      at: g.at,
      when: [asDate(g.at), asTime(g.at)].filter(Boolean).join(' · '),
      who: first.by_name || first.by_label || 'Not recorded',
      text: said.join(' · '),
    };
  });
}

// The list itself. Newest last, so it reads as the story of the booking.
export function renderHistory(container, lines, siteName) {
  if (!container) return;
  container.textContent = '';
  var entries = historyEntries(lines, siteName);
  if (!entries.length) return;
  container.appendChild(make('h3', 'ad-history-title', 'History'));
  var list = make('ol', 'ad-history');
  entries.forEach(function (e) {
    var li = make('li', 'ad-history-line');
    li.appendChild(make('span', 'ad-history-what', e.text));
    li.appendChild(make('span', 'ad-history-who', e.who + ' · ' + e.when));
    list.appendChild(li);
  });
  container.appendChild(list);
}
