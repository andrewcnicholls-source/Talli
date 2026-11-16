/* Talli Parking — gate screen: placement.js

   Where a car goes, and spaces lost on the night (plan B5).

   Where a car goes is decided when it arrives, by the database: a
   Standard car takes a Standard space at the warden's site, then at
   another site in the block, then a Priority space here, then at another
   site. Never Valet. This module says where it went, lets the operator
   move it to any site, and records a space nobody can use tonight.
 */

import { asTime, button, call, el, hide, make, show, state, text,
  toast } from './core.js';
import { chosenHere, loadList, multiSite, siteName, tierClass,
  view } from './night.js';
import { pickTile } from './walk-up.js';
import { isOperator } from './session.js';

var SPACE_NAMES = { standard: 'Standard', priority: 'Priority', valet: 'Valet' };

export function spaceName(code) {
  return SPACE_NAMES[code] || String(code || '').replace(/_/g, ' ');
}

// A car in a space of another type: a Standard car in a Priority space.
export function inOtherSpace(r) {
  return !!(r && r.space_code && r.space_code !== r.tier_code);
}

/* ----------------------------------------------- what the warden is told */

// After a tick-in or a sale. `here` is the site the phone is at. Loud when
// the car has to be sent somewhere else, or there was nowhere to put it.
export function sayPlaced(who, placed, here) {
  if (!placed) return false;
  if (placed.no_room) {
    toast(who + ' in — no free space here or in the block. Counted at ' +
      siteName(placed.property_id) + '. Call Andrew.', 'bad');
    return true;
  }
  var elsewhere = here && placed.property_id !== here;
  var other = placed.space_code && placed.space_code !== placed.tier_code;
  if (!elsewhere && !other) return false;
  var space = spaceName(placed.space_code) + ' space';
  toast(elsewhere
    ? who + ': send to ' + siteName(placed.property_id) + ' — ' + space
    : who + ' in — ' + space + ' here', elsewhere ? 'bad' : 'good');
  return true;
}

// What a full Standard tile says on the walk-up form, from `spill` on the
// tier (gate-ops night.ts). Null when the sale stays where it is.
export function spillSays(t) {
  var s = t && t.spill;
  if (!s) return null;
  var at = s.property_id === t.property_id ? 'here' : 'at ' + siteName(s.property_id);
  return 'full — takes a ' + spaceName(s.space_code) + ' space ' + at;
}

/* ------------------------------------------- moving a car, on its sheet */

// The sites this car may be sent to, in the type of space it is in now:
// the operator's choice of site only. The type is changed at the top of
// the screen, not here. The operator may send it to any site in the event;
// the database still refuses a space that is not free. Free is the count
// less cars and lost spaces; the site it is at is always offered.
function placeOptions(r) {
  var type = r.space_code || r.tier_code;
  var out = [];
  state.sites.forEach(function (s) {
    var t = state.tiers.filter(function (x) {
      return x.property_id === s.property_id && x.code === type;
    })[0];
    if (!t) return;
    var current = s.property_id === r.property_id;
    var free = (t.capacity || 0) - (t.sold || 0) - (t.lost || 0);
    out.push({ property_id: s.property_id, code: type, current: current,
      free: free, label: s.name + ' — ' + spaceName(type) +
        (current ? ' (now)' : free > 0 ? ' · ' + free + ' free' : ' · full') });
  });
  return out;
}

/* ------------------------------------------- in, or not, on either screen */

// Tick a car in, or take the tick back when the wrong one was tapped. The
// list's button and the sheet's both come here. One tap puts the car at
// the site chosen at the top; with a block or all chosen there is no one
// site this phone is at, so it is placed from where it is going, and the
// database proposes from there.
export function toggleCheckIn(r) {
  var action = r.arrived ? 'undo_check_in' : 'check_in';
  var params = { booking_id: r.booking_id };
  var here = chosenHere();
  if (!r.arrived && multiSite()) {
    var at = here ? here.property_id : r.property_id;
    if (at) params.property_id = at;
  }
  var who = r.vehicle_rego || 'Booking';
  state.busy[r.booking_id] = true;
  return call(action, params).then(function (data) {
    // Done before the list redraws: a button drawn while this car is busy
    // comes out disabled, and Here could not then take the tick back.
    delete state.busy[r.booking_id];
    r.arrived = !r.arrived;
    if (r.arrived && params.property_id) {
      // The database placed it (plan B5). Said loudly when the car has
      // to go to another site, or into another type of space.
      var placed = data && data.placed;
      if (!sayPlaced(who, placed, params.property_id)) {
        toast(who + ' checked in at ' + siteName(placed ? placed.property_id : params.property_id), 'good');
      }
    } else {
      toast(who + (r.arrived ? ' checked in' : ' checked out — not here yet'), 'good');
    }
    return loadList(true);
  }, function (err) {
    delete state.busy[r.booking_id];
    throw err;
  });
}

