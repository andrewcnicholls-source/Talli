/* =====================================================================
   Talli Parking — gate screen

   Built for one hand, outdoors, at night. The list is the page: search by
   the first few characters of a plate, tap the row, the car is ticked off.
   Everything else is secondary.

   Three things sit behind a second tap rather than on the row itself,
   because none of them can be undone by tapping again: sending a car to
   somebody else's address, giving money back, and cancelling a booking.
   Those live in the ⋯ sheet, and the last two ask for the passphrase a
   second time, typed there and then.

   All reads and writes go through the gate-ops edge function, which holds
   the passphrase check and the service-role credentials. Nothing here can
   reach the database on its own.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var FN = CFG.supabaseUrl + '/functions/v1/gate-ops';
  var TZ = 'Pacific/Auckland';
  var KEY = 'talli.gate.pass';
  var REFRESH_MS = 30000;

  var state = {
    pass: sessionStorage.getItem(KEY) || '',
    events: [],
    eventId: null,
    rows: [],
    sites: [],
    tiers: [],
    filter: '',
    busy: {},
    // The booking the ⋯ sheet is about, and whether the cancel screen has
    // been asked once already.
    picked: null,
    cancelArmed: false,
    // Which screen is showing, and prices typed but not yet saved.
    tab: 'gate',
    priceDrafts: {},
    // The rung the publish ladder is waiting for a second tap on.
    pubArmed: null,
    summary: null,
  };

  function el(id) { return document.getElementById(id); }
  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }
  function text(n, v) { if (n) n.textContent = v; return n; }

  function money(cents) {
    var d = (cents || 0) / 100;
    return '$' + (cents % 100 === 0 ? d.toFixed(0) : d.toFixed(2));
  }
  function asTime(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString('en-NZ', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
      .replace(/\s/g, '').toLowerCase();
  }
  function asDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString('en-NZ', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function who(r) { return r.vehicle_rego || r.customer_name || 'this car'; }
  function paidCents(r) { return (r.amount_cents || 0) + (r.addons_cents || 0); }

  function make(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* ---------------------------------------------------------- transport */

  function call(action, params) {
    var body = Object.assign({ passphrase: state.pass, action: action }, params || {});
    return fetch(FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.code = data.code;
          throw err;
        }
        return data;
      });
    });
  }

  function toast(message, kind) {
    var t = el('ad-toast');
    t.textContent = message;
    t.className = 'ad-toast' + (kind ? ' is-' + kind : '');
    show(t);
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { hide(t); }, 3500);
  }

  /* ------------------------------------------------------------- unlock */

  function unlock(e) {
    e.preventDefault();
    var input = el('ad-pass');
    state.pass = input.value;
    el('ad-unlock-error').hidden = true;

    call('events').then(function (data) {
      sessionStorage.setItem(KEY, state.pass);
      state.events = data.events || [];
      hide(el('ad-lock'));
      show(el('ad-app'));
      renderEvents();
    }).catch(function (err) {
      state.pass = '';
      sessionStorage.removeItem(KEY);
      var box = el('ad-unlock-error');
      box.textContent = err.message;
      show(box);
    });
  }

  /* ------------------------------------------------------------- events */

  function fillEventSelect() {
    var sel = el('ad-event');
    sel.innerHTML = '';
    if (!state.events.length) {
      sel.appendChild(new Option('No events yet', ''));
      return false;
    }
    state.events.forEach(function (ev) {
      var label = asDate(ev.starts_at) + ' — ' + ev.name +
        (ev.status !== 'on_sale' ? ' (' + ev.status + ')' : '');
      sel.appendChild(new Option(label, ev.id));
    });
    return true;
  }

  // After publishing, the fixture's own label changes. Redraw the list
  // without moving off the event being worked on.
  function refreshEvents() {
    return call('events').then(function (data) {
      state.events = data.events || [];
      fillEventSelect();
      el('ad-event').value = state.eventId;
      renderPrices();
    });
  }

  function renderEvents() {
    if (!fillEventSelect()) return;
    var sel = el('ad-event');

    // Default to the next event that has not finished yet; that is almost
    // always the one being worked.
    var now = Date.now();
    var next = state.events.filter(function (e) { return new Date(e.starts_at) > now; })[0];
    state.eventId = (next || state.events[state.events.length - 1]).id;
    sel.value = state.eventId;
    loadList();
  }

  /* --------------------------------------------------------- the list */

  function loadList(quiet) {
    if (!state.eventId) return;
    if (!quiet) el('ad-list').setAttribute('aria-busy', 'true');

    return call('list', { event_id: state.eventId })
      .then(function (data) {
        state.rows = data.rows || [];
        state.sites = data.sites || [];
        state.tiers = data.tiers || [];
        state.summary = data.summary || null;
        renderSummary(data.summary);
        renderOverflow();
        renderList();
        renderPrices();
        // The sheet is showing a booking that has just been re-read; keep it
        // honest rather than leaving a stale card open.
        if (state.picked) {
          var fresh = state.rows.filter(function (r) {
            return r.booking_id === state.picked.booking_id;
          })[0];
          if (fresh && el('ad-actions').hidden === false) openActions(fresh);
        }
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () { el('ad-list').removeAttribute('aria-busy'); });
  }

  function renderSummary(s) {
    if (!s) return;
    el('ad-stat-arrived').textContent = s.arrived + '/' + s.total;
    el('ad-stat-taken').textContent = money(s.taken_cents);
    el('ad-stat-due').textContent = money(s.cash_due_cents);

    var holds = el('ad-holds');
    if (s.unpaid_holds > 0) {
      holds.textContent = s.unpaid_holds + ' unpaid hold' + (s.unpaid_holds === 1 ? '' : 's') +
        ' — these are people mid-checkout, not confirmed bookings.';
      show(holds);
    } else {
      hide(holds);
    }
  }

  function matches(row) {
    if (!state.filter) return true;
    var f = state.filter.toLowerCase();
    return [row.vehicle_rego, row.customer_name, row.customer_phone, row.bay_label]
      .some(function (v) { return v && String(v).toLowerCase().indexOf(f) > -1; });
  }

  function renderList() {
    var list = el('ad-list');
    list.innerHTML = '';

    // Cars already sent elsewhere are not going to turn in here. They live in
    // the overflow section instead, where they can be brought back.
    var rows = state.rows.filter(function (r) {
      return r.status !== 'transferred' && matches(r);
    });

    if (!rows.length) {
      list.appendChild(make('p', 'ad-empty',
        state.rows.length ? 'Nothing matches that.' : 'No bookings for this event yet.'));
      return;
    }

    rows.forEach(function (r) { list.appendChild(rowCard(r)); });
  }

  function rowCard(r) {
    var card = make('div', 'ad-row' + (r.arrived ? ' is-arrived' : '') +
      (r.status === 'held' ? ' is-held' : ''));

    var main = make('div', 'ad-row-main');

    var top = make('div', 'ad-row-top');
    top.appendChild(make('span', 'ad-rego', r.vehicle_rego || '— no plate —'));
    if (r.bay_label) top.appendChild(make('span', 'ad-bay', r.bay_label));
    main.appendChild(top);

    var line = [r.customer_name, r.customer_phone].filter(Boolean).join(' · ');
    if (line) main.appendChild(make('div', 'ad-who', line));

    var meta = make('div', 'ad-meta');
    if (r.tier_code) meta.appendChild(make('span', 'ad-chip', r.tier_code.replace(/_/g, ' ')));
    if (r.arrival_from && r.arrival_until) {
      meta.appendChild(make('span', 'ad-chip', asTime(r.arrival_from) + '–' + asTime(r.arrival_until)));
    }
    // This car is blocking someone in. The chip is a reminder to chase them if
    // they are not back, not a curfew on the customer.
    if (r.must_depart_by) {
      meta.appendChild(make('span', 'ad-chip is-warn',
        'back by ' + asTime(r.must_depart_by)));
    }
    if (r.payment_method && r.payment_method !== 'stripe') {
      meta.appendChild(make('span', 'ad-chip is-cash', r.payment_method + ' ' + money(r.amount_cents)));
    }
    if (r.status === 'held') meta.appendChild(make('span', 'ad-chip is-warn', 'unpaid hold'));
    // Two different facts, and they are worth keeping apart. One says the car
    // is on the grass right now; the other only says they would not mind.
    if (r.in_consent_zone) {
      meta.appendChild(make('span', 'ad-chip is-over', 'in overflow'));
    } else if (r.accepts_street_parking && r.channel === 'online') {
      meta.appendChild(make('span', 'ad-chip', 'overflow ok'));
    }
    main.appendChild(meta);

    card.appendChild(main);

    var actions = make('div', 'ad-row-actions');

    var btn = make('button', 'ad-tick' + (r.arrived ? ' is-on' : ''),
      r.arrived ? 'Here' : 'Tick in');
    btn.type = 'button';
    btn.disabled = !!state.busy[r.booking_id];
    btn.addEventListener('click', function () { toggleArrived(r, btn); });
    actions.appendChild(btn);

    // Everything that is not "wave them in" is one tap further away.
    var more = make('button', 'ad-more', '⋯');
    more.type = 'button';
    more.title = 'Move, send elsewhere, or cancel';
    more.setAttribute('aria-label', 'More for ' + who(r));
    more.addEventListener('click', function () { openActions(r); });
    actions.appendChild(more);

    card.appendChild(actions);

    return card;
  }

  // Moving a prepaid car out to the verge puts its bay back on sale. That is
  // the point: when there is a queue at the gate, a Standard sitting in the
  // back yard is worth more to you parked on the overflow.
  //
  // This is our own grass. Handing the car to another address is a transfer,
  // further down, and that is a different conversation.
  function moveToOverflow(r, btn) {
    var name = who(r);

    function go(confirmedConsent) {
      state.busy[r.booking_id] = true;
      if (btn) btn.disabled = true;
      call('move_to_overflow', {
        booking_id: r.booking_id,
        confirmed_consent: confirmedConsent === true,
      })
        .then(function (data) {
          hide(el('ad-actions'));
          toast(name + ' moved to ' + (data.moved_to || 'overflow'), 'good');
          return loadList(true);
        })
        .catch(function (err) {
          if (err.code === 'NEEDS_CONSENT' || /did not agree/.test(err.message)) {
            if (window.confirm(
              name + ' did not tick the overflow box when booking.\n\n' +
              'Have they agreed to it just now?'
            )) {
              go(true);
              return;
            }
            return;
          }
          toast(err.message, 'bad');
        })
        .finally(function () {
          delete state.busy[r.booking_id];
          if (btn) btn.disabled = false;
        });
    }

    go(false);
  }

  function toggleArrived(r, btn) {
    var action = r.arrived ? 'undo_check_in' : 'check_in';
    state.busy[r.booking_id] = true;
    btn.disabled = true;

    call(action, { booking_id: r.booking_id })
      .then(function () {
        r.arrived = !r.arrived;
        toast(who(r) + (r.arrived ? ' ticked in' : ' un-ticked'), 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () {
        delete state.busy[r.booking_id];
        btn.disabled = false;
      });
  }

  /* -------------------------------------------------- overflow & referrals */

  // The separate section. A site is somewhere we do NOT hold bays for: we
  // hand the car over, they decide where it goes, and each one is capped by
  // what that address agreed to take tonight.
  function renderOverflow() {
    var wrap = el('ad-over');
    if (!state.sites.length) { hide(wrap); return; }
    show(wrap);

    var open = state.sites.filter(function (s) { return s.open; });
    var left = open.reduce(function (n, s) { return n + s.spots_left; }, 0);
    var sent = state.rows.filter(function (r) { return r.status === 'transferred'; });

    text(el('ad-over-badge'),
      left + ' free' + (sent.length ? ' · ' + plural(sent.length, 'car') + ' sent' : ''));

    var box = el('ad-over-sites');
    box.innerHTML = '';
    state.sites.forEach(function (s) { box.appendChild(siteCard(s)); });

    var sentBox = el('ad-over-sent');
    sentBox.innerHTML = '';
    if (sent.length) {
      sentBox.appendChild(make('h3', 'ad-over-sub', 'Sent tonight'));
      sent.forEach(function (r) { sentBox.appendChild(sentCard(r)); });
    }
  }

  function siteCard(s) {
    var card = make('div', 'ad-site' + (s.open ? '' : ' is-shut'));

    var top = make('div', 'ad-site-top');
    top.appendChild(make('span', 'ad-site-name', s.name));

    var toggle = make('button', 'ad-site-open' + (s.open ? ' is-on' : ''),
      s.open ? 'Taking cars' : 'Closed');
    toggle.type = 'button';
    toggle.addEventListener('click', function () {
      setLimit(s, { open: !s.open }, toggle);
    });
    top.appendChild(toggle);
    card.appendChild(top);

    var meta = make('div', 'ad-meta');
    if (s.walk_minutes != null) meta.appendChild(make('span', 'ad-chip', s.walk_minutes + ' min walk'));
    if (s.their_price_cents != null) {
      meta.appendChild(make('span', 'ad-chip', money(s.their_price_cents) + ' there'));
    }
    meta.appendChild(make('span', 'ad-chip' + (s.referral_fee_cents ? ' is-cash' : ''),
      s.customer_pays_site
        ? (s.referral_fee_cents ? money(s.referral_fee_cents) + ' to us' : 'they keep it')
        : 'we keep the money'));
    card.appendChild(meta);

    if (s.address) card.appendChild(make('div', 'ad-site-address', s.address));

    var limit = make('div', 'ad-site-limit');

    var down = make('button', 'ad-step', '−');
    down.type = 'button';
    down.disabled = s.spots <= s.sent;
    down.title = 'One fewer car tonight';
    down.addEventListener('click', function () { setLimit(s, { spots: s.spots - 1 }, down); });

    var count = make('span', 'ad-site-count', s.sent + ' of ' + s.spots + ' sent');

    var up = make('button', 'ad-step', '+');
    up.type = 'button';
    up.title = 'One more car tonight';
    up.addEventListener('click', function () { setLimit(s, { spots: s.spots + 1 }, up); });

    limit.appendChild(down);
    limit.appendChild(count);
    limit.appendChild(up);
    card.appendChild(limit);

    return card;
  }

  function sentCard(r) {
    var card = make('div', 'ad-sent');

    var main = make('div', 'ad-row-main');
    main.appendChild(make('div', 'ad-rego', r.vehicle_rego || r.customer_name || '— no plate —'));
    var meta = make('div', 'ad-meta');
    meta.appendChild(make('span', 'ad-chip is-over', r.transfer_site_name || 'overflow'));
    if (r.transferred_at) meta.appendChild(make('span', 'ad-chip', asTime(r.transferred_at)));
    if (r.transfer_refund_cents) {
      meta.appendChild(make('span', 'ad-chip is-cash', money(r.transfer_refund_cents) + ' back'));
    }
    main.appendChild(meta);
    card.appendChild(main);

    var back = make('button', 'ad-move', 'Bring back');
    back.type = 'button';
    back.disabled = !!state.busy[r.booking_id];
    back.addEventListener('click', function () { undoTransfer(r, back); });
    card.appendChild(back);

    return card;
  }

  // Tonight only. The standing arrangement with that address does not move
  // because somebody had people over on a Saturday.
  function setLimit(s, change, btn) {
    var params = Object.assign({ event_id: state.eventId, site_id: s.site_id }, change);
    if (params.spots != null && params.spots < 0) return;
    btn.disabled = true;
    call('set_overflow_limit', params)
      .then(function () { return loadList(true); })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () { btn.disabled = false; });
  }

  function undoTransfer(r, btn) {
    state.busy[r.booking_id] = true;
    btn.disabled = true;
    call('undo_transfer', { booking_id: r.booking_id })
      .then(function (data) {
        toast(data.unplaced
          ? who(r) + ' is back, but there is no bay free for them'
          : who(r) + ' is back in ' + data.bay_label, data.unplaced ? 'bad' : 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () {
        delete state.busy[r.booking_id];
        btn.disabled = false;
      });
  }

  /* ---------------------------------------------------- one booking, close */

  function fact(label, value, cls) {
    var row = make('div', 'ad-fact' + (cls ? ' ' + cls : ''));
    row.appendChild(make('span', 'ad-fact-key', label));
    row.appendChild(make('span', 'ad-fact-val', value));
    return row;
  }

  function openActions(r) {
    state.picked = r;

    text(el('ad-act-title'), r.vehicle_rego || r.customer_name || 'Booking');

    var facts = el('ad-act-facts');
    facts.innerHTML = '';
    if (r.customer_name) facts.appendChild(fact('Name', r.customer_name));
    if (r.customer_phone) facts.appendChild(fact('Phone', r.customer_phone));
    facts.appendChild(fact('Spot', (r.tier_code || '—').replace(/_/g, ' ') +
      (r.bay_label ? ' · ' + r.bay_label : '') + (r.zone_label ? ' · ' + r.zone_label : '')));
    facts.appendChild(fact('Paid', money(paidCents(r)) + ' · ' +
      String(r.payment_method || '').replace(/_/g, ' ')));

    // The distinction the whole overflow idea rests on. Being willing is not
    // the same as being parked there, and neither is the same as having been
    // sent to someone else's address.
    facts.appendChild(fact('Overflow',
      r.accepts_street_parking ? 'Happy to go in an overflow area'
        : 'Has not agreed to an overflow area',
      r.accepts_street_parking ? '' : 'is-quiet'));
    facts.appendChild(fact('Right now',
      r.status === 'transferred'
        ? 'Sent to ' + (r.transfer_site_name || 'another area')
        : r.in_consent_zone ? 'Parked in ' + (r.zone_label || 'an overflow area')
          : r.bay_label ? 'In the yard' : 'No bay held'));

    var buttons = el('ad-act-buttons');
    buttons.innerHTML = '';

    if (r.status === 'transferred') {
      var back = make('button', 'btn btn-outline', 'Bring them back here');
      back.type = 'button';
      back.addEventListener('click', function () {
        hide(el('ad-actions'));
        undoTransfer(r, back);
      });
      buttons.appendChild(back);
    } else {
      // Valet holds keys, so those cars are already movable by hand. Anything
      // already out on the verge has nowhere further to go.
      if (!r.in_consent_zone && r.tier_code !== 'valet') {
        var move = make('button', 'btn btn-outline', 'Move to our overflow');
        move.type = 'button';
        move.addEventListener('click', function () { moveToOverflow(r, move); });
        buttons.appendChild(move);
      }

      var away = make('button', 'btn btn-outline', 'Send to another area…');
      away.type = 'button';
      away.addEventListener('click', function () { openTransfer(r); });
      buttons.appendChild(away);
    }

    var kill = make('button', 'ad-link is-danger', 'Cancel this booking…');
    kill.type = 'button';
    kill.addEventListener('click', function () { openCancel(r); });
    buttons.appendChild(kill);

    show(el('ad-actions'));
  }

  /* ------------------------------------------------ send them somewhere else */

  function siteById(id) {
    return state.sites.filter(function (s) { return s.site_id === id; })[0];
  }

  function openTransfer(r) {
    state.picked = r;
    hide(el('ad-actions'));

    el('ad-transfer-form').reset();
    hide(el('ad-tr-error'));
    hide(el('ad-tr-pass-row'));

    text(el('ad-tr-who'), who(r) + ' — ' + money(paidCents(r)) + ' paid here.');

    var sel = el('ad-tr-site');
    sel.innerHTML = '';
    var usable = 0;
    state.sites.forEach(function (s) {
      var shut = !s.open || s.spots_left <= 0;
      var opt = new Option(
        s.name + (shut ? (s.open ? ' (full)' : ' (closed)') : ' — ' + s.spots_left + ' free'),
        s.site_id);
      opt.disabled = shut;
      if (!shut) usable++;
      sel.appendChild(opt);
    });

    // Whatever they ticked when booking was about OUR grass. Going to a
    // different address is a fresh question, every time.
    text(el('ad-tr-consent-label'), r.accepts_street_parking
      ? 'They said yes to an overflow spot — and yes to this address just now'
      : 'They have agreed to park at this address just now');

    var first = state.sites.filter(function (s) { return s.open && s.spots_left > 0; })[0];
    if (first) sel.value = first.site_id;
    describeSite();

    el('ad-tr-submit').disabled = usable === 0;
    if (!usable) {
      var box = el('ad-tr-error');
      text(box, 'Nowhere is taking cars tonight. Open a site or lift a limit first.');
      show(box);
    }

    show(el('ad-transfer'));
  }

  function describeSite() {
    var s = siteById(el('ad-tr-site').value);
    var r = state.picked;
    if (!s || !r) return;

    var bits = [];
    if (s.address) bits.push(s.address);
    if (s.walk_minutes != null) bits.push(s.walk_minutes + ' min walk');
    if (s.their_price_cents != null) bits.push(money(s.their_price_cents) + ' to pay there');
    if (s.referral_fee_cents) bits.push(money(s.referral_fee_cents) + ' back to us');
    text(el('ad-tr-detail'), bits.join(' · '));

    // Where they pay at the other gate, what they paid here normally goes
    // back. Where we run the place ourselves, it does not.
    var row = el('ad-tr-refund-row');
    var box = el('ad-tr-refund');
    if (paidCents(r) <= 0) {
      hide(row);
      box.checked = false;
    } else {
      show(row);
      box.checked = !!s.customer_pays_site;
      text(el('ad-tr-refund-label'), r.refundable_by_card
        ? 'Put ' + money(paidCents(r)) + ' back on their card'
        : 'Hand back the ' + money(paidCents(r)) + ' they paid');
    }
    refundToggled();
  }

  function refundToggled() {
    var wants = el('ad-tr-refund').checked && !el('ad-tr-refund-row').hidden;
    if (wants) { show(el('ad-tr-pass-row')); } else { hide(el('ad-tr-pass-row')); }
  }

  function submitTransfer(e) {
    e.preventDefault();
    var r = state.picked;
    if (!r) return;

    var box = el('ad-tr-error');
    hide(box);

    if (!el('ad-tr-consent').checked) {
      text(box, 'Ask them first, then tick the box.');
      show(box);
      return;
    }

    var refund = el('ad-tr-refund').checked && !el('ad-tr-refund-row').hidden;
    var pass = el('ad-tr-pass').value;
    if (refund && !pass) {
      text(box, 'Money is going back, so the passphrase is needed again.');
      show(box);
      return;
    }

    var btn = el('ad-tr-submit');
    btn.disabled = true;

    call('transfer', {
      event_id: state.eventId,
      booking_id: r.booking_id,
      site_id: el('ad-tr-site').value,
      reason: el('ad-tr-reason').value.trim() || null,
      confirmed_consent: true,
      refund: refund,
      confirm: refund ? true : undefined,
      confirm_passphrase: refund ? pass : undefined,
    })
      .then(function (data) {
        hide(el('ad-transfer'));
        state.picked = null;
        var tail = data.refunded_cents
          ? ' · ' + money(data.refunded_cents) + (data.refund_by_hand ? ' to hand back' : ' refunded')
          : '';
        toast(who(r) + ' sent to ' + data.site + tail, 'good');
        return loadList(true);
      })
      .catch(function (err) {
        text(box, err.code === 'REAUTH_REQUIRED' ? 'That passphrase did not match.' : err.message);
        show(box);
      })
      .finally(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------------ cancelling */

  function openCancel(r) {
    state.picked = r;
    state.cancelArmed = false;
    hide(el('ad-actions'));

    el('ad-cancel-form').reset();
    hide(el('ad-cx-error'));
    hide(el('ad-cx-confirm'));
    hide(el('ad-cx-back'));
    text(el('ad-cx-submit'), 'Cancel the booking');

    text(el('ad-cx-who'), who(r) + ' — ' + (r.tier_code || '').replace(/_/g, ' ') +
      (r.bay_label ? ' in ' + r.bay_label : '') + ', ' + money(paidCents(r)) + ' paid.');

    var row = el('ad-cx-refund').parentNode;
    if (paidCents(r) > 0) {
      row.hidden = false;
      el('ad-cx-refund').checked = true;
      text(el('ad-cx-refund-label'), r.refundable_by_card
        ? 'Put ' + money(paidCents(r)) + ' back on their card'
        : 'Hand back the ' + money(paidCents(r)) + ' they paid');
    } else {
      row.hidden = true;
      el('ad-cx-refund').checked = false;
    }

    show(el('ad-cancel'));
  }

  function submitCancel(e) {
    e.preventDefault();
    var r = state.picked;
    if (!r) return;

    var box = el('ad-cx-error');
    hide(box);

    var pass = el('ad-cx-pass').value;
    if (!pass) {
      text(box, 'The passphrase is needed to cancel.');
      show(box);
      return;
    }

    // First press only arms it. Nobody cancels a booking on one tap.
    if (!state.cancelArmed) {
      state.cancelArmed = true;
      show(el('ad-cx-confirm'));
      show(el('ad-cx-back'));
      text(el('ad-cx-submit'), 'Yes, cancel it');
      return;
    }

    var btn = el('ad-cx-submit');
    btn.disabled = true;

    var reason = el('ad-cx-reason').value;
    var note = el('ad-cx-note').value.trim();

    call('cancel_booking', {
      event_id: state.eventId,
      booking_id: r.booking_id,
      reason: reason,
      note: note || null,
      refund: el('ad-cx-refund').checked && paidCents(r) > 0,
      confirm: true,
      confirm_passphrase: pass,
    })
      .then(function (data) {
        hide(el('ad-cancel'));
        state.picked = null;
        state.cancelArmed = false;
        var tail = data.refunded_cents
          ? ' · ' + money(data.refunded_cents) + (data.refund_by_hand ? ' to hand back' : ' refunded')
          : '';
        toast(who(r) + ' cancelled' + tail, 'good');
        return loadList(true);
      })
      .catch(function (err) {
        state.cancelArmed = false;
        hide(el('ad-cx-confirm'));
        hide(el('ad-cx-back'));
        text(el('ad-cx-submit'), 'Cancel the booking');
        text(box, err.code === 'REAUTH_REQUIRED' ? 'That passphrase did not match.' : err.message);
        show(box);
      })
      .finally(function () { btn.disabled = false; });
  }

  function standDownCancel() {
    state.cancelArmed = false;
    hide(el('ad-cancel'));
  }

  /* -------------------------------------------------------------- prices */

  // What a space costs, per tier, for the event in the header. The website
  // reads these straight out of the database, so saving here is publishing.
  //
  // Typed prices are held as drafts until Save, for two reasons: a price is
  // worth reading back before it goes live, and the list behind this screen
  // reloads itself every 30 seconds — which would otherwise wipe a number
  // half-entered in the rain.

  function dollars(cents) {
    var d = (cents || 0) / 100;
    return cents % 100 === 0 ? String(d) : d.toFixed(2);
  }

  function draftFor(t) {
    return Object.prototype.hasOwnProperty.call(state.priceDrafts, t.code)
      ? state.priceDrafts[t.code]
      : dollars(t.price_cents);
  }

  function dirtyTiers() {
    return state.tiers.filter(function (t) {
      return Object.prototype.hasOwnProperty.call(state.priceDrafts, t.code) &&
        state.priceDrafts[t.code] !== dollars(t.price_cents);
    });
  }

  function currentEvent() {
    return state.events.filter(function (e) { return e.id === state.eventId; })[0];
  }

  // The four rungs, in the order they are climbed, each described by what it
  // does to the page a customer is looking at rather than by its name in the
  // database. 'cancelled' is not here on purpose — calling a fixture off
  // strands everyone who has paid, and that is a phone call, not a button.
  var LADDER = [
    { status: 'draft', label: 'Hidden',
      says: 'Nobody outside can see this fixture at all.' },
    { status: 'announced', label: 'Taking names',
      says: 'Listed but not bookable. People can leave an email to be told when it opens.' },
    { status: 'on_sale', label: 'On sale',
      says: 'Anyone can book it on the website, right now.' },
    { status: 'closed', label: 'Closed',
      says: 'Off the list. No new bookings online. Bookings already taken stand.' },
  ];

  function rung(status) {
    return LADDER.filter(function (r) { return r.status === status; })[0];
  }

  function renderPublish() {
    var ev = currentEvent();
    var ladder = el('ad-pub-ladder');
    ladder.innerHTML = '';

    var live = el('ad-price-live');
    if (!ev) {
      text(live, 'No event chosen.');
      live.className = 'ad-price-live';
      hide(el('ad-pub-confirm'));
      return;
    }

    LADDER.forEach(function (r) {
      var on = ev.status === r.status;
      var btn = make('button', 'ad-pub-rung' +
        (on ? ' is-on' : '') + (state.pubArmed === r.status ? ' is-armed' : ''), r.label);
      btn.type = 'button';
      btn.addEventListener('click', function () { climbTo(r, ev); });
      ladder.appendChild(btn);
    });

    var here = rung(ev.status);
    text(live, here
      ? here.says
      : 'This fixture is ' + ev.status.replace(/_/g, ' ') + '.');
    live.className = 'ad-price-live' + (ev.status === 'on_sale' ? '' : ' is-warn');

    // Armed state does not survive a redraw of a different event.
    if (state.pubArmed && state.pubArmed === ev.status) state.pubArmed = null;
    if (!state.pubArmed) hide(el('ad-pub-confirm'));

    renderCutOff(ev);
  }

  function climbTo(r, ev) {
    if (ev.status === r.status) {           // already there
      state.pubArmed = null;
      renderPublish();
      return;
    }

    if (state.pubArmed !== r.status) {      // first tap only arms it
      state.pubArmed = r.status;
      var warn = '';
      // Taking a fixture off the website does not take anybody's space away,
      // and saying so stops that being a worry at the wrong moment.
      if ((r.status === 'draft' || r.status === 'closed') &&
          state.summary && state.summary.total > 0) {
        warn = ' ' + plural(state.summary.total, 'car') + ' already booked — they keep their spaces.';
      }
      text(el('ad-pub-confirm'), r.says + warn + ' Tap ' + r.label + ' again.');
      show(el('ad-pub-confirm'));
      renderPublish();
      return;
    }

    state.pubArmed = null;
    call('set_event_status', { event_id: state.eventId, status: r.status })
      .then(function () {
        toast(r.status === 'on_sale' ? 'On sale — it is bookable now' : 'Now ' + r.label.toLowerCase(), 'good');
        return refreshEvents();
      })
      .catch(function (err) {
        toast(err.code === 'NOTHING_TO_SELL'
          ? 'No spots are set up for this fixture yet'
          : err.message, 'bad');
        renderPublish();
      });
  }

  // The other half of the same question, and the one that gets used at 5pm:
  // stop selling online, we are gate-only from here.
  function renderCutOff(ev) {
    var at = ev.online_sales_close_at ? new Date(ev.online_sales_close_at) : null;
    var now = Date.now();

    text(el('ad-pub-cut-now'), !at
      ? 'No cut-off — open until sold out.'
      : (at.getTime() <= now
          ? 'Stopped ' + asTime(ev.online_sales_close_at) + ' — online booking is closed.'
          : 'Stops ' + asTime(ev.online_sales_close_at) + ' on ' + asDate(ev.online_sales_close_at) + '.'));

    var start = new Date(ev.starts_at).getTime();
    var options = [
      { label: 'Stop now', at: new Date().toISOString(),
        said: 'Online sales stopped — gate only from here' },
      { label: '2h before', at: new Date(start - 2 * 3600 * 1000).toISOString(),
        said: 'Online sales stop two hours before kick-off' },
      { label: 'At kick-off', at: new Date(start).toISOString(),
        said: 'Online sales stop at kick-off' },
      { label: 'No cut-off', at: null,
        said: 'Online sales open again' },
    ];

    var box = el('ad-pub-cuts');
    box.innerHTML = '';
    options.forEach(function (o) {
      var btn = make('button', 'ad-pub-cut-btn', o.label);
      btn.type = 'button';
      btn.addEventListener('click', function () { setCutOff(o, btn); });
      box.appendChild(btn);
    });
  }

  function setCutOff(o, btn) {
    btn.disabled = true;
    call('set_sales_close', { event_id: state.eventId, at: o.at })
      .then(function () {
        toast(o.said, 'good');
        return refreshEvents();
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () { btn.disabled = false; });
  }

  function renderPrices() {
    var box = el('ad-prices');
    if (!box) return;

    var ev = currentEvent();
    text(el('ad-price-when'), ev
      ? asDate(ev.starts_at) + ' — ' + ev.name
      : 'No event chosen');

    renderPublish();
    renderCopyFrom();

    // Never rebuild over the top of someone typing.
    if (dirtyTiers().length) { renderPriceFooter(); return; }

    box.innerHTML = '';
    if (!state.tiers.length) {
      box.appendChild(make('p', 'ad-empty', 'No tiers set up for this event.'));
      renderPriceFooter();
      return;
    }
    state.tiers.forEach(function (t) { box.appendChild(priceRow(t)); });
    renderPriceFooter();
  }

  function priceRow(t) {
    var row = make('div', 'ad-price');

    var main = make('div', 'ad-price-main');
    // Labels read as "Standard — best value, expect to wait". The first half
    // is the name; the rest is sales copy nobody needs at 6pm.
    main.appendChild(make('span', 'ad-price-name',
      String(t.label || t.code).split(/\s+—\s+/)[0]));

    var meta = make('div', 'ad-meta');
    meta.appendChild(make('span', 'ad-chip', t.spots_left + ' online'));
    meta.appendChild(make('span', 'ad-chip', t.spots_left_gate + ' at the gate'));
    if (t.price_updated_at) {
      meta.appendChild(make('span', 'ad-chip', 'changed ' + asTime(t.price_updated_at)));
    }
    main.appendChild(meta);
    row.appendChild(main);

    var edit = make('div', 'ad-price-edit');
    edit.appendChild(make('span', 'ad-price-sign', '$'));

    var input = make('input', 'ad-price-input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = draftFor(t);
    input.setAttribute('aria-label', 'Price for ' + t.code);
    input.addEventListener('input', function () {
      state.priceDrafts[t.code] = this.value.trim();
      row.classList.toggle('is-dirty', this.value.trim() !== dollars(t.price_cents));
      renderPriceFooter();
    });
    edit.appendChild(input);

    // Called by eye, ahead of the bay maths, and reversible in one tap.
    var out = make('button', 'ad-price-out' + (t.manually_sold_out ? ' is-on' : ''),
      t.manually_sold_out ? 'Sold out' : 'On sale');
    out.type = 'button';
    out.addEventListener('click', function () { toggleSoldOut(t, out); });
    edit.appendChild(out);

    row.appendChild(edit);
    if (draftFor(t) !== dollars(t.price_cents)) row.classList.add('is-dirty');

    return row;
  }

  function renderPriceFooter() {
    var n = dirtyTiers().length;
    var foot = el('ad-price-save');
    if (!n) { hide(foot); return; }
    text(el('ad-price-apply'), n === 1 ? 'Save 1 price' : 'Save ' + n + ' prices');
    show(foot);
  }

  function renderCopyFrom() {
    var sel = el('ad-copy-from');
    var had = sel.value;
    sel.innerHTML = '';
    var others = state.events.filter(function (e) { return e.id !== state.eventId; });
    if (!others.length) {
      sel.appendChild(new Option('No other events', ''));
      return;
    }
    // Most recent first: last night's prices are the ones worth copying.
    others.slice().reverse().forEach(function (e) {
      sel.appendChild(new Option(asDate(e.starts_at) + ' — ' + e.name, e.id));
    });
    if (had) sel.value = had;
  }

  function copyPrices() {
    var from = el('ad-copy-from').value;
    if (!from) return;
    var btn = el('ad-copy-go');
    btn.disabled = true;

    call('tiers', { event_id: from })
      .then(function (data) {
        var byCode = {};
        (data.tiers || []).forEach(function (t) { byCode[t.code] = t.price_cents; });

        var moved = 0, missing = 0;
        state.tiers.forEach(function (t) {
          if (byCode[t.code] == null) { missing++; return; }
          if (byCode[t.code] === t.price_cents) return;
          state.priceDrafts[t.code] = dollars(byCode[t.code]);
          moved++;
        });

        // Filled in, not saved. Read them back first.
        renderPricesForce();
        toast(moved
          ? moved + ' price' + (moved === 1 ? '' : 's') + ' filled in — check them, then save'
          : 'Those prices are the same as these', moved ? 'good' : null);
        if (missing) {
          toast(missing + ' tier' + (missing === 1 ? ' has' : 's have') + ' no match on that night', 'bad');
        }
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () { btn.disabled = false; });
  }

  // Rebuild even with drafts pending — used right after something has
  // deliberately changed them.
  function renderPricesForce() {
    var box = el('ad-prices');
    box.innerHTML = '';
    state.tiers.forEach(function (t) { box.appendChild(priceRow(t)); });
    renderPriceFooter();
  }

  function resetPrices() {
    state.priceDrafts = {};
    renderPricesForce();
  }

  function toggleSoldOut(t, btn) {
    btn.disabled = true;
    call('set_sold_out', {
      event_id: state.eventId,
      property_id: t.property_id,
      tier_code: t.code,
      sold_out: !t.manually_sold_out,
    })
      .then(function (data) {
        toast(String(t.label || t.code).split(/\s+—\s+/)[0] +
          (data.sold_out ? ' called sold out' : ' back on sale'), 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () { btn.disabled = false; });
  }

  function applyPrices() {
    var changed = dirtyTiers();
    if (!changed.length) return;

    // Check the lot before sending any of it. Half a price list is worse
    // than none, and a typo is the likeliest thing to happen here.
    var jobs = [];
    for (var i = 0; i < changed.length; i++) {
      var t = changed[i];
      var raw = String(state.priceDrafts[t.code]).replace(/^\$/, '').trim();
      var n = Number(raw);
      var name = String(t.label || t.code).split(/\s+—\s+/)[0];
      if (!raw || isNaN(n)) {
        toast(name + ': "' + raw + '" is not a price', 'bad');
        return;
      }
      var cents = Math.round(n * 100);
      if (cents < 100 || cents > 50000) {
        toast(name + ': a price has to be between $1 and $500', 'bad');
        return;
      }
      jobs.push({ tier: t, cents: cents, name: name });
    }

    var btn = el('ad-price-apply');
    btn.disabled = true;

    var done = 0;
    var failed = [];

    var chain = jobs.reduce(function (p, job) {
      return p.then(function () {
        return call('set_price', {
          event_id: state.eventId,
          property_id: job.tier.property_id,
          tier_code: job.tier.code,
          price_cents: job.cents,
        }).then(function () { done++; })
          .catch(function (err) { failed.push(job.name + ': ' + err.message); });
      });
    }, Promise.resolve());

    chain.then(function () {
      state.priceDrafts = {};
      return loadList(true);
    }).then(function () {
      if (failed.length) {
        toast(failed[0], 'bad');
      } else {
        toast(done === 1 ? 'Price updated — it is live' : done + ' prices updated — they are live', 'good');
      }
    }).finally(function () { btn.disabled = false; });
  }

  function showTab(which) {
    state.tab = which;
    var gate = which === 'gate';
    el('ad-panel-gate').hidden = !gate;
    el('ad-panel-prices').hidden = gate;
    el('ad-tab-gate').classList.toggle('is-on', gate);
    el('ad-tab-prices').classList.toggle('is-on', !gate);
    el('ad-tab-gate').setAttribute('aria-selected', String(gate));
    el('ad-tab-prices').setAttribute('aria-selected', String(!gate));
    if (!gate) renderPrices();
  }

  /* -------------------------------------------------------- walk-up sale */

  function openSell() {
    el('ad-sell-error').hidden = true;
    el('ad-sell-form').reset();
    show(el('ad-sell'));

    call('tiers', { event_id: state.eventId })
      .then(function (data) {
        state.tiers = data.tiers || [];
        var sel = el('ad-sell-tier');
        sel.innerHTML = '';
        state.tiers.forEach(function (t) {
          var name = String(t.label || t.code).split(/\s+—\s+/)[0];
          var opt = new Option(
            name + ' — ' + money(t.price_cents) + ' (' + t.spots_left_gate + ' left)',
            t.code
          );
          opt.disabled = t.spots_left_gate <= 0;
          sel.appendChild(opt);
        });
      })
      .catch(function (err) { toast(err.message, 'bad'); });
  }

  function submitSell(e) {
    e.preventDefault();
    var form = el('ad-sell-form');
    var tier = state.tiers.filter(function (t) { return t.code === form.tier.value; })[0];
    if (!tier) return;

    var btn = el('ad-sell-submit');
    btn.disabled = true;
    el('ad-sell-error').hidden = true;

    call('sell', {
      event_id: state.eventId,
      property_id: tier.property_id,
      tier_code: tier.code,
      payment_method: form.payment.value,
      vehicle_rego: form.rego.value.trim() || null,
      name: form.sellname.value.trim() || null,
      phone: form.sellphone.value.trim() || null,
      // Always true at the gate. This flag is what lets sell_at_gate reach the
      // berm zones at all, and standing in the driveway telling someone where
      // to put their car IS the consent conversation — there is no second
      // party to ask. Leaving it as a checkbox would mean an unticked box
      // silently made the berm unsellable on the busiest night of the year.
      accepts_street: true,
    })
      .then(function () {
        hide(el('ad-sell'));
        var plate = form.rego.value.trim().toUpperCase();
        toast(plate ? 'Sold — ' + plate : 'Sold', 'good');
        return loadList(true);
      })
      .catch(function (err) {
        var box = el('ad-sell-error');
        box.textContent = err.message;
        show(box);
      })
      .finally(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------- configuration check */

  // Answers "did I set the keys up right" without anyone spending money to
  // find out. The function does the real work; this just renders the verdict.
  function openCheck() {
    var sheet = el('ad-check');
    var list = el('ad-check-list');
    list.innerHTML = '';
    text(el('ad-check-summary'), 'Checking…');
    el('ad-check-summary').className = 'ad-check-summary';
    sheet.hidden = false;

    fetch(CFG.supabaseUrl + '/functions/v1/check-setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify({ passphrase: state.pass }),
    })
      .then(function (res) {
        return res.json().then(function (d) { return { ok: res.ok, data: d }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Could not run the check.');
        var d = r.data;

        var sum = el('ad-check-summary');
        text(sum, d.summary);
        sum.className = 'ad-check-summary ' + (d.ready ? 'is-good' : 'is-bad');

        (d.checks || []).forEach(function (c) {
          var row = make('div', 'ad-check-row');
          var mark = make('span', 'ad-check-mark ' +
            (c.ok === true ? 'is-good' : c.ok === false ? 'is-bad' : 'is-unknown'),
            c.ok === true ? '✓' : c.ok === false ? '✕' : '?');
          var body = make('span', 'ad-check-body');
          body.appendChild(make('span', 'ad-check-name', c.name));
          body.appendChild(make('span', 'ad-check-detail', c.detail));
          row.appendChild(mark);
          row.appendChild(body);
          list.appendChild(row);
        });
      })
      .catch(function (err) {
        var sum = el('ad-check-summary');
        text(sum, err.message);
        sum.className = 'ad-check-summary is-bad';
      });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    // Running against the test database looks exactly like running against
    // the real one, right up until it matters. Say so.
    if (CFG.isTest) show(el('ad-env'));

    el('ad-unlock-form').addEventListener('submit', unlock);

    el('ad-event').addEventListener('change', function () {
      // Prices typed for one night must never be saved against another.
      if (dirtyTiers().length) toast('Unsaved prices dropped', 'bad');
      state.priceDrafts = {};
      state.pubArmed = null;
      state.eventId = this.value;
      loadList();
    });

    el('ad-search').addEventListener('input', function () {
      state.filter = this.value.trim();
      renderList();
    });

    el('ad-refresh').addEventListener('click', function () { loadList(); });

    el('ad-tab-gate').addEventListener('click', function () { showTab('gate'); });
    el('ad-tab-prices').addEventListener('click', function () { showTab('prices'); });
    el('ad-copy-go').addEventListener('click', copyPrices);
    el('ad-price-apply').addEventListener('click', applyPrices);
    el('ad-price-reset').addEventListener('click', resetPrices);

    el('ad-over-toggle').addEventListener('click', function () {
      var body = el('ad-over-body');
      var open = body.hidden;
      body.hidden = !open;
      this.setAttribute('aria-expanded', String(open));
      el('ad-over').classList.toggle('is-open', open);
    });

    el('ad-act-close').addEventListener('click', function () {
      state.picked = null;
      hide(el('ad-actions'));
    });

    el('ad-tr-close').addEventListener('click', function () { hide(el('ad-transfer')); });
    el('ad-tr-site').addEventListener('change', describeSite);
    el('ad-tr-refund').addEventListener('change', refundToggled);
    el('ad-transfer-form').addEventListener('submit', submitTransfer);

    el('ad-cx-close').addEventListener('click', standDownCancel);
    el('ad-cx-back').addEventListener('click', standDownCancel);
    el('ad-cancel-form').addEventListener('submit', submitCancel);

    el('ad-sell-open').addEventListener('click', openSell);
    el('ad-check-open').addEventListener('click', openCheck);
    el('ad-check-close').addEventListener('click', function () {
      el('ad-check').hidden = true;
    });
    el('ad-sell-close').addEventListener('click', function () { hide(el('ad-sell')); });
    el('ad-sell-form').addEventListener('submit', submitSell);

    // Someone else may be selling at the gate while this phone is open.
    setInterval(function () {
      if (!document.hidden && state.eventId && el('ad-app').hidden === false) loadList(true);
    }, REFRESH_MS);

    // A passphrase already in this tab's session gets straight back in.
    if (state.pass) {
      el('ad-pass').value = state.pass;
      el('ad-unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
