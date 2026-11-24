/* Talli Parking — gate screen: insights.js

   The Insights tab: how a night that has happened went.
 */

import { GATE_ORDER, asDate, call, el, make, money, shortName, state, toast } from './core.js';
import { dayKey, todayKey } from './night.js';
import { ALL, scopeLabel, scopeNight } from './scope.js';
import { byChannel, cars, moneyRows, statusMeta } from './tonight.js';

/* ----------------------------------------------------------- insights */

// Any night that has happened, most recent first — tonight included, as
// "so far", because the first thing anyone asks after the last car leaves
// is how it went. Nights still ahead have nothing to say yet.
function insightEvents() {
  var today = todayKey();
  return state.events
    .filter(function (ev) { return dayKey(ev.starts_at) <= today; })
    .slice()
    .reverse();
}

function renderInsightOptions() {
  var sel = el('ad-insight-event');
  sel.innerHTML = '';
  var events = insightEvents();
  if (!events.length) {
    sel.appendChild(new Option('No nights yet', ''));
    sel.disabled = true;
    state.insightId = null;
    return;
  }
  sel.disabled = false;
  var today = todayKey();
  events.forEach(function (ev) {
    var tag = dayKey(ev.starts_at) === today ? ' (tonight, so far)'
      : ev.status === 'cancelled' ? ' (cancelled)' : '';
    sel.appendChild(new Option(asDate(ev.starts_at) + ' — ' + ev.name + tag, ev.id));
  });
  var still = events.some(function (ev) { return ev.id === state.insightId; });
  if (!still) state.insightId = events[0].id;
  sel.value = state.insightId;
}

export function openInsights() {
  loadReviews();
  renderInsightOptions();
  if (!state.insightId) {
    state.insight = null;
    renderInsight();
    return;
  }
  if (!state.insight || state.insight.eventId !== state.insightId) loadInsight();
}

// Its own copy of the night, so looking back at last Saturday never
// disturbs the list the gate is working from right now.
export function loadInsight() {
  var id = state.insightId;
  if (!id) return;
  var wrap = el('ad-insight');
  wrap.setAttribute('aria-busy', 'true');
  return call('list', { event_id: id })
    .then(function (data) {
      // Somebody picked a different night while this one was on its way.
      if (id !== state.insightId) return;
      state.insight = {
        eventId: id,
        rows: data.rows || [],
        tiers: data.tiers || [],
        sites: data.sites || [],
        lost: data.lost || [],
        summary: data.summary || null,
      };
      renderInsight();
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () { wrap.removeAttribute('aria-busy'); });
}

function insightSection(wrap, title) {
  wrap.appendChild(make('h2', 'ad-section', title));
  var box = make('div', 'ad-money');
  wrap.appendChild(box);
  return box;
}

export function renderInsight() {
  var wrap = el('ad-insight');
  wrap.innerHTML = '';
  var data = state.insight;
  var ev = data && state.events.filter(function (e) { return e.id === data.eventId; })[0];
  if (!data || !ev || !data.summary) {
    wrap.appendChild(make('p', 'ad-empty',
      state.insightId ? 'Loading…' : 'Nothing to look back on yet.'));
    return;
  }

  // The night's figures for the sites chosen at the top (plan B6), counted
  // the same way the gate counts them, so a past night's sites add up to
  // its blocks and its blocks to all.
  var scope = state.scope || ALL;
  var v = scopeNight(data, scope);
  var s = v.summary;
  var paid = v.rows.filter(function (r) { return r.status === 'paid'; });

  // The headline: what came in, and how full the place was.
  var board = make('div', 'ad-board');
  var fill = make('div', 'ad-board-fill');
  fill.appendChild(make('span', 'ad-board-num', money(s.taken_cents)));
  fill.appendChild(make('span', 'ad-board-of',
    'from ' + cars(paid.length) + ' · ' + s.filled + ' of ' + s.capacity + ' spaces'));
  var bar = make('div', 'ad-bar');
  var barFill = make('span', 'ad-bar-fill');
  barFill.style.width = Math.min(s.capacity ? Math.round(s.filled / s.capacity * 100) : 0, 100) + '%';
  bar.appendChild(barFill);
  fill.appendChild(bar);
  fill.appendChild(make('span', 'ad-board-note',
    [ev.name, asDate(ev.starts_at), ev.venue, statusMeta(ev.status)[1],
      scope === ALL ? null : scopeLabel(data.sites, scope) || 'not at this site that night']
      .filter(Boolean).join(' · ')));
  board.appendChild(fill);
  wrap.appendChild(board);

  // By how it was paid.
  var channels = byChannel(v.rows);
  var pay = insightSection(wrap, 'By payment');
  moneyRows(pay, channels.map(function (c) {
    var share = s.taken_cents ? Math.round(c.cents / s.taken_cents * 100) : 0;
    return [c.label, money(c.cents), false,
      c.cars ? cars(c.cars) + ' · ' + share + '%' : null];
  }).concat([['Total', money(s.taken_cents), true]]));

  // By the kind of space. Space price only: extras and surcharge are not
  // what the spot was worth, and they have their own lines below.
  var names = {};
  v.tiers.forEach(function (t) { names[t.code] = shortName(t); });
  var tiers = {};
  paid.forEach(function (r) {
    var code = r.tier_code || 'other';
    var at = tiers[code] || (tiers[code] = { cars: 0, cents: 0 });
    at.cars += 1;
    at.cents += r.amount_cents || 0;
  });
  var order = GATE_ORDER.filter(function (c) { return tiers[c]; })
    .concat(Object.keys(tiers).filter(function (c) { return GATE_ORDER.indexOf(c) === -1; }));
  if (order.length) {
    var spots = insightSection(wrap, 'By spot');
    moneyRows(spots, order.map(function (code) {
      var t = tiers[code];
      return [names[code] || code.replace(/_/g, ' '), money(t.cents), false,
        cars(t.cars) + (t.cars ? ' · avg ' + money(Math.round(t.cents / t.cars)) : '')];
    }));
  }

  // What the total is made of, and where it was sold.
  var online = paid.filter(function (r) { return r.channel === 'online'; });
  var gate = paid.filter(function (r) { return r.channel === 'gate'; });
  var made = insightSection(wrap, 'Made up of');
  moneyRows(made, [
    ['Spaces', money(s.taken_cents - s.addons_cents - s.surcharge_cents), false],
    ['Extras', money(s.addons_cents), false],
    ['Card surcharge', money(s.surcharge_cents), false, 'covers card fees'],
    ['Booked online', money(s.online_cents), false, cars(online.length)],
    ['Sold at the gate', money(s.gate_cents), false, cars(gate.length)],
  ]);

  // Anything the night left unfinished.
  var noShows = paid.filter(function (r) { return !r.arrived; }).length;
  var loose = [];
  if (s.owing_cents) loose.push(['Owed by pay-later walk-ups', money(s.owing_cents), true, cars(s.owing)]);
  if (s.cash_due_cents) loose.push(['Still to collect', money(s.cash_due_cents), true]);
  if (noShows) loose.push(['Paid, never ticked in', cars(noShows), false]);
  if (loose.length) moneyRows(insightSection(wrap, 'Loose ends'), loose);
}

/* ------------------------------------------------------------ reviews */

// What customers said, from the rating form on the homepage
// (docs/plans/reviews-and-contact.md). Every review, whichever night is
// picked above: most come from the homepage and say no night. Loaded each
// time the tab opens, so a review sent while it was shut is there.
export function loadReviews() {
  var wrap = el('ad-reviews');
  if (!wrap) return;
  wrap.setAttribute('aria-busy', 'true');
  return call('reviews', {})
    .then(function (data) { renderReviews(data); })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () { wrap.removeAttribute('aria-busy'); });
}