// The top of the sheet: whether the car is in, and the one button that
// changes it either way.
export function renderCheckIn(r) {
  text(el('ad-edit-status-text'), r.arrived ? 'Checked in' : 'Not checked in');
  el('ad-edit-status').classList.toggle('is-on', !!r.arrived);
  var btn = el('ad-edit-toggle');
  text(btn, r.arrived ? 'Undo check-in' : 'Check in');
  btn.classList.toggle('is-on', !!r.arrived);
  btn.disabled = !!state.busy[r.booking_id];
}

export function submitToggle() {
  var r = state.edit;
  if (!r || state.busy[r.booking_id]) return;
  el('ad-edit-toggle').disabled = true;
  toggleCheckIn(r)
    .then(function () {
      if (state.edit !== r) return;
      // The list has reloaded: where the car went is on the fresh row.
      var fresh = (state.rows || []).filter(function (x) {
        return x.booking_id === r.booking_id;
      })[0];
      if (fresh) Object.assign(r, fresh);
      renderCheckIn(r);
      renderPlace(r);
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () { if (state.edit === r) renderCheckIn(r); });
}

// Once the car is in, the list is where it is parked, and the button
// moves it. Before then it is where the car is being sent: a transfer,
// which leaves it not arrived until it turns up.
export function renderPlace(r) {
  var row = el('ad-edit-place-row');
  var select = el('ad-edit-place');
  // Moving a car between sites is the operator's alone. Everyone else
  // does not see the field at all.
  var opts = isOperator() ? placeOptions(r) : [];
  if (opts.length < 2) { hide(row); return; }
  text(el('ad-edit-place-what'), r.arrived ? 'Parked at' : 'Transfer to');
  text(el('ad-edit-place-where'), r.arrived ? 'move it if it is somewhere else' : 'any site');
  text(el('ad-edit-place-go'), r.arrived ? 'Move' : 'Transfer');
  select.innerHTML = '';
  opts.forEach(function (o) {
    var opt = new Option(o.label, o.property_id + '|' + o.code);
    opt.disabled = !o.current && o.free <= 0;
    opt.selected = o.current;
    select.appendChild(opt);
  });
  show(row);
}

export function submitPlace() {
  var r = state.edit;
  var pick = String(el('ad-edit-place').value || '').split('|');
  if (!r || pick.length !== 2) return;
  // Already there: nothing to move.
  if (pick[0] === r.property_id && pick[1] === (r.space_code || r.tier_code)) return;
  var btn = el('ad-edit-place-go');
  var who = r.vehicle_rego || 'Booking';
  var arrived = !!r.arrived;
  btn.disabled = true;
  call('place', { booking_id: r.booking_id, property_id: pick[0], space_code: pick[1],
    check_in: arrived })
    .then(function () {
      toast(who + (arrived ? ' moved to ' : ' transferred to ') + siteName(pick[0]) +
        ' — ' + spaceName(pick[1]) + ' space', 'good');
      hide(el('ad-edit'));
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () { btn.disabled = false; });
}

/* --------------------------------------------------------- lost spaces */

var REASONS = [
  ['bad_parking', 'Bad parking'],
  ['blocked', 'Blocked'],
  ['host_car', 'Host’s own car'],
  ['other', 'Other'],
];

function reasonName(code) {
  var r = REASONS.filter(function (x) { return x[0] === code; })[0];
  return r ? r[1] : code;
}

export function openLost() {
  // The sites chosen at the top (plan B6), starting at the one this phone
  // is taken to be at.
  var sites = view().sites;
  var ids = sites.map(function (s) { return s.property_id; });
  state.lostSite = ids.indexOf(state.siteId) > -1 ? state.siteId
    : (sites[0] || {}).property_id || null;
  state.lostTier = null;
  state.lostReason = null;
  el('ad-lost-form').reset();
  hide(el('ad-lost-error'));
  renderLost();
  show(el('ad-lost'));
}

export function renderLost() {
  var row = el('ad-lost-site-row');
  var select = el('ad-lost-site');
  var sites = view().sites;
  row.hidden = sites.length < 2;
  select.innerHTML = '';
  sites.forEach(function (s) {
    var opt = new Option(s.name, s.property_id);
    opt.selected = s.property_id === state.lostSite;
    select.appendChild(opt);
  });

  var tiers = state.tiers.filter(function (t) {
    return !multiSite() || t.property_id === state.lostSite;
  });
  if (!tiers.some(function (t) { return t.code === state.lostTier; })) {
    state.lostTier = tiers[0] ? tiers[0].code : null;
  }
  var tw = el('ad-lost-tiers');
  tw.innerHTML = '';
  tiers.forEach(function (t) {
    var tile = pickTile('ad-pick-opt' + tierClass(t.code) +
      (state.lostTier === t.code ? ' is-on' : ''), false, function () {
        state.lostTier = t.code;
        renderLost();
      });
    var line = make('span', 'ad-pick-line');
    line.appendChild(make('span', 'ad-pick-name', spaceName(t.code)));
    tile.appendChild(line);
    tile.appendChild(make('span', 'ad-pick-left',
      (t.sold || 0) + ' of ' + (t.capacity || 0) + ' in' +
      (t.lost ? ' · ' + t.lost + ' lost' : '')));
    tw.appendChild(tile);
  });

  var rw = el('ad-lost-reasons');
  rw.innerHTML = '';
  REASONS.forEach(function (x) {
    var tile = pickTile('ad-pick-opt' + (state.lostReason === x[0] ? ' is-on' : ''),
      false, function () { state.lostReason = x[0]; renderLost(); });
    tile.appendChild(make('span', 'ad-pick-name', x[1]));
    rw.appendChild(tile);
  });

  renderLostList();
}

function renderLostList() {
  var list = el('ad-lost-list');
  list.innerHTML = '';
  var lost = view().lost;
  el('ad-lost-list-head').hidden = !lost.length;
  lost.forEach(function (l) {
    var item = make('div', 'ad-lost-item');
    item.appendChild(make('span', 'ad-lost-what',
      spaceName(l.tier_code) + (multiSite() ? ' · ' + siteName(l.property_id) : '') +
      ' · ' + reasonName(l.reason) + (l.note ? ' — ' + l.note : '') +
      ' · ' + asTime(l.recorded_at)));
    item.appendChild(button('btn btn-outline ad-lost-undo', 'Undo', function () {
      undoLost(l);
    }));
    list.appendChild(item);
  });
}

export function pickLostSite() {
  state.lostSite = el('ad-lost-site').value;
  renderLost();
}

export function submitLost(e) {
  e.preventDefault();
  var err = el('ad-lost-error');
  if (!state.lostSite || !state.lostTier) {
    text(err, 'Which space?');
    show(err);
    return;
  }
  if (!state.lostReason) {
    text(err, 'Say why it was lost.');
    show(err);
    return;
  }
  var btn = el('ad-lost-submit');
  btn.disabled = true;
  hide(err);
  call('lose_space', {
    property_id: state.lostSite,
    tier_code: state.lostTier,
    reason: state.lostReason,
    note: el('ad-lost-note').value.trim() || null,
  })
    .then(function () {
      toast(spaceName(state.lostTier) + ' space lost' +
        (multiSite() ? ' at ' + siteName(state.lostSite) : '') + ' — taken off sale', 'good');
      state.lostReason = null;
      el('ad-lost-note').value = '';
      return loadList(true);
    })
    .then(function () { renderLost(); })
    .catch(function (x) {
      text(err, x.message);
      show(err);
    })
    .finally(function () { btn.disabled = false; });
}

function undoLost(l) {
  call('undo_lost_space', { id: l.id })
    .then(function () {
      toast(spaceName(l.tier_code) + ' space back on sale', 'good');
      return loadList(true);
    })
    .then(function () { renderLost(); })
    .catch(function (x) { toast(x.message, 'bad'); });
}
