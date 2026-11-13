/* Talli Parking — gate screen: tonight.js

   The Event tab (Tonight, before plan B3): the event's status and live
   switch, the reference price, and the night's running picture — the
   board, what is left at each site, extras and money. Sites and their
   spaces are set on the Sites page.
 */

import { GATE_ORDER, asDate, asTime, button, call, el, hide, make, money,
  shortName, show, state, surchargeOn, text, toast } from './core.js';
import { isOperator } from './session.js';
import { loadList, multiSite, refreshEvents, renderEventOptions, siteName } from './night.js';
import { showTab } from './tabs.js';
import { presetNight } from './sites.js';
import { seriesLine } from './series.js';

/* ------------------------------------------------------ tonight's board */

export function renderBoard() {
  var s = state.summary;
  if (!s) return;
  text(el('ad-board-filled'), String(s.filled));
  text(el('ad-board-capacity'), String(s.capacity));

  var pct = s.capacity ? Math.round((s.filled / s.capacity) * 100) : 0;
  el('ad-board-bar').style.width = Math.min(pct, 100) + '%';

  text(el('ad-board-note'), s.free + ' free');
}

/* ------------------------------------------------------------- prices */

// Standard first, then Priority, then Valet — the order you actually sell
// in, not the order the database sorts by. Anything else the fixture offers
// falls in behind.
export function inGateOrder(tiers) {
  var ranked = [];
  GATE_ORDER.forEach(function (code) {
    tiers.forEach(function (t) { if (t.code === code) ranked.push(t); });
  });
  tiers.forEach(function (t) { if (ranked.indexOf(t) === -1) ranked.push(t); });
  return ranked;
}

export function renderPrices() {
  var wrap = el('ad-prices');
  wrap.innerHTML = '';
  var tiers = inGateOrder(state.tiers);
  if (!tiers.length) {
    wrap.appendChild(make('p', 'ad-empty', 'No spots on sale for this event.'));
    return;
  }

  // One price per area (plan B1): the price is set on the reference site
  // and every other site follows at its area's adjustment, so only the
  // reference site's cards are here. The server refuses any other.
  var priced = tiers.filter(function (t) { return isReferenceSite(t.property_id); });
  if (priced.length) {
    priced.forEach(function (t) { wrap.appendChild(tierCard(t)); });
  } else {
    wrap.appendChild(make('p', 'ad-empty',
      'The reference site is not selling this night, so there is no price to move here.'));
  }
  if (isOperator()) wrap.appendChild(siteBoard());
}

// The night's running picture at every site: whether it sells online, and
// what is left of each type. Read-only. Which sites sell this night and
// how many spaces each has are set on the Sites page (plan B3); this link
// opens it on this night.
function siteBoard() {
  var box = make('div', 'ad-sites');
  box.appendChild(make('div', 'ad-sites-head', 'Every site tonight'));
  state.sites.forEach(function (site) {
    var line = make('div', 'ad-site-line');
    line.appendChild(make('span', 'ad-site-name',
      (site.block_name ? site.block_name + ' · ' : '') + site.name));
    line.appendChild(make('span', 'ad-chip is-' + site.status,
      site.status === 'confirmed' ? 'on sale' : site.status));
    box.appendChild(line);
    inGateOrder(state.tiers.filter(function (t) { return t.property_id === site.property_id; }))
      .forEach(function (t) {
        box.appendChild(make('div', 'ad-site-left', shortName(t) + ': ' + leftLine(t)));
      });
  });
  var more = make('p', 'ad-money-more');
  more.appendChild(button('ad-link', 'Change spaces or sites for this night', function () {
    presetNight(state.eventId);
    showTab('sites');
  }));
  more.appendChild(document.createTextNode(' on the Sites page.'));
  box.appendChild(more);
  return box;
}

