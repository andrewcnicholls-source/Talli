/* =====================================================================
   Talli Parking — gate screen

   Built for one hand, outdoors, at night. Two screens: Arrivals, which is
   the list — search a plate, tap the row, the car is ticked off — and
   Tonight, which is everything that moves during an event: how many spaces
   are really left, what the sign says, and what is still owed.

   All reads and writes go through the gate-ops edge function, which holds
   the passphrase check and the service-role credentials. Nothing here can
   reach the database on its own — except the extras catalogue, which is
   public and read straight from PostgREST.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var FN = CFG.supabaseUrl + '/functions/v1/gate-ops';
  var REST = CFG.supabaseUrl + '/rest/v1';
  var TZ = 'Pacific/Auckland';
  var KEY = 'talli.gate.pass';
  var REFRESH_MS = 30000;
  // The running order at the gate. Config can override it, but the default
  // lives here too: this branch and the test-environment branch each rewrote
  // talli-config.js, and whichever way that merge is resolved, the walk-up
  // form still has to come up on Standard.
  var GATE_ORDER = CFG.gateTierOrder || ['standard', 'priority', 'valet'];

  var state = {
    pass: sessionStorage.getItem(KEY) || '',
    events: [],
    eventId: null,
    tab: 'gate',
    rows: [],
    zones: [],
    tiers: [],
    extras: [],       // what has been pre-purchased and still needs handing over
    catalogue: [],    // what we sell
    summary: null,
    filter: '',
    busy: {},
    sellTier: null,
    sellExtras: {},
    priceTier: null,
    // Basis points. 200 = 2%. Comes down with the night's state so the screen
    // and the database never disagree about what a card costs.
    surchargeBps: 0,
  };

  function el(id) { return document.getElementById(id); }
  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }
  function text(n, v) { if (n) n.textContent = v; return n; }

  function money(cents) {
    var d = (cents || 0) / 100;
    return '$' + (cents % 100 === 0 ? d.toFixed(0) : d.toFixed(2));
  }

  // The sign price is the cash price. Card costs us a percentage to accept, so
  // card sales — the terminal here, and every sale on the website — pay it.
  // Mirrors card_surcharge_cents() in the database; the database still decides
  // what the booking records.
  var CARD_METHODS = ['stripe', 'tap_to_pay'];

  function surchargeOn(cents, paymentMethod) {
    if (!state.surchargeBps) return 0;
    if (CARD_METHODS.indexOf(paymentMethod) === -1) return 0;
    return Math.round((cents || 0) * state.surchargeBps / 10000);
  }

  // 200 -> "2", 250 -> "2.5".
  function surchargePct() {
    return (state.surchargeBps / 100).toFixed(2).replace(/\.?0+$/, '');
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

  function make(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function button(cls, label, onClick) {
    var b = make('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // "Standard — best value, expect to wait" is a sentence for the website.
  // On the gate screen there is room for the first two words.
  function shortName(tier) {
    return String(tier.label || tier.code).split(/\s+—\s+/)[0];
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
    // Trimmed, because the server compares byte-for-byte in constant time
    // and a passphrase pasted with a trailing space is indistinguishable
    // from a wrong one. Every other field on this page already trims.
    state.pass = input.value.trim();
    el('ad-unlock-error').hidden = true;

    call('events').then(function (data) {
      sessionStorage.setItem(KEY, state.pass);
      state.events = data.events || [];
      hide(el('ad-lock'));
      show(el('ad-app'));
      loadCatalogue();
      renderEvents();
    }).catch(function (err) {
      state.pass = '';
      sessionStorage.removeItem(KEY);
      var box = el('ad-unlock-error');
      box.textContent = err.message;
      show(box);
    });
  }

  // The extras catalogue is public — the same rows the booking page reads.
  function loadCatalogue() {
    fetch(REST + '/addon?active=is.true&order=sort_order.asc' +
          '&select=code,name,price_cents,bundle_qty,bundle_price_cents,max_qty', {
      headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey },
    })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) { state.catalogue = items || []; })
      .catch(function () { state.catalogue = []; });
  }

  /* ------------------------------------------------------------- events */

  function renderEvents() {
    var sel = el('ad-event');
    sel.innerHTML = '';
    if (!state.events.length) {
      sel.appendChild(new Option('No events yet', ''));
      return;
    }
    state.events.forEach(function (ev) {
      var label = asDate(ev.starts_at) + ' — ' + ev.name +
        (ev.status !== 'on_sale' ? ' (' + ev.status + ')' : '');
      sel.appendChild(new Option(label, ev.id));
    });

    // Default to the next event that has not finished yet; that is almost
    // always the one being worked.
    var now = Date.now();
    var next = state.events.filter(function (e) { return new Date(e.starts_at) > now; })[0];
    state.eventId = (next || state.events[state.events.length - 1]).id;
    sel.value = state.eventId;
    loadList();
  }

  /* ---------------------------------------------------- the whole night */

  function loadList(quiet) {
    if (!state.eventId) return;
    if (!quiet) el('ad-list').setAttribute('aria-busy', 'true');

    return call('list', { event_id: state.eventId })
      .then(function (data) {
        state.rows = data.rows || [];
        state.zones = data.zones || [];
        state.tiers = data.tiers || [];
        state.extras = data.extras || [];
        state.summary = data.summary || null;
        state.surchargeBps = data.card_surcharge_bps || 0;
        renderAll();
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () { el('ad-list').removeAttribute('aria-busy'); });
  }

  function renderAll() {
    renderStats();
    renderList();
    renderBoard();
    renderZones();
    renderPrices();
    renderExtras();
    renderMoney();
    measureHead();
  }

  function renderStats() {
    var s = state.summary;
    if (!s) return;
    text(el('ad-stat-arrived'), s.arrived + '/' + s.total);
    text(el('ad-stat-free'), String(s.free));
    text(el('ad-stat-taken'), money(s.taken_cents));

    var holds = el('ad-holds');
    var notes = [];
    if (s.unpaid_holds > 0) {
      notes.push(s.unpaid_holds + ' unpaid hold' + (s.unpaid_holds === 1 ? '' : 's') +
        ' — people mid-checkout, not confirmed bookings.');
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

  /* --------------------------------------------------------- the list */

  function matches(row) {
    if (!state.filter) return true;
    var f = state.filter.toLowerCase();
    return [row.vehicle_rego, row.customer_name, row.customer_phone, row.bay_label]
      .some(function (v) { return v && String(v).toLowerCase().indexOf(f) > -1; });
  }

  function renderList() {
    var list = el('ad-list');
    list.innerHTML = '';

    var rows = state.rows.filter(matches);

    if (!rows.length) {
      list.appendChild(make('p', 'ad-empty',
        state.rows.length ? 'Nothing matches that.' : 'No bookings for this event yet.'));
      return;
    }

    rows.forEach(function (r) { list.appendChild(rowCard(r)); });
  }

  function rowCard(r) {
    var addons = r.addons || [];
    var owing = (r.addons_pending || 0) > 0;

    var card = make('div', 'ad-row' + (r.arrived ? ' is-arrived' : '') +
      (r.status === 'held' ? ' is-held' : '') + (owing ? ' has-extras' : ''));

    var main = make('div', 'ad-row-main');

    var top = make('div', 'ad-row-top');
    top.appendChild(make('span', 'ad-rego', r.vehicle_rego || '— no plate —'));
    if (r.bay_label) top.appendChild(make('span', 'ad-bay', r.bay_label));
    main.appendChild(top);

    var who = [r.customer_name, r.customer_phone].filter(Boolean).join(' · ');
    if (who) main.appendChild(make('div', 'ad-who', who));

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
      meta.appendChild(make('span', 'ad-chip is-cash',
        r.payment_method.replace(/_/g, ' ') + ' ' +
        money((r.amount_cents || 0) + (r.addons_cents || 0) + (r.surcharge_cents || 0))));
    }
    if (r.status === 'held') meta.appendChild(make('span', 'ad-chip is-warn', 'unpaid hold'));
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

    if (addons.length) {
      actions.appendChild(button('ad-hand' + (owing ? '' : ' is-on'),
        owing ? 'Hand over' : 'Handed',
        function () { toggleHandedOver(r); }));
    }

    // Valet holds keys, so those cars are already movable by hand and do not
    // need this. Anything already out on the verge has nowhere further to go.
    var inOverflow = /overflow/i.test(String(r.zone_label || ''));
    if (!inOverflow && r.tier_code !== 'valet') {
      var move = button('ad-move', '→ Overflow', function () {
        moveToOverflow(r, move);
      });
      move.title = 'Move this car to overflow and free its bay';
      move.disabled = !!state.busy[r.booking_id];
      actions.appendChild(move);
    }

    card.appendChild(actions);

    return card;
  }

  // Moving a prepaid car out to the verge puts its bay back on sale. That is
  // the point: when there is a queue at the gate, a Standard sitting in the
  // back yard is worth more to you parked on the overflow.
  //
  // Nobody agreed to this in advance any more — that box is gone from the
  // booking page — so nothing is confirmed here either. You are standing next
  // to the car; the conversation has already happened.
  function moveToOverflow(r, btn) {
    var who = r.vehicle_rego || r.customer_name || 'this car';
    state.busy[r.booking_id] = true;
    btn.disabled = true;
    call('move_to_overflow', { booking_id: r.booking_id })
      .then(function (data) {
        toast(who + ' moved to ' + (data.moved_to || 'overflow'), 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () {
        delete state.busy[r.booking_id];
        btn.disabled = false;
      });
  }

  function toggleArrived(r, btn) {
    var action = r.arrived ? 'undo_check_in' : 'check_in';
    state.busy[r.booking_id] = true;
    btn.disabled = true;

    call(action, { booking_id: r.booking_id })
      .then(function () {
        r.arrived = !r.arrived;
        toast((r.vehicle_rego || 'Booking') + (r.arrived ? ' ticked in' : ' un-ticked'), 'good');
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

  /* ------------------------------------------------------ tonight's board */

  function renderBoard() {
    var s = state.summary;
    if (!s) return;
    text(el('ad-board-filled'), String(s.filled));
    text(el('ad-board-capacity'), String(s.capacity));

    var pct = s.capacity ? Math.round((s.filled / s.capacity) * 100) : 0;
    el('ad-board-bar').style.width = Math.min(pct, 100) + '%';

    var notes = [s.free + ' free'];
    if (s.lost) notes.push(s.lost + ' written off tonight');
    if (s.opened) notes.push(s.opened + ' squeezed in');
    text(el('ad-board-note'), notes.join(' · '));
  }

  function renderZones() {
    var wrap = el('ad-zones');
    wrap.innerHTML = '';
    if (!state.zones.length) {
      wrap.appendChild(make('p', 'ad-empty', 'No spaces set up for this event.'));
      return;
    }

    state.zones.forEach(function (z) {
      var card = make('div', 'ad-zone');

      var head = make('div', 'ad-zone-head');
      head.appendChild(make('span', 'ad-zone-name', z.zone_label));
      head.appendChild(make('span', 'ad-zone-count', z.filled + '/' + z.capacity));
      card.appendChild(head);

      var notes = [];
      if (z.lost) notes.push(z.lost + ' lost');
      if (z.opened) notes.push(z.opened + ' extra');
      if (z.gate_reserve) notes.push(z.gate_reserve + ' held for walk-ups');
      if (!z.reservable_in_advance) notes.push('gate only');
      notes.push(z.spare_left + ' spare' + (z.spare_left === 1 ? '' : 's') + ' in reserve');
      card.appendChild(make('div', 'ad-zone-note', notes.join(' · ')));

      var row = make('div', 'ad-zone-actions');
      row.appendChild(button('ad-count-btn', '−', function () { adjust(z, -1); }));
      row.appendChild(button('ad-count-btn', '+', function () { adjust(z, 1); }));
      card.appendChild(row);

      wrap.appendChild(card);
    });
  }

  function adjust(zone, delta) {
    call('adjust_capacity', {
      event_id: state.eventId,
      zone_id: zone.zone_id,
      delta: delta,
    })
      .then(function (data) {
        toast(zone.zone_label + ' now ' + data.capacity + ' spaces', 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); });
  }

  /* ------------------------------------------------------------- prices */

  // Standard first, then Priority, then Valet — the order you actually sell
  // in, not the order the database sorts by. Anything else the fixture offers
  // falls in behind.
  function inGateOrder(tiers) {
    var ranked = [];
    GATE_ORDER.forEach(function (code) {
      tiers.forEach(function (t) { if (t.code === code) ranked.push(t); });
    });
    tiers.forEach(function (t) { if (ranked.indexOf(t) === -1) ranked.push(t); });
    return ranked;
  }

  function renderPrices() {
    var wrap = el('ad-prices');
    wrap.innerHTML = '';
    var tiers = inGateOrder(state.tiers);
    if (!tiers.length) {
      wrap.appendChild(make('p', 'ad-empty', 'No spots on sale for this event.'));
      return;
    }

    tiers.forEach(function (t) {
      var gone = t.manually_sold_out || t.spots_left_gate <= 0;
      var card = make('div', 'ad-price' + (gone ? ' is-gone' : ''));

      var head = make('div', 'ad-price-head');
      head.appendChild(make('span', 'ad-price-name', shortName(t)));
      head.appendChild(button('ad-price-tag', money(t.price_cents), function () {
        openPrice(t);
      }));
      card.appendChild(head);

      card.appendChild(make('div', 'ad-price-left',
        t.manually_sold_out
          ? 'Marked sold out'
          : t.spots_left_gate + ' left at the gate · ' + t.spots_left + ' online'));

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
      row.appendChild(button('ad-soldout' + (t.manually_sold_out ? ' is-on' : ''),
        t.manually_sold_out ? 'Back on sale' : 'Sold out',
        function () { toggleSoldOut(t); }));
      card.appendChild(row);

      wrap.appendChild(card);
    });
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
  function paintPriceHint() {
    var hint = el('ad-price-hint');
    var dollars = Number(el('ad-price-input').value);
    if (!state.surchargeBps || !isFinite(dollars) || dollars <= 0) {
      hide(hint);
      return;
    }
    var cents = Math.round(dollars * 100);
    text(hint, 'Cash ' + money(cents) + ' · card ' +
      money(cents + surchargeOn(cents, 'tap_to_pay')) +
      ' (includes the ' + surchargePct() + '% card surcharge)');
    show(hint);
  }

  function submitPrice(e) {
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

  function toggleSoldOut(tier) {
    call('set_sold_out', {
      event_id: state.eventId,
      property_id: tier.property_id,
      tier_code: tier.code,
      sold_out: !tier.manually_sold_out,
    })
      .then(function (data) {
        toast(shortName(tier) + (data.sold_out ? ' marked sold out' : ' back on sale'), 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); });
  }

  /* ------------------------------------------------------------- extras */

  function renderExtras() {
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

  function renderMoney() {
    var s = state.summary;
    var wrap = el('ad-money');
    wrap.innerHTML = '';
    if (!s) return;

    [
      ['Taken tonight', money(s.taken_cents), true],
      ['Prepaid online', money(s.online_cents), false],
      ['Sold at the gate', money(s.gate_cents), false],
      ['Of that, extras', money(s.addons_cents), false],
      ['Of that, card surcharge', money(s.surcharge_cents), false],
      ['Still to collect', money(s.cash_due_cents), s.cash_due_cents > 0],
    ].forEach(function (line) {
      var row = make('div', 'ad-money-row' + (line[2] ? ' is-lead' : ''));
      row.appendChild(make('span', null, line[0]));
      row.appendChild(make('strong', null, line[1]));
      wrap.appendChild(row);
    });
  }

  /* -------------------------------------------------------- walk-up sale */

  function openSell() {
    el('ad-sell-error').hidden = true;
    el('ad-sell-form').reset();
    state.sellTier = null;
    state.sellExtras = {};
    renderSellTiers();
    renderSellExtras();
    renderSellCharge();
    show(el('ad-sell'));
  }

  function renderSellTiers() {
    var wrap = el('ad-sell-tiers');
    wrap.innerHTML = '';
    var tiers = inGateOrder(state.tiers);

    // Default to the first thing still sellable, which after a "sold out" tap
    // is the next spot up. That is the whole point of the ordering.
    if (!state.sellTier) {
      var first = tiers.filter(function (t) {
        return !t.manually_sold_out && t.spots_left_gate > 0;
      })[0];
      state.sellTier = first ? first.code : null;
    }

    tiers.forEach(function (t) {
      var gone = t.manually_sold_out || t.spots_left_gate <= 0;
      var opt = make('button', 'ad-pick-opt' +
        (state.sellTier === t.code ? ' is-on' : '') + (gone ? ' is-gone' : ''));
      opt.type = 'button';
      opt.disabled = gone;

      var line = make('span', 'ad-pick-line');
      line.appendChild(make('span', 'ad-pick-name', shortName(t)));
      line.appendChild(make('span', 'ad-pick-price', money(t.price_cents)));
      opt.appendChild(line);
      opt.appendChild(make('span', 'ad-pick-left',
        t.manually_sold_out ? 'marked sold out'
          : t.spots_left_gate > 0 ? t.spots_left_gate + ' left'
          : 'none left'));

      opt.addEventListener('click', function () {
        state.sellTier = t.code;
        renderSellTiers();
        renderSellCharge();
      });
      wrap.appendChild(opt);
    });
  }

  function renderSellExtras() {
    var wrap = el('ad-sell-extras');
    wrap.innerHTML = '';
    if (!state.catalogue.length) {
      wrap.appendChild(make('p', 'ad-empty', 'Catalogue unavailable.'));
      return;
    }
    state.catalogue.forEach(function (item) {
      var qty = state.sellExtras[item.code] || 0;
      var row = make('div', 'ad-sell-extra' + (qty ? ' is-picked' : ''));
      row.appendChild(make('span', 'ad-sell-extra-name', item.name));

      var step = make('span', 'ad-step');
      var less = button('ad-count-btn', '−', function () { bumpExtra(item, -1); });
      less.disabled = qty === 0;
      step.appendChild(less);
      step.appendChild(make('span', 'ad-count', String(qty)));
      step.appendChild(button('ad-count-btn', '+', function () { bumpExtra(item, 1); }));
      row.appendChild(step);

      wrap.appendChild(row);
    });
  }

  function bumpExtra(item, by) {
    var max = item.max_qty || 10;
    var next = Math.min(Math.max((state.sellExtras[item.code] || 0) + by, 0), max);
    if (next === 0) delete state.sellExtras[item.code];
    else state.sellExtras[item.code] = next;
    renderSellExtras();
    renderSellCharge();
  }

  // Mirrors addon_price_cents() in the database, the same way the booking page
  // does: enough to be honest on screen while the database does the sum that
  // is recorded. "2 for $5" means unit price × quantity is the wrong answer.
  function extraTotal(item, qty) {
    if (qty <= 0) return 0;
    if (!item.bundle_qty || !item.bundle_price_cents) return item.price_cents * qty;
    return Math.min(
      item.price_cents * qty,
      Math.floor(qty / item.bundle_qty) * item.bundle_price_cents +
        (qty % item.bundle_qty) * item.price_cents
    );
  }

  function sellExtrasTotal() {
    return state.catalogue.reduce(function (sum, item) {
      return sum + extraTotal(item, state.sellExtras[item.code] || 0);
    }, 0);
  }

  /* -------------------------------------------- what to actually charge */

  // The one line the marshal reads out loud. Everything above it is how the
  // sale is described; this is the number the driver hands over, and it moves
  // the moment the payment method does.
  function renderSellCharge() {
    var box = el('ad-sell-charge');
    var tier = state.tiers.filter(function (t) { return t.code === state.sellTier; })[0];
    if (!tier) {
      hide(box);
      return;
    }

    var method = el('ad-sell-payment').value;
    var extras = sellExtrasTotal();
    var subtotal = tier.price_cents + extras;
    var surcharge = surchargeOn(subtotal, method);

    text(el('ad-sell-charge-spot-name'), shortName(tier));
    text(el('ad-sell-charge-spot'), money(tier.price_cents));

    var extraRow = el('ad-sell-charge-extras-row');
    if (extras > 0) {
      text(el('ad-sell-charge-extras'), money(extras));
      show(extraRow);
    } else {
      hide(extraRow);
    }

    var surRow = el('ad-sell-charge-surcharge-row');
    if (surcharge > 0) {
      text(el('ad-sell-charge-surcharge-label'),
        'Card surcharge (' + surchargePct() + '%)');
      text(el('ad-sell-charge-surcharge'), money(surcharge));
      show(surRow);
    } else {
      hide(surRow);
    }

    text(el('ad-sell-charge-total'), money(subtotal + surcharge));
    show(box);
  }

  function submitSell(e) {
    e.preventDefault();
    var form = el('ad-sell-form');
    var tier = state.tiers.filter(function (t) { return t.code === state.sellTier; })[0];
    if (!tier) {
      var pick = el('ad-sell-error');
      text(pick, 'Pick a spot first.');
      show(pick);
      return;
    }

    var btn = el('ad-sell-submit');
    btn.disabled = true;
    el('ad-sell-error').hidden = true;

    var addons = Object.keys(state.sellExtras).map(function (code) {
      return { code: code, qty: state.sellExtras[code] };
    });

    call('sell', {
      event_id: state.eventId,
      property_id: tier.property_id,
      tier_code: tier.code,
      payment_method: form.payment.value,
      vehicle_rego: form.rego.value.trim() || null,
      name: form.sellname.value.trim() || null,
      phone: form.sellphone.value.trim() || null,
      addons: addons,
    })
      .then(function (data) {
        hide(el('ad-sell'));
        var plate = form.rego.value.trim().toUpperCase();
        if (data.addons_failed) {
          toast('Space sold, but the extras did not save — take that cash', 'bad');
        } else {
          // The charged figure comes back from the database rather than being
          // repeated from the screen, so a rate that changed mid-night shows
          // up here rather than being quietly wrong.
          var charged = data.charge_cents != null ? ' · ' + money(data.charge_cents) : '';
          toast((plate ? 'Sold — ' + plate : 'Sold') + charged, 'good');
        }
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

  // The sticky search bar has to sit directly under the header, whose height
  // depends on the safe-area inset and the length of the event name. Measure
  // it rather than hard-coding a number that is wrong on half the phones.
  function measureHead() {
    var head = el('ad-head') || document.querySelector('.ad-head');
    if (!head) return;
    document.documentElement.style.setProperty(
      '--ad-head-h', head.offsetHeight + 'px');
  }

  /* ---------------------------------------------------------------- tabs */

  function showTab(which) {
    state.tab = which;
    var gate = which === 'gate';
    el('ad-pane-gate').hidden = !gate;
    el('ad-pane-night').hidden = gate;
    el('ad-tab-gate').classList.toggle('is-on', gate);
    el('ad-tab-night').classList.toggle('is-on', !gate);
    el('ad-tab-gate').setAttribute('aria-selected', String(gate));
    el('ad-tab-night').setAttribute('aria-selected', String(!gate));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    el('ad-unlock-form').addEventListener('submit', unlock);

    el('ad-event').addEventListener('change', function () {
      state.eventId = this.value;
      loadList();
    });

    el('ad-search').addEventListener('input', function () {
      state.filter = this.value.trim();
      renderList();
    });

    el('ad-refresh').addEventListener('click', function () { loadList(); });

    window.addEventListener('resize', measureHead);

    el('ad-tab-gate').addEventListener('click', function () { showTab('gate'); });
    el('ad-tab-night').addEventListener('click', function () { showTab('night'); });

    el('ad-sell-open').addEventListener('click', openSell);
    el('ad-sell-close').addEventListener('click', function () { hide(el('ad-sell')); });
    el('ad-sell-form').addEventListener('submit', submitSell);
    // Cash and card are different numbers. Switching the method has to move
    // the figure being read out, not just what gets recorded.
    el('ad-sell-payment').addEventListener('change', renderSellCharge);

    el('ad-price-close').addEventListener('click', function () { hide(el('ad-price')); });
    el('ad-price-form').addEventListener('submit', submitPrice);
    el('ad-price-input').addEventListener('input', paintPriceHint);

    el('ad-check-open').addEventListener('click', openCheck);
    el('ad-check-close').addEventListener('click', function () {
      el('ad-check').hidden = true;
    });

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
