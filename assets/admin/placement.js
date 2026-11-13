/* Talli Parking — gate screen: placement.js

   Where a car goes, and spaces lost on the night (plan B5).

   Where a car goes is decided when it arrives, by the database: a
   Standard car takes a Standard space at the warden's site, then at
   another site in the block, then a Priority space here, then at another
   site. Never Valet. This module says where it went, lets the warden
   move it, and records a space nobody can use tonight.
 */

import { asTime, button, call, el, hide, make, show, state, text,
  toast } from './core.js';
import { loadList, multiSite, siteName, tierClass, view } from './night.js';
import { pickTile } from './walk-up.js';

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

// The sites and spaces this car may be moved to: any site in the block it
// was booked into, in its own type of space, and a Standard car in a
// Priority one too. Free is the count less cars and lost spaces; the
// space it is in is always offered.
function placeOptions(r) {
  var home = state.sites.filter(function (s) {
    return s.property_id === (r.booked_property_id || r.property_id);
  })[0];
  var block = home ? home.block_id : null;
  var codes = r.tier_code === 'standard' ? ['standard', 'priority'] : [r.tier_code];
  var now = r.space_code || r.tier_code;
  var out = [];
  state.sites.forEach(function (s) {
    if (s.property_id !== r.property_id && (!block || s.block_id !== block)) return;
    codes.forEach(function (code) {
      var t = state.tiers.filter(function (x) {
        return x.property_id === s.property_id && x.code === code;
      })[0];
      if (!t) return;
      var current = s.property_id === r.property_id && code === now;
      var free = (t.capacity || 0) - (t.sold || 0) - (t.lost || 0);
      out.push({ property_id: s.property_id, code: code, current: current,
        free: free, label: s.name + ' — ' + spaceName(code) +
          (current ? ' (now)' : free > 0 ? ' · ' + free + ' free' : ' · full') });
    });
  });
  return out;
}

export function renderPlace(r) {
  var row = el('ad-edit-place-row');
  var select = el('ad-edit-place');
  var opts = r.arrived ? placeOptions(r) : [];
  if (opts.length < 2) { hide(row); return; }
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
  if (pick[0] === r.property_id && pick[1] === (r.space_code || r.tier_code)) return;
  var btn = el('ad-edit-place-go');
  btn.disabled = true;
  call('place', { booking_id: r.booking_id, property_id: pick[0], space_code: pick[1] })
    .then(function () {
      toast((r.vehicle_rego || 'Booking') + ' moved to ' + siteName(pick[0]) +
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