// Everything about one type of space at the reference site: what it
// costs, cash and card, and what is left.
//
// There is no Sold out button. Sold out is what the count says, and a
// button that could disagree with the count is a second version of the
// truth to keep in step.
function tierCard(t) {
  var gone = t.manually_sold_out || t.spots_left_gate <= 0;
  var card = make('div', 'ad-price' + (gone ? ' is-gone' : ''));

  var head = make('div', 'ad-price-head');
  head.appendChild(make('span', 'ad-price-name',
    (multiSite() ? siteName(t.property_id) + ' · ' : '') + shortName(t)));
  head.appendChild(button('ad-price-tag', money(t.price_cents), function () { openPrice(t); }));
  card.appendChild(head);

  // The number above is what goes on the sign, and it is what a cash
  // customer hands over. Card is that plus the surcharge, so say both
  // rather than making anyone work it out at the driver's window.
  if (state.surchargeBps) {
    card.appendChild(make('div', 'ad-price-card',
      'cash ' + money(t.price_cents) + ' · card ' +
      money(t.price_cents + surchargeOn(t.price_cents, 'tap_to_pay'))));
  }

  var row = make('div', 'ad-price-actions');
  row.appendChild(button('ad-nudge', '−$5', function () {
    setPrice(t, t.price_cents - 500);
  }));
  row.appendChild(button('ad-nudge', '+$5', function () {
    setPrice(t, t.price_cents + 500);
  }));
  card.appendChild(row);

  card.appendChild(make('div', 'ad-price-left', leftLine(t)));

  return card;
}

function isReferenceSite(id) {
  return state.sites.some(function (s) { return s.property_id === id && s.is_reference; });
}

// The conclusion the counts add up to, in the words the question gets
// asked in: how many have gone, and can the website still sell one.
function leftLine(t) {
  if (t.manually_sold_out) return 'Marked sold out';
  if (!t.capacity) return 'No spaces set for tonight';

  var taken = (t.sold || 0) + ' of ' + t.capacity + ' taken';
  if (t.spots_left_gate <= 0) return taken + ' · full';
  if (t.spots_left > 0) return taken + ' · ' + t.spots_left + ' available online';
  return t.gate_reserve > 0
    ? taken + ' · nothing online, the rest is held for walk-ups'
    : taken + ' · nothing online';
}