function starsText(n) {
  var whole = Math.round(Number(n) || 0);
  return '★★★★★'.slice(0, whole) + '☆☆☆☆☆'.slice(0, 5 - whole);
}

function thumbs(yes, no, what) {
  if (!yes && !no) return null;
  return what + ' ' + yes + ' / ' + (yes + no);
}

export function renderReviews(data) {
  var wrap = el('ad-reviews');
  wrap.innerHTML = '';
  wrap.appendChild(make('h2', 'ad-section', 'Reviews'));
  var overall = (data && data.overall) || { count: 0 };
  if (!overall.count) {
    wrap.appendChild(make('p', 'ad-empty', 'No reviews yet. The form is at the bottom of the homepage.'));
    return;
  }
  wrap.appendChild(make('p', 'ad-section-note',
    overall.average + ' average from ' + overall.count +
    (overall.count === 1 ? ' review' : ' reviews') + '. Not shown anywhere public.'));

  // Each site's own average, and the two thumbs about the site itself.
  var box = make('div', 'ad-money');
  wrap.appendChild(box);
  moneyRows(box, (data.sites || []).map(function (s) {
    var notes = [s.count + (s.count === 1 ? ' review' : ' reviews'),
      thumbs(s.find_yes, s.find_no, 'easy to find'),
      thumbs(s.leave_yes, s.leave_no, 'easy to leave')].filter(Boolean);
    return [s.label, s.average + ' ' + starsText(s.average), false, notes.join(' · ')];
  }));

  // The latest, newest first, with whatever they told us.
  var list = make('ul', 'ad-reviews');
  (data.latest || []).forEach(function (r) {
    var li = make('li', 'ad-review');
    var head = make('div', 'ad-review-head');
    head.appendChild(make('span', 'ad-review-stars', starsText(r.rating)));
    head.appendChild(make('span', 'ad-review-when', asDate(r.created_at)));
    li.appendChild(head);
    if (r.comment) li.appendChild(make('p', 'ad-review-text', r.comment));
    var about = [r.site || 'Site not said', r.event,
      r.easy_to_find === false ? 'hard to find' : null,
      r.easy_to_leave === false ? 'hard to get out' : null,
      r.source === 'booking' ? 'from a booking' : null].filter(Boolean);
    li.appendChild(make('p', 'ad-review-meta', about.join(' · ')));
    var who = [r.name, r.contact].filter(Boolean).join(' · ');
    if (who) li.appendChild(make('p', 'ad-review-who', who));
    list.appendChild(li);
  });
  wrap.appendChild(list);
}
