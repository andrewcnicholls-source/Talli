/* Talli Parking — gate screen: tonight.js

   The Tonight tab: the board, prices, spaces, extras, money and the
   event's status.
 */

import { GATE_ORDER, asDate, asTime, button, call, el, hide, make, money,
  shortName, show, state, surchargeOn, text, toast } from './core.js';
import { isOperator } from './session.js';
import { loadList, multiSite, renderEventOptions, siteName } from './night.js';
import { showTab } from './tabs.js';
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

  if (isOperator()) wrap.appendChild(siteBoard());
  tiers.forEach(function (t) { wrap.appendChild(tierCard(t)); });
}

// Each driveway's online status for this event. A host's site sells
// online only once it is confirmed; paused stops the website and leaves
// the gate working.
function siteBoard() {
  var box = make('div', 'ad-sites');
  box.appendChild(make('div', 'ad-sites-head', 'Sites tonight'));
  state.sites.forEach(function (site) {
    var line = make('div', 'ad-site-line');
    line.appendChild(make('span', 'ad-site-name',
      (site.block_name ? site.block_name + ' · ' : '') + site.name));
    line.appendChild(make('span', 'ad-chip is-' + site.status, site.status));
    var next = site.status === 'confirmed' ? 'paused' : 'confirmed';
    line.appendChild(button('ad-nudge', next === 'confirmed' ? 'Put on sale' : 'Pause online',
      function () {
        call('set_offer_status', {
          event_id: state.eventId, property_id: site.property_id, status: next,
        })
          .then(function () {
            toast(site.name + ' ' + (next === 'confirmed' ? 'on sale online' : 'paused online'), 'good');
            return loadList(true);
          })
          .catch(function (err) { toast(err.message, 'bad'); });
      }));
    box.appendChild(line);
  });

  // Another driveway for this event. It joins as pending with no spaces:
  // set its counts on its cards below, then put it on sale.
  var add = make('div', 'ad-site-line');
  var picker = document.createElement('select');
  picker.className = 'ad-select';
  picker.setAttribute('aria-label', 'Add a site to this event');
  var first = document.createElement('option');
  first.value = '';
  first.textContent = 'Add a site…';
  picker.appendChild(first);
  picker.addEventListener('focus', function () { fillSiteOptions(picker); }, { once: true });
  picker.addEventListener('change', function () {
    var id = picker.value;
    if (!id) return;
    var label = picker.options[picker.selectedIndex].textContent;
    call('add_offer', { event_id: state.eventId, property_id: id })
      .then(function () {
        toast(label + ' added — set its spaces, then put it on sale', 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); picker.value = ''; });
  });
  add.appendChild(picker);
  box.appendChild(add);
  return box;
}

function fillSiteOptions(picker) {
  call('site_options', { event_id: state.eventId })
    .then(function (data) {
      var sites = data.sites || [];
      if (!sites.length) {
        picker.options[0].textContent = 'Every site is already in this event';
        return;
      }
      sites.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.property_id;
        opt.textContent = (s.block_name ? s.block_name + ' · ' : '') + s.name;
        picker.appendChild(opt);
      });
    })
    .catch(function (err) { toast(err.message, 'bad'); });
}

// Everything about one type of space on one card: what it is, what it
// costs, how many there are, how many have gone, how many are being kept
// back for walk-ups, and what that leaves the website. The yard used to
// be a separate section of four cards split by corner, which is a fact
// about 86 Paice Ave rather than about parking.
//
// There is no Sold out button. Sold out is what the count says, and a
// button that could disagree with the count is a second version of the
// truth to keep in step.
function tierCard(t) {
  var gone = t.manually_sold_out || t.spots_left_gate <= 0;
  var card = make('div', 'ad-price' + (gone ? ' is-gone' : ''));

  // One price per area (plan B1): a price is set on the reference site
  // and every other site follows at its area's adjustment, so only the
  // reference site's card can move a price. The server refuses the rest.
  var priced = isReferenceSite(t.property_id);
  var head = make('div', 'ad-price-head');
  head.appendChild(make('span', 'ad-price-name',
    (multiSite() ? siteName(t.property_id) + ' · ' : '') + shortName(t)));
  head.appendChild(priced
    ? button('ad-price-tag', money(t.price_cents), function () { openPrice(t); })
    : make('span', 'ad-price-tag', money(t.price_cents)));
  card.appendChild(head);

  // The number above is what goes on the sign, and it is what a cash
  // customer hands over. Card is that plus the surcharge, so say both
  // rather than making anyone work it out at the driver's window.
  if (state.surchargeBps) {
    card.appendChild(make('div', 'ad-price-card',
      'cash ' + money(t.price_cents) + ' · card ' +
      money(t.price_cents + surchargeOn(t.price_cents, 'tap_to_pay'))));
  }

  if (priced) {
    var row = make('div', 'ad-price-actions');
    row.appendChild(button('ad-nudge', '−$5', function () {
      setPrice(t, t.price_cents - 500);
    }));
    row.appendChild(button('ad-nudge', '+$5', function () {
      setPrice(t, t.price_cents + 500);
    }));
    card.appendChild(row);
  } else {
    card.appendChild(make('div', 'ad-price-card',
      'follows the reference site at this area’s adjustment (Sites tab)'));
  }

  var spaces = spacesRow(t);
  if (spaces) card.appendChild(spaces);

  var reserve = reserveRow(t);
  if (reserve) card.appendChild(reserve);

  card.appendChild(make('div', 'ad-price-left', leftLine(t)));

  return card;
}

