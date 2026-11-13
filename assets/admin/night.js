/* Talli Parking — gate screen: night.js

   The night being worked: the event pickers, loading the list, which
   driveway this phone is at, and the headline numbers.
 */

import { ARRIVAL_ORDER, TZ, asDate, call, el, hide, make, money, show,
  state, text, toast } from './core.js';
import { renderList } from './arrivals.js';
import { renderBoard, renderExtras, renderMoney, renderPricePicker,
  renderPrices, renderStatus, statusMeta } from './tonight.js';
import { measureHead } from './tabs.js';
import { renderInfo } from './site-info.js';
import { renderInsight } from './insights.js';
import { refillSites } from './sites.js';
import { isOperator } from './session.js';
import { ALL, chosenSite, hereSite, resolveScope, scopeLabel, scopeNight,
  scopeOptions } from './scope.js';

/* ------------------------------------------------------------- events */

// The calendar day an event falls on, at the ground. There is only ever
// one event a day, so the day is what identifies "tonight" — not the
// kickoff instant, which passes while the night is still being worked.
export function dayKey(iso) {
  var parts = {};
  new Intl.DateTimeFormat('en-NZ', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso)).forEach(function (p) { parts[p.type] = p.value; });
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function todayKey() { return dayKey(new Date()); }

var FINISHED = ['closed', 'cancelled'];

// What the header picker carries: tonight and everything ahead, plus any
// earlier night still not closed off — that one needs a tap, and hiding
// it is how it stays on sale for ever. Finished nights are under Insights.
function headerEvents() {
  var today = todayKey();
  return state.events.filter(function (ev) {
    return dayKey(ev.starts_at) >= today ||
      FINISHED.indexOf(ev.status) === -1 ||
      ev.id === state.pickId || ev.id === state.liveId;
  });
}

// Redrawn on its own whenever an event is made or its status moves, so
// the name in the picker never disagrees with the badge below it.
export function renderEventOptions() {
  var sel = el('ad-event');
  sel.innerHTML = '';
  var events = headerEvents();
  if (!events.length) {
    sel.appendChild(new Option(state.events.length ? 'Nothing coming up' : 'No events yet', ''));
    return;
  }
  events.forEach(function (ev) {
    var label = asDate(ev.starts_at) + ' — ' + ev.name +
      (ev.status !== 'on_sale' ? ' (' + statusMeta(ev.status)[1].toLowerCase() + ')' : '');
    var live = ev.id === state.liveId ? ' · live' : '';
    sel.appendChild(new Option(label + live, ev.id));
  });
  if (state.pickId) sel.value = state.pickId;
}

export function renderEvents() {
  // Tonight opens on the live night when there is one. Failing that, on
  // tonight's event, kept until midnight: kickoff passing is the middle of
  // the night's work, not the end of it. Failing that, the next one
  // coming. A cancelled night is passed over if there is anything else on
  // the same day or later.
  var today = todayKey();
  var ahead = state.events.filter(function (e) { return dayKey(e.starts_at) >= today; });
  var pick = liveEvent() ||
    ahead.filter(function (e) { return e.status !== 'cancelled'; })[0] ||
    ahead[0] || headerEvents().slice(-1)[0] || null;

  state.pickId = pick ? pick.id : null;
  renderEventOptions();
  renderLive();
  syncEvent();
}

/* ------------------------------------------------- the live night */

// One event is live at a time (plan B2), and Arrivals and Site info work
// that one. There is no picker for it on those tabs: the server resolves
// it, and refuses a warden who names another. Tonight keeps its picker so
// Andrew can open any night.
export function liveEvent() {
  return state.events.filter(function (e) { return e.id === state.liveId; })[0] || null;
}

export function workingEventId() {
  return state.tab === 'night' ? state.pickId : state.liveId;
}

function onLiveNight() { return state.tab !== 'night'; }

// Point the screen at the night the current tab works, loading it if that
// is not the one already on screen.
export function syncEvent() {
  var want = workingEventId();
  if (want === state.eventId && (want || !onLiveNight())) return;
  state.eventId = want;
  clearNight();
  renderAll();
  return loadList();
}