// The dropdown under the price cards. It reads the same templates the
// new-event modal picks from, because they are the same list: what the
// roads are doing decides what a night is worth, whether the night is
// being made or re-priced an hour before kickoff.
export function renderPricePicker() {
  var box = el('ad-pricepick');
  var sel = el('ad-pricepick-select');

  // Nothing to pick from, or nothing to apply it to.
  if (!state.templates.length || !state.tiers.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  // Rebuilt on every refresh, which lands every 30 seconds — so put back
  // whatever was chosen, or a half-made decision disappears mid-tap.
  var chosen = sel.value;
  sel.innerHTML = '';
  sel.appendChild(new Option('Pick a template…', ''));
  state.templates.forEach(function (t) {
    sel.appendChild(new Option(t.name, t.id));
  });
  sel.value = chosen;
  if (sel.value !== chosen) sel.value = '';

  paintPricePick();
}

function pickedTemplate() {
  var id = el('ad-pricepick-select').value;
  if (!id) return null;
  var found = null;
  state.templates.forEach(function (t) { if (t.id === id) found = t; });
  return found;
}

// What the template is about to make the sign say, spelled out before it
// says it. Only the tiers this night actually sells: a template naming a
// spot that is not on tonight would otherwise read as a promise to add it.
function pricePickSummary(tpl) {
  var have = {};
  state.tiers.forEach(function (t) { have[t.code] = t; });

  var parts = [];
  inGateOrder((tpl.tiers || []).slice()).forEach(function (item) {
    var mine = have[String(item.code || '').toLowerCase()];
    if (mine) parts.push(shortName(mine) + ' ' + money(item.price_cents));
  });
  return parts;
}

export function paintPricePick() {
  var note = el('ad-pricepick-note');
  var go = el('ad-pricepick-apply');
  var tpl = pickedTemplate();

  if (!tpl) {
    go.disabled = true;
    hide(note);
    return;
  }

  var parts = pricePickSummary(tpl);
  go.disabled = !parts.length;
  text(note, parts.length
    ? parts.join(' · ')
    : tpl.name + ' prices nothing this night sells.');
  show(note);
}

export function applyPricePick() {
  var tpl = pickedTemplate();
  if (!tpl) return;

  var parts = pricePickSummary(tpl);
  if (!parts.length) return;

  // Every price on the night at once, on a phone, outdoors. Read the
  // numbers back before moving any of them.
  if (!window.confirm('Set the sign to ' + tpl.name + '?\n\n' + parts.join('\n'))) {
    return;
  }

  var go = el('ad-pricepick-apply');
  go.disabled = true;

  call('apply_price_template', {
    event_id: state.eventId,
    template_id: tpl.id,
  })
    .then(function () {
      toast(tpl.name + ' — ' + parts.join(', '), 'good');
      el('ad-pricepick-select').value = '';
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () { paintPricePick(); });
}

function setPrice(tier, cents) {
  call('set_price', {
    event_id: state.eventId,
    property_id: tier.property_id,
    tier_code: tier.code,
    price_cents: Math.round(cents),
  })
    .then(function (data) {
      toast(shortName(tier) + ' now ' + money(data.price_cents), 'good');
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); });
}

function openPrice(tier) {
  state.priceTier = tier;
  text(el('ad-price-title'), shortName(tier));
  el('ad-price-input').value = String(Math.round(tier.price_cents / 100));
  el('ad-price-error').hidden = true;
  paintPriceHint();
  show(el('ad-price'));
  el('ad-price-input').focus();
}

// Typed here, the number is the sign price — the cash price. Show what that
// becomes on a card as it is typed, so nobody has to discover it at the
// first tap-to-pay of the night.
export function paintPriceHint() {
  var hint = el('ad-price-hint');
  var dollars = Number(el('ad-price-input').value);
  if (!state.surchargeBps || !isFinite(dollars) || dollars <= 0) {
    hide(hint);
    return;
  }
  var cents = Math.round(dollars * 100);
  text(hint, 'Cash ' + money(cents) + ' · card ' +
    money(cents + surchargeOn(cents, 'tap_to_pay')) +
    ' (includes the card surcharge)');
  show(hint);
}

export function submitPrice(e) {
  e.preventDefault();
  var tier = state.priceTier;
  if (!tier) return;
  var dollars = Number(el('ad-price-input').value);
  if (!isFinite(dollars) || dollars < 1 || dollars > 500) {
    var box = el('ad-price-error');
    text(box, 'A price between $1 and $500, please.');
    show(box);
    return;
  }
  hide(el('ad-price'));
  setPrice(tier, dollars * 100);
}

/* ------------------------------------------------------------- extras */

export function renderExtras() {
  var wrap = el('ad-extras');
  wrap.innerHTML = '';
  if (!state.extras.length) {
    wrap.appendChild(make('p', 'ad-empty', 'Nothing pre-purchased for this event.'));
    return;
  }
  state.extras.forEach(function (item) {
    var row = make('div', 'ad-extra' + (item.pending ? '' : ' is-done'));
    row.appendChild(make('span', 'ad-extra-name', item.name));
    row.appendChild(make('span', 'ad-extra-count',
      item.pending
        ? item.pending + ' to hand over, of ' + item.total
        : 'all ' + item.total + ' handed over'));
    wrap.appendChild(row);
  });
}

/* -------------------------------------------------------------- money */

// Where the money actually landed. Four of them are how a night is
// reconciled — the Stripe payout, the terminal, the bank account and the
// tin — so those four always show, even at $0. A $0 line is an answer;
// a missing one is a question.
var CHANNELS = [
  // The Stripe payout: website bookings and walk-ups who paid by QR.
  ['stripe', 'Stripe (online + QR)', true],
  ['tap_to_pay', 'PayWave', true],
  ['bank_transfer', 'Bank transfer', true],
  ['cash', 'Cash', true],
  ['free', 'Free / comp', false],
  ['other', 'Other', false],
];

function rowCents(r) {
  return (r.amount_cents || 0) + (r.addons_cents || 0) + (r.surcharge_cents || 0);
}

// The same rows, and the same "paid" test, the server's taken_cents adds
// up — so the channels always sum to the total above them.
export function byChannel(rows) {
  var out = {};
  rows.forEach(function (r) {
    if (r.status !== 'paid') return;
    var at = out[r.payment_method] || (out[r.payment_method] = { cars: 0, cents: 0 });
    at.cars += 1;
    at.cents += rowCents(r);
  });
  return CHANNELS
    .filter(function (c) { return c[2] || out[c[0]]; })
    .map(function (c) {
      var at = out[c[0]] || { cars: 0, cents: 0 };
      return { code: c[0], label: c[1], cars: at.cars, cents: at.cents };
    });
}

export function cars(n) { return n + ' car' + (n === 1 ? '' : 's'); }

// [label, amount, lead?, small print?]
export function moneyRows(wrap, lines) {
  lines.forEach(function (line) {
    var row = make('div', 'ad-money-row' + (line[2] ? ' is-lead' : ''));
    var key = make('span', null, line[0]);
    if (line[3]) key.appendChild(make('span', 'ad-money-sub', line[3]));
    row.appendChild(key);
    row.appendChild(make('strong', null, line[1]));
    wrap.appendChild(row);
  });
}

export function renderMoney() {
  var s = state.summary;
  var wrap = el('ad-money');
  wrap.innerHTML = '';
  if (!s) return;

  var lines = [['Taken tonight', money(s.taken_cents), true]];
  byChannel(state.rows).forEach(function (c) {
    lines.push([c.label, money(c.cents), false, c.cars ? cars(c.cars) : null]);
  });
  lines.push(
    ['Of that, extras', money(s.addons_cents), false],
    ['Of that, card surcharge', money(s.surcharge_cents), false],
    ['Still to collect', money(s.cash_due_cents), s.cash_due_cents > 0],
    ['Owed by pay-later walk-ups', money(s.owing_cents || 0), (s.owing_cents || 0) > 0]
  );
  moneyRows(wrap, lines);

  var more = make('p', 'ad-money-more');
  more.appendChild(document.createTextNode('Finished nights, and more of the detail, are under '));
  more.appendChild(button('ad-link', 'Insights', function () { showTab('insights'); }));
  more.appendChild(document.createTextNode('.'));
  wrap.appendChild(more);
}


/* -------------------------------------------------- the event's status */

// What each status actually means for a customer standing on the website.
// Written out because "announced" and "draft" are not self-explanatory at
// 5pm, and picking the wrong one is silent: an event that never went on
// sale looks exactly like an event nobody booked.
var STATUSES = [
  ['draft', 'Draft', 'Hidden. Nobody can see this or book it.'],
  ['announced', 'Announced', 'Listed with no prices. People can register interest.'],
  ['on_sale', 'On sale', 'Live. The website is selling this now.'],
  ['closed', 'Closed', 'Off sale. Bookings already taken are unaffected.'],
  ['cancelled', 'Cancelled', 'Called off, and off the website entirely.'],
];

export function statusMeta(code) {
  return STATUSES.filter(function (s) { return s[0] === code; })[0] ||
    [code, String(code || '—').replace(/_/g, ' '), ''];
}

export function currentEvent() {
  return state.events.filter(function (e) { return e.id === state.eventId; })[0] || null;
}

export function renderStatus() {
  var ev = currentEvent();
  var actions = el('ad-status-actions');
  actions.innerHTML = '';

  if (!ev) {
    text(el('ad-status-name'), 'No event');
    text(el('ad-status-pill'), '—');
    text(el('ad-status-when'), '');
    text(el('ad-status-note'), 'Make one with + at the top of the screen.');
    text(el('ad-status-series'), '');
    hide(el('ad-series-open'));
    el('ad-status-live').innerHTML = '';
    return;
  }

  var meta = statusMeta(ev.status);
  text(el('ad-status-name'), ev.name);
  var pill = el('ad-status-pill');
  text(pill, meta[1]);
  pill.className = 'ad-status-pill is-' + ev.status;
  text(el('ad-status-when'),
    [asDate(ev.starts_at), asTime(ev.starts_at), ev.venue].filter(Boolean).join(' · '));
  text(el('ad-status-note'), meta[2]);
  text(el('ad-status-series'), seriesLine(ev));
  show(el('ad-series-open'));

  STATUSES.forEach(function (s) {
    var on = s[0] === ev.status;
    var b = button('ad-status-set' + (on ? ' is-on' : ''), s[1], function () {
      setStatus(ev, s[0]);
    });
    b.disabled = on || !!state.busy['status'];
    actions.appendChild(b);
  });

  renderLiveControl(ev);
}

// Whether this is the night Arrivals works (plan B2). One at a time: the
// database clears the last one when another is made live, and every
// warden's phone follows on its next refresh. Separate from the status,
// because selling online and working the gate are different questions —
// a night closed online is often still busy at the gate.
function renderLiveControl(ev) {
  var row = el('ad-status-live');
  row.innerHTML = '';
  var isLive = ev.id === state.liveId;
  var other = !isLive && state.liveId &&
    state.events.filter(function (e) { return e.id === state.liveId; })[0];
  row.classList.toggle('is-live', isLive);

  var words = isLive
    ? 'Live at the gate. Arrivals, and every warden, are working this night.'
    : other
      ? 'Not live. The gate is working ' + other.name + ' (' + asDate(other.starts_at) + ').'
      : 'Not live. No night is live at the gate.';
  row.appendChild(make('span', 'ad-status-live-text', words));

  var busy = !!state.busy['live'];
  if (isLive) {
    var stop = button('ad-status-set', 'Stop', function () { setLive(ev, false); });
    stop.disabled = busy;
    row.appendChild(stop);
    return;
  }
  var canGo = ev.status !== 'draft' && ev.status !== 'cancelled';
  var go = button('ad-status-set', other ? 'Make this live instead' : 'Make live',
    function () { setLive(ev, true); });
  go.disabled = busy || !canGo;
  if (!canGo) go.title = 'A draft or cancelled night cannot be live.';
  row.appendChild(go);
}

function setLive(ev, live) {
  if (!live && !window.confirm('Stop ' + ev.name + ' at the gate? ' +
      'Arrivals will show no event until another is made live.')) {
    return;
  }
  state.busy['live'] = true;
  renderStatus();
  call('set_live_event', live ? { event_id: ev.id } : { live: false })
    .then(function () {
      toast(live ? ev.name + ' is live at the gate' : 'No night is live at the gate', 'good');
      return refreshEvents();
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () {
      delete state.busy['live'];
      renderStatus();
    });
}

function setStatus(ev, status) {
  // Everything else here is reversible in one tap and this very nearly is
  // too — but "cancelled" is the one that reads to a customer as the game
  // being off, so it gets asked about.
  if (status === 'cancelled' &&
      !window.confirm('Cancel ' + ev.name + '? It comes off the website entirely.')) {
    return;
  }
  state.busy['status'] = true;
  renderStatus();

  call('set_event_status', { event_id: ev.id, status: status })
    .then(function (data) {
      ev.status = data.status;
      toast(ev.name + ' — ' + statusMeta(ev.status)[1].toLowerCase(), 'good');
      renderEventOptions();
      // Draft or cancelled takes a night off the gate too, in the database.
      if (ev.id === state.liveId && (ev.status === 'draft' || ev.status === 'cancelled')) {
        refreshEvents().catch(function () {});
      }
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () {
      delete state.busy['status'];
      renderStatus();
    });
}