function isReferenceSite(id) {
  return state.sites.some(function (s) { return s.property_id === id && s.is_reference; });
}

// The conclusion the other two rows add up to, in the words the question
// gets asked in: how many have gone, and can the website still sell one.
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

// How many of this type there are tonight. A space lost to a bad park is
// one tap here: Andrew knows which bays are which, so a lost one in the
// back yard is one fewer Standard and he does not have to say which bay.
function spacesRow(t) {
  if (typeof t.capacity !== 'number') return null;

  var row = make('div', 'ad-tally');
  row.appendChild(make('span', 'ad-tally-key', 'spaces tonight'));

  var down = button('ad-count-btn', '−', function () { nudgeSpaces(t, -1); });
  down.title = 'One fewer — a space lost tonight';
  row.appendChild(down);

  row.appendChild(make('span', 'ad-tally-num', String(t.capacity)));

  var up = button('ad-count-btn', '+', function () { nudgeSpaces(t, 1); });
  up.title = 'One more — a space squeezed in tonight';
  row.appendChild(up);

  return row;
}

// A delta, for the same reason the reserve sends one: the figure on the
// glass may be another phone's work, and a tap must move the count the
// way it was meant rather than write back what happened to be showing.
function nudgeSpaces(tier, delta) {
  call('set_capacity', {
    event_id: state.eventId,
    property_id: tier.property_id,
    tier_code: tier.code,
    delta: delta,
  })
    .then(function (data) {
      toast(shortName(tier) + ': ' + data.capacity + ' space' +
        (data.capacity === 1 ? '' : 's') + ' tonight', 'good');
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); });
}

// Spaces of this tier the website may not sell down into, for tonight and
// tonight only. Two taps, the same − / + as the row above it, because it
// is the same kind of decision made at the same moment: one more, one fewer.
//
// "Release" rather than "−" in words, because that is what lowering it
// does — Standard nearly gone an hour before kickoff is the reason this
// control exists, and the answer is to put two of the held spaces back on
// the website rather than to stand at the gate hoping.
function reserveRow(t) {
  // No reserve in the payload means the backend predates it: an older
  // gate-ops, or a database without the column. Drawing a 0 there would
  // be a claim about the night that nothing has told us, so draw nothing.
  if (typeof t.gate_reserve !== 'number') return null;

  var row = make('div', 'ad-reserve');

  row.appendChild(make('span', 'ad-reserve-key', 'held for walk-ups'));

  var down = button('ad-count-btn', '−', function () {
    nudgeReserve(t, -1);
  });
  // Not disabled at zero. The number beside it is thirty seconds old at
  // worst and may be another phone's work at best; the database clamps,
  // and a button that refuses to press is worse than one that no-ops.
  down.title = 'Release one to the website';
  row.appendChild(down);

  row.appendChild(make('span', 'ad-reserve-num', String(t.gate_reserve)));

  var up = button('ad-count-btn', '+', function () {
    nudgeReserve(t, 1);
  });
  up.title = 'Hold one more back from the website';
  row.appendChild(up);

  return row;
}

// One more, one fewer — never "set it to this". What the screen is showing
// can be stale, and a tap must move the reserve the way it was meant
// rather than write back the figure that happened to be on the glass.
function nudgeReserve(tier, delta) {
  call('set_reserve', {
    event_id: state.eventId,
    property_id: tier.property_id,
    tier_code: tier.code,
    delta: delta,
  })
    .then(function (data) {
      var n = data.reserve;
      toast(shortName(tier) + ': ' +
        (n === 0 ? 'nothing held back now' :
          n + ' held for walk-ups'), 'good');
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); });
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
      return loadList(true);
    })
    .catch(function (err) { toast(err.message, 'bad'); })
    .finally(function () {
      delete state.busy['status'];
      renderStatus();
    });
}