function clearNight() {
  state.rows = [];
  state.tiers = [];
  state.sites = [];
  state.lost = [];
  state.extras = [];
  state.summary = null;
  state.view = null;
}

export function renderLive() {
  var line = el('ad-live');
  if (!line) return;
  line.innerHTML = '';
  var ev = liveEvent();
  line.classList.toggle('is-none', !ev);
  line.appendChild(make('span', 'ad-live-dot'));
  line.appendChild(make('span', 'ad-live-name', ev
    ? 'Live: ' + asDate(ev.starts_at) + ' — ' + ev.name
    : 'No event is live at the gate'));
}

// The events list and which one is live, again. After the live night or
// an event's status moves, and when a refresh finds the gate has moved on.
export function refreshEvents() {
  return call('events').then(function (data) {
    state.events = data.events || [];
    state.liveId = data.live_event_id || null;
    renderEventOptions();
    renderLive();
    renderStatus();
  });
}

/* ---------------------------------------------------- the whole night */

// Each load is numbered so one that comes back after the screen has moved
// to another night (a tab switch, the live night changing) is dropped.
var loadSeq = 0;

export function loadList(quiet) {
  var live = onLiveNight();
  // On Arrivals the phone asks for the live night by not naming one: the
  // server says which it is. That is how a warden's phone follows Andrew
  // moving the gate on, at the next refresh, with nothing to pick.
  if (!live && !state.eventId) return;
  var seq = ++loadSeq;
  if (!quiet) el('ad-list').setAttribute('aria-busy', 'true');

  return call('list', live ? {} : { event_id: state.eventId })
    .then(function (data) {
      if (seq !== loadSeq) return;
      if (live) {
        var moved = data.event_id !== state.liveId;
        state.liveId = data.event_id;
        state.eventId = data.event_id;
        if (moved) refreshEvents().catch(function () {});
      }
      state.rows = data.rows || [];
      state.tiers = data.tiers || [];
      state.sites = data.sites || [];
      state.lost = data.lost || [];
      pickScope();
      state.extras = data.extras || [];
      state.summary = data.summary || null;
      state.surchargeBps = data.card_surcharge_bps || 0;
      renderAll();
    })
    .catch(function (err) {
      if (seq !== loadSeq) return;
      // Nothing live is a state of the gate, not a failure: say so in the
      // list and the header, and keep refreshing until Andrew picks one.
      if (err && err.code === 'NO_LIVE_EVENT') {
        var had = state.liveId;
        state.liveId = null;
        state.eventId = null;
        clearNight();
        renderAll();
        if (had) refreshEvents().catch(function () {});
        return;
      }
      toast(err.message, 'bad');
    })
    .finally(function () { el('ad-list').removeAttribute('aria-busy'); });
}

/* ----------------------------------------- which sites: the selector */

// One selector at the top of the screen (plan B6): all sites, a block, or
// one site, and every tab follows it. The choice belongs to the device,
// not the night: a warden's phone at Gribblehurst is at Gribblehurst on
// Saturday too. It is kept as chosen even on a night that does not have
// it to offer, and comes back on the next night that does.

var SCOPE_KEY = 'talli.gate.scope';

export function multiSite() { return state.sites.length > 1; }

// "All" is offered to Andrew, and to a warden who holds every block —
// for anyone else there is no all that is theirs. The server sends a
// warden only their own sites whatever this says.
export function canSeeAll() {
  return isOperator() || !!(state.who && state.who.every_block);
}

function savedScope() {
  if (state.scopeSaved !== undefined) return state.scopeSaved;
  try { state.scopeSaved = window.localStorage.getItem(SCOPE_KEY); } catch (e) { state.scopeSaved = null; }
  return state.scopeSaved;
}

function pickScope() {
  state.scope = resolveScope(savedScope(), state.sites, canSeeAll());
  var here = hereSite(state.sites, state.scope);
  state.siteId = here ? here.property_id : null;
}

export function setScope(value) {
  state.scopeSaved = value;
  try { window.localStorage.setItem(SCOPE_KEY, value); } catch (e) { /* private mode */ }
  pickScope();
  renderAll();
  if (state.tab === 'insights') renderInsight();
  if (state.tab === 'sites') refillSites();
}

