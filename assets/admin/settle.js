/* Talli Parking — gate screen: settle.js

   Settlement (plan B7), at the foot of the Sites page. Andrew's alone:
   every action it calls is operator-only in gate-ops.

   One night, one card per block:

     Takings   — by channel and payment type, less refunds.
     Split     — parking 30 / 20 / 50 (Talli, wardens, hosts), extras
                 10 / 90 (wardens, Talli), surcharges Talli's.
     Hosts     — each host's spaces provided and what they are owed,
                 with their email and payout notes, editable.
     Wardens   — the wardens' amount, split between people by Andrew.
                 Saved only when it adds up.
     Cash      — what each person collected in cash.
     Settle    — freezes the figures and the percentages; Reopen undoes it.

   Every figure is the database's (settlement_report). The page adds
   nothing up that matters: the one sum it does — what is left to
   allocate — is only a hint, and the server checks it again.
 */

import { asDate, button, call, el, make, money, state, text, toast } from './core.js';
import { dayKey, todayKey } from './night.js';
import { parseScope } from './scope.js';

var report = null;
var nightId = null;

var MEANINGS = {
  ALLOCATION_NOT_EQUAL: 'The wardens’ split must add up to the wardens’ amount.',
  NIGHT_NOT_CLOSED: 'Close the night on the Event tab before settling it.',
  NIGHT_SETTLED: 'This night is settled for that area. Reopen it to change anything.',
  NOT_SETTLED: 'That night is not settled.',
  SPLIT_NOT_100: 'Talli, wardens and hosts must add up to 100%.',
  BAD_PERCENT: 'Percentages are numbers from 0 to 100.',
  BAD_EMAIL: 'That is not an email address.',
  UNKNOWN_PERSON: 'One of those people is not on the books.',
};
function explain(err) {
  if (err && err.code && MEANINGS[err.code]) return MEANINGS[err.code];
  return String((err && err.message) || 'That did not work.').replace(/^[A-Z_]+:\s*/, '');
}

var CHANNEL = { online: 'Online', gate: 'Gate' };
var METHOD = {
  stripe: 'card', tap_to_pay: 'tap to pay', cash: 'cash', bank_transfer: 'bank transfer',
  free: 'free', other: 'other',
};

// Nights that have started, most recent first: the ones there is money to settle.
function settleNights() {
  var today = todayKey();
  return (state.events || [])
    .filter(function (ev) { return dayKey(ev.starts_at) <= today; })
    .slice()
    .reverse();
}

function box() { return el('ad-settle'); }

export function openSettle() {
  if (!state.who || !state.who.operator) { if (box()) box().hidden = true; return; }
  box().hidden = false;
  var nights = settleNights();
  if (!nights.some(function (n) { return n.id === nightId; })) {
    nightId = nights.length ? nights[0].id : null;
  }
  load();
}

// The selector at the top changed (plan B6): the same night, narrowed.
export function refillSettle() {
  if (report) render();
}

// Only the latest request may redraw: an earlier one landing late would
// wipe whatever is being typed into the wardens' split.
var loadSeq = 0;
function load() {
  var seq = ++loadSeq;
  if (!nightId) { report = null; render(); return Promise.resolve(); }
  var id = nightId;
  return call('settlement', { event_id: id })
    .then(function (res) { if (seq === loadSeq) { report = res; render(); } })
    .catch(function (err) { toast(explain(err), 'bad'); });
}

/* ------------------------------------------------------------ helpers */