// The night as the selector narrows it: rows, tiers, sites, lost spaces,
// extras and the totals counted from them. What every tab draws. The
// full night stays in state: moving a car is to any site in its block,
// whatever is selected.
export function view() {
  if (!state.view) state.view = scopeNight(state, state.scope || ALL);
  return state.view;
}

// The site chosen, when one is; null for a block or all.
export function chosenHere() {
  return chosenSite(state.sites, state.scope);
}

export function scopeName() {
  return scopeLabel(state.sites, state.scope);
}

export function siteName(id) {
  var s = state.sites.filter(function (x) { return x.property_id === id; })[0];
  return s ? s.name : '';
}

export function currentSite() {
  return state.sites.filter(function (x) { return x.property_id === state.siteId; })[0] || null;
}

// The types of space sold at the driveway this phone is at. With one
// site, that is every type tonight, exactly as before.
export function tiersHere() {
  if (!multiSite() || !state.siteId) return state.tiers;
  return state.tiers.filter(function (t) { return t.property_id === state.siteId; });
}

// The types of space at the driveway one booking is at. Moving a car to
// another type is priced and counted there — the server looks the type
// up at the booking's own site — so the edit sheet must offer exactly
// those, not every site's copy of each type.
export function tiersFor(r) {
  if (!r || !r.property_id) return state.tiers;
  var own = state.tiers.filter(function (t) { return t.property_id === r.property_id; });
  return own.length ? own : state.tiers;
}

function renderScopePicker() {
  var row = el('ad-scope-row');
  var select = el('ad-scope');
  if (!row || !select) return;
  var opts = scopeOptions(state.sites, canSeeAll());
  // One site to the caller's name tonight: nothing to choose.
  row.hidden = !multiSite() || opts.length < 2;
  if (!row.hidden) {
    select.innerHTML = '';
    opts.forEach(function (o) {
      var id = o.value.slice(o.value.indexOf(':') + 1);
      var label = o.label;
      if (o.value.indexOf('site:') === 0) {
        label += ' — ' + arrivedAt(id) + '/' + capacityAt(id) + ' in';
        var s = state.sites.filter(function (x) { return x.property_id === id; })[0];
        if (s && s.status !== 'confirmed') label += ' · ' + s.status;
      }
      // A tree in a native select: what a phone shows best. Indented with
      // non-breaking spaces, which every platform keeps.
      var opt = new Option((o.depth ? '    ' : '') + label, o.value);
      opt.selected = o.value === state.scope;
      select.appendChild(opt);
    });
    select.value = state.scope;
  }

  // The chosen site's own guide and notes, on Arrivals. Only for one site:
  // a block's would be one of its sites' notes passed off as the block's.
  var site = chosenHere() || (multiSite() ? null : state.sites[0] || null);
  var guide = el('ad-site-guide');
  if (guide) {
    guide.hidden = !(site && site.site_guide_url);
    if (site && site.site_guide_url) guide.href = site.site_guide_url;
  }
  var guideRow = el('ad-site-row');
  if (guideRow) guideRow.hidden = !(site && site.site_guide_url);
  var notes = el('ad-site-notes');
  if (notes) {
    notes.hidden = !(site && site.fill_notes);
    text(notes, site && site.fill_notes ? site.fill_notes : '');
  }
}

export function capacityAt(id) {
  return state.tiers.filter(function (t) { return t.property_id === id; })
    .reduce(function (n, t) { return n + (t.capacity || 0); }, 0);
}

export function arrivedAt(id) {
  return state.rows.filter(function (r) {
    return r.arrived && r.property_id === id;
  }).length;
}

export function renderAll() {
  state.view = null;
  renderLive();
  renderScopePicker();
  renderStats();
  renderSplit();
  renderList();
  renderStatus();
  renderBoard();
  renderPrices();
  renderPricePicker();
  renderExtras();
  renderMoney();
  renderInfo();
  measureHead();
}

function renderStats() {
  var s = state.summary ? view().summary : null;
  if (!s) {
    // No night loaded (none live): no numbers left over from the last one.
    ['ad-stat-arrived', 'ad-stat-free', 'ad-stat-taken'].forEach(function (id) {
      text(el(id), '—');
    });
    hide(el('ad-holds'));
    return;
  }
  text(el('ad-stat-arrived'), s.arrived + '/' + s.total);
  text(el('ad-stat-free'), String(s.free));
  text(el('ad-stat-taken'), money(s.taken_cents));

  var holds = el('ad-holds');
  var notes = [];
  if (s.owing > 0) {
    notes.push(s.owing + ' walk-up' + (s.owing === 1 ? '' : 's') +
      ' still to pay — ' + money(s.owing_cents) + '.');
  }
  if (s.unpaid_holds > 0) {
    notes.push(s.unpaid_holds + ' unpaid hold' + (s.unpaid_holds === 1 ? '' : 's') +
      ' — people mid-checkout, not confirmed bookings.');
  }
  // Its own line in the night's totals: not free, not filled (plan B5).
  if (s.lost > 0) {
    notes.push(s.lost + ' space' + (s.lost === 1 ? '' : 's') + ' lost tonight.');
  }
  if (s.extras_pending > 0) {
    notes.push(s.extras_pending + ' pre-paid item' + (s.extras_pending === 1 ? '' : 's') +
      ' still to hand over.');
  }
  if (notes.length) {
    text(holds, notes.join(' '));
    show(holds);
  } else {
    hide(holds);
  }
}

// The tier as a class, so a Priority row and the Priority tally are the
// same colour without either of them naming it.
export function tierClass(code) {
  return code ? ' is-tier-' + String(code).replace(/[^a-z0-9]+/gi, '-').toLowerCase() : '';
}

// Where a tier sits in the arrivals running order. Anything the fixture
// sells that the order does not name falls in behind, alphabetically.
function byArrivalOrder(a, b) {
  var ai = ARRIVAL_ORDER.indexOf(a);
  var bi = ARRIVAL_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

// Bookings in tier order, each tier's rows left in the order the server
// sent them — not arrived first, then earliest arrival window. Grouping
// reorders the sections, never the queue inside one.
export function byTier(rows) {
  var seen = {};
  var groups = [];
  rows.forEach(function (r) {
    var code = r.tier_code || 'other';
    if (!seen[code]) {
      seen[code] = { code: code, rows: [], arrived: 0 };
      groups.push(seen[code]);
    }
    seen[code].rows.push(r);
    if (r.arrived) seen[code].arrived += 1;
  });
  groups.sort(function (x, y) { return byArrivalOrder(x.code, y.code); });
  return groups;
}

// Arrived over booked, per tier. The headline already says 6/10; what it
// cannot say is that the four still out are all Valet, which is the
// difference between a queue that clears itself and four sets of keys
// arriving at once. Counted off the rows rather than asked of the server,
// so it stays true between refreshes and always adds up to the headline —
// unpaid holds included, exactly as the headline counts them.
function renderSplit() {
  var wrap = el('ad-split');
  wrap.innerHTML = '';

  var seen = {};
  var codes = [];
  view().rows.forEach(function (r) {
    var code = r.tier_code || 'other';
    if (!seen[code]) { seen[code] = { arrived: 0, total: 0 }; codes.push(code); }
    seen[code].total += 1;
    if (r.arrived) seen[code].arrived += 1;
  });

  if (!codes.length) {
    hide(wrap);
    return;
  }

  // Left to right in the order the list below is grouped, so the chip and
  // the section it summarises are never in different places.
  codes.sort(byArrivalOrder);

  codes.forEach(function (code) {
    var n = seen[code];
    var done = n.arrived === n.total;
    var item = make('div', 'ad-split-item' + tierClass(code) + (done ? ' is-done' : ''));
    item.appendChild(make('span', 'ad-split-num', n.arrived + '/' + n.total));
    item.appendChild(make('span', 'ad-split-key', code.replace(/_/g, ' ')));
    item.title = n.arrived + ' of ' + n.total + ' ' + code.replace(/_/g, ' ') +
      ' in' + (done ? '' : ', ' + (n.total - n.arrived) + ' still to come');
    wrap.appendChild(item);
  });

  show(wrap);
}