function section(parent, title, note) {
  parent.appendChild(make('h2', 'ad-site-section', title));
  if (note) parent.appendChild(make('p', 'ad-site-help', note));
}
function row(parent, label, cents, sub, lead) {
  var r = make('div', 'ad-money-row' + (lead ? ' is-lead' : ''));
  var l = make('span', null, label);
  if (sub) l.appendChild(make('span', 'ad-money-sub', sub));
  r.appendChild(l);
  r.appendChild(make('strong', null, money(Number(cents) || 0)));
  parent.appendChild(r);
  return r;
}
function pct(bps) { return (Number(bps) / 100).toString() + '%'; }
function errorBox(parent) {
  var err = make('p', 'ad-sheet-error');
  err.hidden = true;
  parent.appendChild(err);
  return function (message) {
    if (message) { text(err, message); err.hidden = false; } else { err.hidden = true; }
  };
}
function dollarsInput(cents) {
  var i = document.createElement('input');
  i.type = 'number';
  i.inputMode = 'decimal';
  i.min = '0';
  i.step = '0.01';
  i.className = 'ad-input ad-num';
  i.value = cents == null ? '' : (Number(cents) / 100).toFixed(2);
  return i;
}
// Dollars typed into cents, or null when it is not an amount.
function toCents(v) {
  var s = String(v == null ? '' : v).trim();
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// The blocks the selector at the top is narrowed to (plan B6).
function blocksInScope() {
  var blocks = (report && report.blocks) || [];
  var s = parseScope(state.scope);
  if (!s || s.kind === 'all') return blocks;
  var mine = blocks.filter(function (b) {
    if (s.kind === 'block') return b.block_id === s.id;
    return (b.figures.hosts || []).some(function (h) {
      return (h.sites || []).some(function (x) { return x.property_id === s.id; });
    });
  });
  return mine.length ? mine : blocks;
}

/* ---------------------------------------------------------- rendering */

function render() {
  var b = box();
  if (!b) return;
  b.innerHTML = '';
  section(b, 'Settlement',
    'What each area took on a night, and who is owed what. Parking is split between Talli, ' +
    'the wardens and the hosts; each host’s part is by the spaces they provided, not by the cars.');

  var nights = settleNights();
  var pick = document.createElement('select');
  pick.className = 'ad-select';
  pick.id = 'ad-settle-night';
  pick.setAttribute('aria-label', 'Night to settle');
  if (!nights.length) {
    pick.appendChild(new Option('No nights yet', ''));
    pick.disabled = true;
  }
  nights.forEach(function (ev) {
    var tag = ev.status === 'closed' ? '' : ev.status === 'cancelled' ? ' (cancelled)' : ' (not closed)';
    pick.appendChild(new Option(asDate(ev.starts_at) + ' — ' + ev.name + tag, ev.id));
  });
  if (nightId) pick.value = nightId;
  pick.addEventListener('change', function () {
    if ((pick.value || null) === nightId) return;
    nightId = pick.value || null;
    load();
  });
  var wrap = make('div', 'ad-site-field');
  var lab = make('label', 'ad-label', 'Night');
  lab.htmlFor = pick.id;
  wrap.appendChild(lab);
  wrap.appendChild(pick);
  b.appendChild(wrap);

  if (!report || report.event_id !== nightId) return;
  var blocks = blocksInScope();
  if (!blocks.length) {
    b.appendChild(make('p', 'ad-site-help', 'Nothing sold or confirmed on this night.'));
  }
  blocks.forEach(function (blk) { b.appendChild(blockCard(blk)); });
  percentages(b);
}

function blockCard(blk) {
  var f = blk.figures || {};
  var card = make('div', 'ad-settle-block');
  card.dataset.block = blk.block_id;
  card.appendChild(make('h3', 'ad-settle-name', blk.name));

  var status = blk.settled
    ? 'Settled ' + asDate(blk.settled_at) + (blk.settled_by ? ' by ' + blk.settled_by : '') +
      '. These figures are frozen.'
    : 'Not settled.' + (blk.reopened_at ? ' Reopened ' + asDate(blk.reopened_at) +
      (blk.reopened_by ? ' by ' + blk.reopened_by : '') + '.' : '') +
      (f.spaces_source === 'snapshot' ? ' Spaces as they were when the night closed.'
        : ' Spaces as they stand — taken for good when the night is closed.');
  card.appendChild(make('p', 'ad-site-help ad-settle-status', status));
  if (blk.settled && blk.now_net_cents != null && Number(blk.now_net_cents) !== Number(f.net_cents)) {
    card.appendChild(make('p', 'ad-sheet-error',
      'The night’s takings have changed since it was settled (now ' + money(blk.now_net_cents) +
      '). Reopen and settle again to include it.'));
  }

  // Takings.
  var takings = make('div', 'ad-money');
  takings.appendChild(make('h4', 'ad-settle-h', 'Takings'));
  (f.takings || []).forEach(function (t) {
    row(takings, (CHANNEL[t.channel] || t.channel) + ', ' + (METHOD[t.payment_method] || t.payment_method),
      t.net_cents, t.bookings + ' booking' + (t.bookings === 1 ? '' : 's') +
      (Number(t.refund_cents) ? ' · ' + money(t.refund_cents) + ' refunded' : ''));
  });
  if (Number(f.refund_cents)) row(takings, 'Refunds', -Number(f.refund_cents));
  row(takings, 'Taken', f.net_cents, 'parking ' + money(f.parking_cents) + ' · extras ' +
    money(f.extras_cents) + ' · card surcharges ' + money(f.surcharge_cents), true);
  card.appendChild(takings);

  // The split.
  var pc = f.percent || {};
  var split = make('div', 'ad-money');
  split.appendChild(make('h4', 'ad-settle-h', 'Split'));
  row(split, 'Talli', f.talli_cents, pct(pc.talli_parking_bps) + ' of parking (' +
    money(f.parking_pool && f.parking_pool.talli_cents) + '), ' +
    pct(10000 - Number(pc.warden_extras_bps)) + ' of extras (' +
    money(f.extras_pool && f.extras_pool.talli_cents) + '), card surcharges (' +
    money(f.surcharge_cents) + ')');
  row(split, 'Wardens', f.wardens_cents, pct(pc.warden_parking_bps) + ' of parking (' +
    money(f.parking_pool && f.parking_pool.wardens_cents) + '), ' +
    pct(pc.warden_extras_bps) + ' of extras (' + money(f.extras_pool && f.extras_pool.wardens_cents) + ')');
  row(split, 'Hosts', f.hosts_cents, pct(pc.host_parking_bps) + ' of parking, by ' +
    f.spaces + ' space' + (Number(f.spaces) === 1 ? '' : 's') + ' provided');
  if (f.no_spaces) {
    split.appendChild(make('p', 'ad-sheet-error',
      'No site provided a space, so the hosts’ half stays with Talli.'));
  }
  card.appendChild(split);

  hostsSection(card, blk, f);
  wardensSection(card, blk, f);
  cashSection(card, f);
  settleButtons(card, blk);
  return card;
}

function hostsSection(card, blk, f) {
  var list = make('div', 'ad-money');
  list.appendChild(make('h4', 'ad-settle-h', 'Hosts'));
  (f.hosts || []).forEach(function (h) {
    var sites = (h.sites || []).map(function (s) {
      return s.name + ' ' + s.provided + (Number(s.lost) ? ' (' + s.confirmed + ' less ' + s.lost + ' lost)' : '');
    }).join(' · ');
    var r = row(list, h.name || 'Host', h.amount_cents,
      h.spaces + ' space' + (Number(h.spaces) === 1 ? '' : 's') + ' — ' + sites);
    r.classList.add('ad-settle-host');
    r.dataset.host = h.host_id;
    list.appendChild(hostDetails(h));
  });
  card.appendChild(list);
}

// Email, phone and payout notes, behind a toggle. Saved straight to the
// host; a settled night's figures keep the details they were settled with.
function hostDetails(h) {
  var wrap = make('div', 'ad-settle-hostinfo');
  var placeholder = /^host\+[0-9a-f]+@talli\.co\.nz$/i.test(h.email || '');
  wrap.appendChild(make('p', 'ad-site-help',
    (placeholder ? 'No email yet' : (h.email || 'No email')) +
    (h.payout_notes ? ' · ' + h.payout_notes : ' · no payout notes')));
  var form = make('div', 'ad-settle-hostform');
  form.hidden = true;
  var email = document.createElement('input');
  email.type = 'email';
  email.className = 'ad-input';
  email.value = placeholder ? '' : (h.email || '');
  email.placeholder = 'host@example.com';
  email.setAttribute('aria-label', 'Email for ' + h.name);
  var notes = document.createElement('textarea');
  notes.className = 'ad-input ad-site-notes-input';
  notes.rows = 2;
  notes.value = h.payout_notes || '';
  notes.placeholder = 'How they are paid: account, reference, who to ask';
  notes.setAttribute('aria-label', 'Payout notes for ' + h.name);
  form.appendChild(email);
  form.appendChild(notes);
  var say = errorBox(form);
  form.appendChild(button('btn btn-primary ad-site-save', 'Save ' + h.name + '’s details', function () {
    var details = { host_id: h.host_id, payout_notes: notes.value };
    if (email.value.trim()) details.email = email.value.trim();
    say(null);
    call('save_host_details', details)
      .then(function () { toast(h.name + ' saved', 'good'); load(); })
      .catch(function (e) { say(explain(e)); });
  }));
  wrap.appendChild(button('ad-link', 'Edit details', function () { form.hidden = !form.hidden; }));
  wrap.appendChild(form);
  return wrap;
}

function wardensSection(card, blk, f) {
  var w = make('div', 'ad-money ad-settle-wardens');
  w.appendChild(make('h4', 'ad-settle-h', 'Wardens — ' + money(f.wardens_cents)));
  var given = {};
  (blk.settled ? (f.allocation || []) : (blk.allocation || [])).forEach(function (a) {
    given[a.host_user_id] = Number(a.amount_cents);
  });
  var people = (blk.people || []).slice();
  // A settled night lists whoever it was settled with.
  Object.keys(given).forEach(function (id) {
    if (!people.some(function (p) { return p.host_user_id === id; })) {
      var a = (f.allocation || []).filter(function (x) { return x.host_user_id === id; })[0];
      people.push({ host_user_id: id, email: a ? a.email : id, worked: true });
    }
  });
  // Nothing saved yet and one person worked the block: they have it all.
  var worked = people.filter(function (p) { return p.worked; });
  if (!Object.keys(given).length && worked.length === 1) {
    given[worked[0].host_user_id] = Number(f.wardens_cents);
  }
  if (!people.length) {
    w.appendChild(make('p', 'ad-site-help', 'Nobody checked a car in or took money in this area.'));
  }
  w.appendChild(make('p', 'ad-site-help',
    'Listed: who checked a car in, took money or recorded a lost space here (first), then ' +
    'anyone with this area switched on.'));

  var inputs = [];
  var grid = make('div', 'ad-site-grid is-two');
  people.forEach(function (p) {
    var i = dollarsInput(given[p.host_user_id] || 0);
    i.disabled = blk.settled;
    i.setAttribute('aria-label', 'Amount for ' + p.email);
    inputs.push({ id: p.host_user_id, input: i });
    grid.appendChild(make('span', 'ad-site-type', p.email + (p.worked ? '' : ' (did not work it)')));
    grid.appendChild(i);
  });
  w.appendChild(grid);

  var left = make('p', 'ad-site-help ad-settle-left');
  function remaining() {
    var sum = 0;
    var bad = false;
    inputs.forEach(function (x) {
      var c = toCents(x.input.value);
      if (c === null) bad = true; else sum += c;
    });
    if (bad) return text(left, 'Amounts are dollars and cents.');
    var diff = Number(f.wardens_cents) - sum;
    text(left, diff === 0 ? 'Adds up.' : diff > 0 ? money(diff) + ' still to allocate.'
      : money(-diff) + ' too much allocated.');
  }
  inputs.forEach(function (x) { x.input.addEventListener('input', remaining); });
  remaining();
  w.appendChild(left);

  if (!blk.settled && people.length) {
    var say = errorBox(w);
    w.appendChild(button('btn btn-primary ad-site-save', 'Save wardens’ split', function () {
      var lines = [];
      var bad = false;
      inputs.forEach(function (x) {
        var c = toCents(x.input.value);
        if (c === null) bad = true;
        else if (c > 0) lines.push({ host_user_id: x.id, amount_cents: c });
      });
      if (bad) { say('Amounts are dollars and cents.'); return; }
      say(null);
      call('save_warden_allocation', { event_id: nightId, block_id: blk.block_id, lines: lines })
        .then(function () { toast('Wardens’ split saved', 'good'); load(); })
        .catch(function (e) { say(explain(e)); });
    }));
  } else if (blk.settled && blk.allocation && blk.allocation[0] && blk.allocation[0].set_by) {
    w.appendChild(make('p', 'ad-site-help', 'Split set by ' + blk.allocation[0].set_by + '.'));
  }
  card.appendChild(w);
}

function cashSection(card, f) {
  if (!(f.cash || []).length) return;
  var c = make('div', 'ad-money');
  c.appendChild(make('h4', 'ad-settle-h', 'Cash held'));
  f.cash.forEach(function (x) {
    row(c, x.email || 'Not recorded', x.cents, x.bookings + ' sale' + (x.bookings === 1 ? '' : 's'));
  });
  card.appendChild(c);
}

function settleButtons(card, blk) {
  var say = errorBox(card);
  if (blk.settled) {
    card.appendChild(button('btn ad-site-save', 'Reopen ' + blk.name, function () {
      if (!window.confirm('Reopen ' + blk.name + ' for this night? The figures will follow the night as it stands until you settle it again.')) return;
      call('reopen_settlement', { event_id: nightId, block_id: blk.block_id })
        .then(function () { toast(blk.name + ' reopened', 'good'); load(); })
        .catch(function (e) { say(explain(e)); });
    }));
    return;
  }
  var closed = report && (report.status === 'closed' || report.status === 'cancelled');
  if (!closed) {
    card.appendChild(make('p', 'ad-site-help',
      'Close the night on the Event tab to settle it. Until then these figures move with the night.'));
    return;
  }
  card.appendChild(button('btn btn-primary ad-site-save', 'Settle ' + blk.name, function () {
    if (!window.confirm('Settle ' + blk.name + '? The figures and the percentages are frozen as they are now.')) return;
    call('settle_night', { event_id: nightId, block_id: blk.block_id })
      .then(function () { toast(blk.name + ' settled', 'good'); load(); })
      .catch(function (e) { say(explain(e)); });
  }));
}

// The percentages. A settled night keeps the ones it was settled at.
function percentages(parent) {
  var s = (report && report.settings) || {};
  var p = make('div', 'ad-settle-percent');
  p.appendChild(make('h4', 'ad-settle-h', 'Percentages'));
  p.appendChild(make('p', 'ad-site-help',
    'For every night not yet settled. Parking: Talli, wardens and hosts add up to 100%. ' +
    'Extras: the wardens’ share; Talli has the rest. Card surcharges are always Talli’s.'));
  var grid = make('div', 'ad-site-grid is-two');
  var fields = [
    ['talli_parking_bps', 'Parking — Talli %'],
    ['warden_parking_bps', 'Parking — wardens %'],
    ['host_parking_bps', 'Parking — hosts %'],
    ['warden_extras_bps', 'Extras — wardens %'],
  ];
  var inputs = {};
  fields.forEach(function (fd) {
    var i = document.createElement('input');
    i.type = 'number';
    i.inputMode = 'decimal';
    i.min = '0';
    i.max = '100';
    i.step = '0.01';
    i.className = 'ad-input ad-num';
    i.value = s[fd[0]] == null ? '' : String(Number(s[fd[0]]) / 100);
    i.setAttribute('aria-label', fd[1]);
    inputs[fd[0]] = i;
    grid.appendChild(make('span', 'ad-site-type', fd[1]));
    grid.appendChild(i);
  });
  p.appendChild(grid);
  var say = errorBox(p);
  p.appendChild(button('btn btn-primary ad-site-save', 'Save percentages', function () {
    var body = {};
    var bad = false;
    fields.forEach(function (fd) {
      var v = Number(inputs[fd[0]].value);
      if (!Number.isFinite(v) || v < 0 || v > 100) bad = true;
      body[fd[0]] = Math.round(v * 100);
    });
    if (bad) { say(MEANINGS.BAD_PERCENT); return; }
    say(null);
    call('save_settlement_setting', body)
      .then(function () { toast('Percentages saved', 'good'); load(); })
      .catch(function (e) { say(explain(e)); });
  }));
  parent.appendChild(p);
}
