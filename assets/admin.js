/* =====================================================================
   Talli Parking — gate screen

   Built for one hand, outdoors, at night. Two screens: Arrivals, which is
   the list — search a plate, tap the row, the car is ticked off — and
   Tonight, which is everything that moves during an event: how many spaces
   are really left, what the sign says, and what is still owed.

   All reads and writes go through the gate-ops edge function, which holds
   the service-role credentials and decides, on every request, whether the
   person signed in is a host. Nothing here can reach the database on its
   own — except the extras catalogue, which is public and read straight
   from PostgREST.

   Getting in is Google, via Supabase Auth. assets/talli-auth.js holds the
   tokens; this file only ever asks it for a current one. Nothing on this
   screen decides who is allowed in: a 401 or a 403 from the server is the
   only thing that puts the sign-in card back up.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var FN = CFG.supabaseUrl + '/functions/v1/gate-ops';
  var REST = CFG.supabaseUrl + '/rest/v1';
  var TZ = 'Pacific/Auckland';
  var AUTH = window.TalliAuth;
  var REFRESH_MS = 30000;
  // The running order at the gate. Config can override it, but the default
  // lives here too: this branch and the test-environment branch each rewrote
  // talli-config.js, and whichever way that merge is resolved, the walk-up
  // form still has to come up on Standard.
  var GATE_ORDER = CFG.gateTierOrder || ['standard', 'priority', 'valet'];

  // The order the arrivals side reads in, which is not the order you sell in.
  // Selling goes cheapest first — hold the quick exits back. Working the gate
  // goes the other way: Priority and Valet are the cars that need something
  // done to them the moment they appear, so they come first and Standard,
  // which mostly just parks itself, comes last.
  var ARRIVAL_ORDER = CFG.arrivalTierOrder || ['priority', 'valet', 'standard'];

  var state = {
    // Who the server said we are, from the `session` action. Display only —
    // every request is authorised again on its own.
    who: null,
    events: [],
    eventId: null,
    tab: 'gate',
    rows: [],
    tiers: [],
    extras: [],       // what has been pre-purchased and still needs handing over
    catalogue: [],    // what we sell
    summary: null,
    filter: '',
    busy: {},
    sellTier: null,
    sellExtras: {},
    // The booking open in the edit sheet, and the space it is being moved to.
    edit: null,
    editTier: null,
    priceTier: null,
    // The new-event modal. templates and properties come down when it opens;
    // newTiers is what is being edited, held as objects rather than read back
    // off the inputs so the parts the form does not show survive an edit.
    templates: [],
    properties: [],
    defaultProperty: null,
    newTemplate: null,
    newTiers: [],
    // Not on the form — how long the night runs is the same for every
    // fixture — but a template that says otherwise should not lose it the
    // moment somebody edits a price.
    newEndMinutes: 150,
    // Basis points. 400 = 4%. Comes down with the night's state so the screen
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

  // Every call carries the signed-in host's access token, refreshed first
  // if it was about to expire. `apikey` is still the anon key — that is the
  // project identifier Supabase's gateway wants, and is not what authorises
  // anything.
  function call(action, params) {
    var body = Object.assign({ action: action }, params || {});
    return post(FN, body);
  }

  function post(url, body) {
    return AUTH.accessToken().then(function (token) {
      // No token, or a refresh that came back refused. The server would
      // say the same thing a round trip later; saying it here means a
      // phone that lost its session mid-shift lands on the sign-in card
      // rather than on a spinner it cannot get past.
      if (!token) {
        var out = new Error('Your session has expired. Sign in again.');
        out.status = 401;
        out.code = 'NO_SESSION';
        fatal(out);
        throw out;
      }
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: CFG.anonKey,
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      });
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.code = data.code;
          // Handled once, here, rather than at each of the dozen call
          // sites: whatever the screen was doing, a refused identity means
          // the same thing and has the same answer. The error still throws
          // so the caller stops; toast() knows to stay quiet behind the
          // sign-in card.
          fatal(err);
          throw err;
        }
        return data;
      });
    });
  }

  function toast(message, kind) {
    var t = el('ad-toast');
    // Nothing to say over the sign-in card: the message there is the one
    // that matters, and a toast on top of it just covers the button.
    if (!el('ad-lock').hidden) return;
    t.textContent = message;
    t.className = 'ad-toast' + (kind ? ' is-' + kind : '');
    show(t);
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { hide(t); }, 3500);
  }

  /* ------------------------------------------------------------ sign in */

  // Three states, and only the server moves us between them: checking,
  // signed out, in. There is no client-side rule about who may be here —
  // the `session` call either comes back with an identity or it does not.
  function openSession() {
    return call('session').then(function (data) {
      state.who = data.who || null;
      state.events = data.events || [];
      hide(el('ad-lock'));
      show(el('ad-app'));
      renderWho();
      loadCatalogue();
      loadTemplates();
      renderEvents();
    });
  }

  // Shown when there is no usable session, and when the server turned one
  // down. A refused token is not kept: leaving it in storage means every
  // reload spends a round trip re-learning the same no.
  function showSignIn(message, code) {
    hide(el('ad-app'));
    hide(el('ad-lock-wait'));
    show(el('ad-lock'));
    show(el('ad-lock-signin'));

    var box = el('ad-lock-error');
    if (message) {
      box.textContent = message;
      show(box);
    } else {
      hide(box);
    }

    // Signed in to Google, correctly, as somebody who is not a host. The
    // ordinary button is a dead end here — Google skips its own picker
    // when there is one session, so pressing it hands over the same
    // refused account again. This is the way out.
    var swap = el('ad-lock-swap');
    if (code === 'NOT_A_HOST') show(swap); else hide(swap);
  }

  // A 401 means the session is gone or was never good; a 403 means it is a
  // real Google account that is not a host. Both land back on the card, but
  // the second one has to say so or the person just presses the same button
  // again and gets the same silence.
  function signedOut(err) {
    AUTH.forget();
    state.who = null;
    // A half-finished walk-up sale behind the card is a walk-up sale
    // somebody will try to submit again after signing back in.
    ['ad-new', 'ad-sell', 'ad-price', 'ad-check'].forEach(function (id) {
      hide(el(id));
    });
    showSignIn(err && err.message, err && err.code);
  }

  function renderWho() {
    var node = el('ad-who');
    if (!node) return;
    text(node, state.who ? state.who.email : '');
  }

  // Any call, anywhere on the screen, can be the one that discovers the
  // session died. Route those back to the card rather than letting them
  // surface as a toast the person cannot act on.
  function fatal(err) {
    if (err && (err.status === 401 || err.status === 403)) {
      signedOut(err);
      return true;
    }
    return false;
  }

  // The pricing templates, for the dropdown under Prices. The new-event
  // modal fetches the same list when it opens; this is the copy the gate
  // screen needs without opening anything. A failure here is quiet on
  // purpose: it costs the dropdown, and nothing else on the night.
  function loadTemplates() {
    return call('event_form')
      .then(function (data) {
        state.templates = data.templates || [];
        state.properties = data.properties || [];
        state.defaultProperty = data.default_property_id || null;
        renderPricePicker();
      })
      .catch(function () {});
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

  // Redrawn on its own whenever an event is made or its status moves, so
  // the name in the picker never disagrees with the badge below it.
  function renderEventOptions() {
    var sel = el('ad-event');
    sel.innerHTML = '';
    if (!state.events.length) {
      sel.appendChild(new Option('No events yet', ''));
      return;
    }
    state.events.forEach(function (ev) {
      var label = asDate(ev.starts_at) + ' — ' + ev.name +
        (ev.status !== 'on_sale' ? ' (' + statusMeta(ev.status)[1].toLowerCase() + ')' : '');
      sel.appendChild(new Option(label, ev.id));
    });
    if (state.eventId) sel.value = state.eventId;
  }

  function renderEvents() {
    renderEventOptions();
    if (!state.events.length) {
      state.eventId = null;
      renderStatus();
      return;
    }

    // Default to the next event that has not finished yet; that is almost
    // always the one being worked.
    var now = Date.now();
    var next = state.events.filter(function (e) { return new Date(e.starts_at) > now; })[0];
    state.eventId = (next || state.events[state.events.length - 1]).id;
    el('ad-event').value = state.eventId;
    loadList();
  }

  /* ---------------------------------------------------- the whole night */

  function loadList(quiet) {
    if (!state.eventId) return;
    if (!quiet) el('ad-list').setAttribute('aria-busy', 'true');

    return call('list', { event_id: state.eventId })
      .then(function (data) {
        state.rows = data.rows || [];
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
    renderSplit();
    renderList();
    renderStatus();
    renderBoard();
    renderPrices();
    renderPricePicker();
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
    if (s.owing > 0) {
      notes.push(s.owing + ' walk-up' + (s.owing === 1 ? '' : 's') +
        ' still to pay — ' + money(s.owing_cents) + '.');
    }
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

  // The tier as a class, so a Priority row and the Priority tally are the
  // same colour without either of them naming it.
  function tierClass(code) {
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
  function byTier(rows) {
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
    state.rows.forEach(function (r) {
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

  /* --------------------------------------------------------- the list */

  function matches(row) {
    if (!state.filter) return true;
    var f = state.filter.toLowerCase();
    return [row.vehicle_rego, row.customer_name, row.customer_phone]
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

    // One section per tier. The heading repeats the chip's count on purpose:
    // by the time you have scrolled to the Standard block the chips are off
    // the top of the screen, and "2/7 in" is the thing you came down here to
    // check.
    byTier(rows).forEach(function (g) {
      list.appendChild(groupHead(g));
      g.rows.forEach(function (r) { list.appendChild(rowCard(r)); });
    });
  }

  function groupHead(g) {
    var head = make('div', 'ad-group' + tierClass(g.code));
    head.appendChild(make('span', 'ad-group-name', g.code.replace(/_/g, ' ')));
    head.appendChild(make('span', 'ad-group-count',
      g.arrived + '/' + g.rows.length + ' in'));
    return head;
  }

  function rowCard(r) {
    var addons = r.addons || [];
    var owing = (r.addons_pending || 0) > 0;

    var card = make('div', 'ad-row' + (r.arrived ? ' is-arrived' : '') +
      (r.owes ? ' is-owing' : r.status === 'held' ? ' is-held' : '') +
      (owing ? ' has-extras' : ''));

    // The left side of the row opens the booking. The buttons on the right
    // stay what they were, so ticking a car in is still one tap.
    var main = make('div', 'ad-row-main');
    main.setAttribute('role', 'button');
    main.tabIndex = 0;
    main.setAttribute('aria-label', 'Edit ' + (r.vehicle_rego || 'booking'));
    main.addEventListener('click', function () { openEdit(r); });
    main.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(r); }
    });

    var top = make('div', 'ad-row-top');
    top.appendChild(make('span', 'ad-rego', r.vehicle_rego || '— no plate —'));
    main.appendChild(top);

    var who = [r.customer_name, r.customer_phone].filter(Boolean).join(' · ');
    if (who) main.appendChild(make('div', 'ad-who', who));

    var meta = make('div', 'ad-meta');
    if (r.tier_code) {
      meta.appendChild(make('span', 'ad-chip' + tierClass(r.tier_code),
        r.tier_code.replace(/_/g, ' ')));
    }
    if (r.arrival_from && r.arrival_until) {
      meta.appendChild(make('span', 'ad-chip', asTime(r.arrival_from) + '–' + asTime(r.arrival_until)));
    }
    if (r.owes) {
      meta.appendChild(make('span', 'ad-chip is-warn', 'owes ' + rowTotal(r)));
    } else if (r.payment_method && r.payment_method !== 'stripe') {
      meta.appendChild(make('span', 'ad-chip is-cash',
        r.payment_method.replace(/_/g, ' ') + ' ' +
        rowTotal(r)));
    }
    // Read before the car is waved past the crossing, not after it has
    // grounded on it. Loud on purpose — it is a decision, not a detail.
    if (r.vehicle_low_clearance) {
      meta.appendChild(make('span', 'ad-chip is-low', 'low car'));
    }
    if (r.status === 'held' && !r.owes) {
      meta.appendChild(make('span', 'ad-chip is-warn', 'unpaid hold'));
    }
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

    if (r.owes) {
      actions.appendChild(button('ad-pay', 'Pay', function () { openEdit(r); }));
    }

    if (addons.length) {
      actions.appendChild(button('ad-hand' + (owing ? '' : ' is-on'),
        owing ? 'Hand over' : 'Handed',
        function () { toggleHandedOver(r); }));
    }

    card.appendChild(actions);

    return card;
  }

  function rowTotal(r) {
    return money((r.amount_cents || 0) + (r.addons_cents || 0) + (r.surcharge_cents || 0));
  }

  function toggleArrived(r, btn) {
    var action = r.arrived ? 'undo_check_in' : 'check_in';
    state.busy[r.booking_id] = true;
    btn.disabled = true;

    call(action, { booking_id: r.booking_id })
      .then(function () {
        r.arrived = !r.arrived;
        var who = r.vehicle_rego || 'Booking';
        toast(who + (r.arrived ? ' ticked in' : ' un-ticked'), 'good');
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

    text(el('ad-board-note'), s.free + ' free');
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

    tiers.forEach(function (t) { wrap.appendChild(tierCard(t)); });
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

    var head = make('div', 'ad-price-head');
    head.appendChild(make('span', 'ad-price-name', shortName(t)));
    head.appendChild(button('ad-price-tag', money(t.price_cents), function () {
      openPrice(t);
    }));
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

    var spaces = spacesRow(t);
    if (spaces) card.appendChild(spaces);

    var reserve = reserveRow(t);
    if (reserve) card.appendChild(reserve);

    card.appendChild(make('div', 'ad-price-left', leftLine(t)));

    return card;
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
  function renderPricePicker() {
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

  function paintPricePick() {
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

  function applyPricePick() {
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
      ' (includes the card surcharge)');
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
      ['Owed by pay-later walk-ups', money(s.owing_cents || 0), (s.owing_cents || 0) > 0],
    ].forEach(function (line) {
      var row = make('div', 'ad-money-row' + (line[2] ? ' is-lead' : ''));
      row.appendChild(make('span', null, line[0]));
      row.appendChild(make('strong', null, line[1]));
      wrap.appendChild(row);
    });
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

  function statusMeta(code) {
    return STATUSES.filter(function (s) { return s[0] === code; })[0] ||
      [code, String(code || '—').replace(/_/g, ' '), ''];
  }

  function currentEvent() {
    return state.events.filter(function (e) { return e.id === state.eventId; })[0] || null;
  }

  function renderStatus() {
    var ev = currentEvent();
    var actions = el('ad-status-actions');
    actions.innerHTML = '';

    if (!ev) {
      text(el('ad-status-name'), 'No event');
      text(el('ad-status-pill'), '—');
      text(el('ad-status-when'), '');
      text(el('ad-status-note'), 'Make one with + at the top of the screen.');
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

  /* ----------------------------------------------------------- new event */

  // A tier as the modal holds it. Everything the database wants, including
  // the parts the form does not show — arrival windows, and the zone and
  // bay fields older templates still carry — so that editing a template's
  // price does not quietly drop the rest of what that template knew.
  //
  // An arrival window nobody set stays null rather than picking a number
  // here. normalise_event_tiers fills it from the tier code — valet and
  // priority up to kickoff, standard half an hour before — and the code is
  // still being typed when this runs, so the database is the only place
  // that can answer. Sending null asks it to.
  function tierDraft(t) {
    t = t || {};
    return {
      code: t.code || '',
      label: t.label || '',
      price_cents: t.price_cents != null ? t.price_cents : 0,
      zone_codes: t.zone_codes || null,
      bay_kind: t.bay_kind || 'any',
      guarantees_clear_exit: !!t.guarantees_clear_exit,
      arrival_from_minutes: t.arrival_from_minutes != null ? t.arrival_from_minutes : null,
      arrival_until_minutes: t.arrival_until_minutes != null ? t.arrival_until_minutes : null,
      departure_by_minutes: t.departure_by_minutes != null ? t.departure_by_minutes : null,
    };
  }

  function openNew() {
    el('ad-new-error').hidden = true;
    el('ad-new-form').reset();
    el('ad-new-venue').value = 'Eden Park';
    el('ad-new-gates').value = '150';
    el('ad-new-stop').value = '45';
    el('ad-new-date').value = defaultKickoff();
    state.newTemplate = null;
    state.newTiers = [];
    state.newEndMinutes = 150;
    renderTemplates();
    renderNewTiers();
    show(el('ad-new'));

    // The lists are small and change rarely, but a template saved on another
    // phone ten minutes ago should be there. Fetch every time it opens.
    call('event_form')
      .then(function (data) {
        state.templates = data.templates || [];
        state.properties = data.properties || [];
        state.defaultProperty = data.default_property_id || null;
        renderProperties();
        renderTemplates();
      })
      .catch(function (err) { newError(err.message); });
  }

  // Saturday evening, a week out — the shape of nearly every fixture, and
  // wrong in a way that is obvious rather than subtle if it is not.
  function defaultKickoff() {
    var d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(19, 5, 0, 0);
    return [
      d.getFullYear(),
      '-', String(d.getMonth() + 1).padStart(2, '0'),
      '-', String(d.getDate()).padStart(2, '0'),
      'T', String(d.getHours()).padStart(2, '0'),
      ':', String(d.getMinutes()).padStart(2, '0'),
    ].join('');
  }

  function newError(message) {
    var box = el('ad-new-error');
    text(box, message);
    show(box);
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderProperties() {
    var row = el('ad-new-property-row');
    var sel = el('ad-new-property');
    sel.innerHTML = '';
    state.properties.forEach(function (p) {
      sel.appendChild(new Option(p.name, p.id));
    });
    if (state.defaultProperty) sel.value = state.defaultProperty;
    // One property is not a choice. Two is.
    if (state.properties.length > 1) show(row); else hide(row);
  }

  function renderTemplates() {
    var wrap = el('ad-new-templates');
    wrap.innerHTML = '';

    var blank = make('button', 'ad-pick-opt' + (state.newTemplate ? '' : ' is-on'));
    blank.type = 'button';
    var bl = make('span', 'ad-pick-line');
    bl.appendChild(make('span', 'ad-pick-name', 'Start blank'));
    blank.appendChild(bl);
    blank.appendChild(make('span', 'ad-pick-left', 'type everything yourself'));
    blank.addEventListener('click', function () { applyTemplate(null); });
    wrap.appendChild(blank);

    state.templates.forEach(function (t) {
      var on = state.newTemplate && state.newTemplate.id === t.id;
      var opt = make('button', 'ad-pick-opt' + (on ? ' is-on' : ''));
      opt.type = 'button';

      var line = make('span', 'ad-pick-line');
      line.appendChild(make('span', 'ad-pick-name', t.name));
      var tiers = t.tiers || [];
      if (tiers.length) {
        var cheapest = tiers.reduce(function (lo, x) {
          return lo == null || x.price_cents < lo ? x.price_cents : lo;
        }, null);
        line.appendChild(make('span', 'ad-pick-price', 'from ' + money(cheapest)));
      }
      opt.appendChild(line);
      opt.appendChild(make('span', 'ad-pick-left',
        tiers.length + ' option' + (tiers.length === 1 ? '' : 's') +
        ' · ' + t.venue));

      opt.addEventListener('click', function () { applyTemplate(t); });
      wrap.appendChild(opt);
    });
  }

  // A template fills the form in; it does not lock it. Everything it wrote
  // is an ordinary field afterwards, which is the whole point of having the
  // modal rather than a "make one of these" button.
  function applyTemplate(t) {
    state.newTemplate = t;

    if (t) {
      if (t.event_name) el('ad-new-name').value = t.event_name;
      el('ad-new-venue').value = t.venue || 'Eden Park';
      el('ad-new-status').value = t.status || 'draft';
      el('ad-new-demand').value = t.demand_tier || 'standard';
      el('ad-new-gates').value = String(Math.abs(t.gates_open_minutes != null
        ? t.gates_open_minutes : -150));
      el('ad-new-stop').value = t.online_close_minutes == null
        ? '' : String(Math.abs(t.online_close_minutes));
      el('ad-new-template-name').value = t.name;
      if (t.property_id) el('ad-new-property').value = t.property_id;
      state.newEndMinutes = t.expected_end_minutes != null ? t.expected_end_minutes : 150;
      state.newTiers = (t.tiers || []).map(tierDraft);
    } else {
      el('ad-new-template-name').value = '';
      state.newEndMinutes = 150;
      state.newTiers = [];
    }

    renderTemplates();
    renderNewTiers();
  }

  // Rebuilt only when a row is added or removed. Typing updates the draft
  // behind the field: re-rendering on every keystroke would take the cursor
  // out of whatever is being typed into.
  function renderNewTiers() {
    var wrap = el('ad-new-tiers');
    wrap.innerHTML = '';

    if (!state.newTiers.length) {
      wrap.appendChild(make('p', 'ad-empty',
        'Nothing on sale yet. Pick a template above, or add an option.'));
      return;
    }

    state.newTiers.forEach(function (t, i) {
      var row = make('div', 'ad-tier');

      var top = make('div', 'ad-tier-top');
      var code = make('input', 'ad-input ad-tier-code');
      code.type = 'text';
      code.value = t.code;
      code.placeholder = 'code';
      code.setAttribute('aria-label', 'Tier code');
      code.autocapitalize = 'none';
      code.spellcheck = false;
      code.addEventListener('input', function () { t.code = this.value; });
      top.appendChild(code);

      var drop = button('ad-tier-drop', '×', function () {
        state.newTiers.splice(i, 1);
        renderNewTiers();
      });
      drop.setAttribute('aria-label', 'Remove this option');
      top.appendChild(drop);
      row.appendChild(top);

      var label = make('input', 'ad-input ad-tier-label');
      label.type = 'text';
      label.value = t.label;
      label.placeholder = 'What the customer reads';
      label.setAttribute('aria-label', 'Tier label');
      label.maxLength = 160;
      label.addEventListener('input', function () { t.label = this.value; });
      row.appendChild(label);

      var entry = make('div', 'ad-price-entry');
      entry.appendChild(make('span', null, '$'));
      var price = make('input', 'ad-input');
      price.type = 'number';
      price.inputMode = 'numeric';
      price.min = '1';
      price.max = '500';
      price.step = '1';
      price.value = t.price_cents ? String(Math.round(t.price_cents / 100)) : '';
      price.setAttribute('aria-label', 'Price in dollars');
      price.addEventListener('input', function () {
        var dollars = Number(this.value);
        t.price_cents = isFinite(dollars) ? Math.round(dollars * 100) : 0;
      });
      entry.appendChild(price);
      row.appendChild(entry);

      wrap.appendChild(row);
    });
  }

  // What the two save buttons both send. The database is the thing that
  // validates it — this only catches what it can say something useful about
  // without a round trip.
  function newPayload(needsDate) {
    var name = el('ad-new-name').value.trim();
    var when = el('ad-new-date').value;
    var gates = Number(el('ad-new-gates').value);
    var closes = el('ad-new-stop').value.trim();

    if (needsDate && !name) throw new Error('The event needs a name.');
    if (needsDate && !when) throw new Error('Pick a kickoff date and time.');
    if (!state.newTiers.length) throw new Error('Add at least one thing to sell.');

    var tiers = state.newTiers.map(function (t, i) {
      var code = String(t.code || '').trim().toLowerCase();
      if (!code) throw new Error('Every option needs a short code — "standard", say.');
      if (!(t.price_cents >= 100 && t.price_cents <= 50000)) {
        throw new Error('Price ' + code + ' between $1 and $500.');
      }
      return {
        code: code,
        label: String(t.label || '').trim() || null,
        price_cents: t.price_cents,
        zone_codes: t.zone_codes,
        bay_kind: t.bay_kind,
        guarantees_clear_exit: t.guarantees_clear_exit,
        arrival_from_minutes: t.arrival_from_minutes,
        arrival_until_minutes: t.arrival_until_minutes,
        departure_by_minutes: t.departure_by_minutes,
        sort_order: i + 1,
      };
    });

    return {
      name: name,
      starts_at_local: when,
      venue: el('ad-new-venue').value.trim() || 'Eden Park',
      status: el('ad-new-status').value,
      demand_tier: el('ad-new-demand').value,
      property_id: state.properties.length > 1
        ? el('ad-new-property').value
        : (state.defaultProperty || null),
      // Typed as "how long before kickoff", stored as a signed offset.
      gates_open_minutes: isFinite(gates) ? -Math.abs(gates) : -150,
      online_close_minutes: closes === '' ? null : -Math.abs(Number(closes)),
      expected_end_minutes: state.newEndMinutes,
      tiers: tiers,
      // The time in the box is a wall clock, not an instant. Send the zone
      // the phone is in so a session run from anywhere else still means
      // 7:05pm at the ground.
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || TZ,
    };
  }

  function submitNew(e) {
    e.preventDefault();
    var payload;
    try {
      payload = newPayload(true);
    } catch (err) {
      newError(err.message);
      return;
    }

    var btn = el('ad-new-save');
    btn.disabled = true;
    el('ad-new-error').hidden = true;

    call('create_event', payload)
      .then(function (data) {
        hide(el('ad-new'));
        toast(payload.name + ' created', 'good');
        // Land on the event that was just made, rather than leaving the
        // screen on whatever was selected before it existed.
        return call('events').then(function (list) {
          state.events = list.events || [];
          state.eventId = data.event_id;
          renderEventOptions();
          el('ad-event').value = state.eventId;
          return loadList();
        });
      })
      .catch(function (err) { newError(err.message); })
      .finally(function () { btn.disabled = false; });
  }

  function saveTemplate() {
    var payload;
    try {
      // A template deliberately keeps no date, so it does not need one
      // typed before it can be saved.
      payload = newPayload(false);
    } catch (err) {
      newError(err.message);
      return;
    }

    var templateName = el('ad-new-template-name').value.trim();
    if (!templateName) {
      newError('Give the template a name — that is what you pick it from next time.');
      el('ad-new-template-name').focus();
      return;
    }

    var btn = el('ad-new-save-template');
    btn.disabled = true;
    el('ad-new-error').hidden = true;

    // The date is the one thing a template deliberately does not keep.
    payload.template_name = templateName;
    delete payload.starts_at_local;
    delete payload.timezone;

    call('save_template', payload)
      .then(function () {
        toast('Template "' + templateName + '" saved', 'good');
        return call('event_form').then(function (data) {
          state.templates = data.templates || [];
          // Stay on the template just saved, so "save as template" then
          // "save event" is one continuous thing rather than two.
          state.newTemplate = state.templates.filter(function (t) {
            return t.name === templateName;
          })[0] || null;
          renderTemplates();
        });
      })
      .catch(function (err) { newError(err.message); })
      .finally(function () { btn.disabled = false; });
  }

  /* -------------------------------------------------------- walk-up sale */

  // Opening the sheet does not wipe it. A walk-up closed half-typed — the
  // driver went to find their wallet, the terminal would not connect — comes
  // back as it was left. Only a sale that went through clears it.
  function openSell() {
    el('ad-sell-error').hidden = true;
    // The type picked last time may have filled up since.
    var still = state.tiers.filter(function (t) {
      return t.code === state.sellTier && !t.manually_sold_out && t.spots_left_gate > 0;
    })[0];
    if (!still) state.sellTier = null;
    renderSellTiers();
    renderSellExtras();
    renderSellCharge();
    show(el('ad-sell'));
  }

  function clearSell() {
    el('ad-sell-form').reset();
    state.sellTier = null;
    state.sellExtras = {};
  }

  function renderSellTiers() {
    var wrap = el('ad-sell-tiers');
    wrap.innerHTML = '';
    var tiers = inGateOrder(state.tiers);

    // Default to the first thing still sellable, which once a type is full
    // is the next one up. That is the whole point of the ordering.
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
    var later = method === 'unpaid';
    el('ad-sell-later-hint').hidden = !later;
    text(el('ad-sell-charge-total-label'), later ? 'They will owe' : 'Charge them');
    text(el('ad-sell-submit'), later ? 'Save — they pay later' : 'Take the money');
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
      vehicle_low_clearance: form.selllow.checked,
      addons: addons,
    })
      .then(function (data) {
        hide(el('ad-sell'));
        var plate = form.rego.value.trim().toUpperCase();
        var later = form.payment.value === 'unpaid';
        clearSell();
        if (data.addons_failed) {
          toast('Space sold, but the extras did not save — take that cash', 'bad');
        } else {
          // The charged figure comes back from the database rather than being
          // repeated from the screen, so a rate that changed mid-night shows
          // up here rather than being quietly wrong.
          var charged = data.charge_cents != null ? ' · ' + money(data.charge_cents) : '';
          toast((later ? 'Saved, to pay later' : 'Sold') + (plate ? ' — ' + plate : '') +
            charged, 'good');
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

  /* ----------------------------------------------------- one booking */

  var METHOD_NAMES = {
    stripe: 'Card online', tap_to_pay: 'Card (tap to pay)', cash: 'Cash',
    bank_transfer: 'Bank transfer', free: 'Free / comp', other: 'Other',
    unpaid: 'Not paid yet',
  };

  // Everything that can be wrong about a booking once it exists: the plate,
  // how to reach them, how they paid, and which type of space they actually
  // took. Opened by tapping the row.
  function openEdit(r) {
    state.edit = r;
    state.editTier = r.tier_code;
    var form = el('ad-edit-form');
    form.reset();
    el('ad-edit-error').hidden = true;

    text(el('ad-edit-title'), r.vehicle_rego || 'Booking');
    var sub = [r.channel === 'gate' ? 'Sold at the gate' : 'Booked online'];
    if (r.arrived) sub.push('ticked in');
    if (r.in_checkout) sub.push('still paying online');
    text(el('ad-edit-sub'), sub.join(' · '));

    form.rego.value = r.vehicle_rego || '';
    form.editname.value = r.customer_name || '';
    form.editphone.value = r.customer_phone || '';
    form.editemail.value = r.customer_email || '';
    form.editlow.checked = !!r.vehicle_low_clearance;
    form.editnotes.value = r.notes || '';

    // A card payment on the website is Stripe's record, not ours to relabel;
    // an online checkout still running is about to be settled by Stripe. In
    // both cases the method is shown and left alone.
    var pay = el('ad-edit-payment');
    var online = r.payment_method === 'stripe';
    pay.value = r.payment_method || 'cash';
    pay.disabled = online || !!r.in_checkout;
    var payHint = el('ad-edit-payment-hint');
    if (online || r.in_checkout) {
      text(payHint, r.in_checkout
        ? 'They are still paying on the website. This fills in when they finish.'
        : 'Paid by card on the website — Stripe holds that record.');
      show(payHint);
    } else {
      hide(payHint);
    }

    el('ad-edit-cancel').hidden = !r.owes;

    renderEditTiers();
    renderEditCharge();
    show(el('ad-edit'));
  }

  function renderEditTiers() {
    var r = state.edit;
    var wrap = el('ad-edit-tiers');
    wrap.innerHTML = '';
    var tiers = inGateOrder(state.tiers);

    tiers.forEach(function (t) {
      var current = t.code === r.tier_code;
      // Its own space is counted in its own tier, so the tier it is in is
      // never "full" as far as this booking is concerned.
      var full = !current && (t.manually_sold_out || t.spots_left_gate <= 0);
      var opt = make('button', 'ad-pick-opt' + tierClass(t.code) +
        (state.editTier === t.code ? ' is-on' : '') +
        (current ? ' is-current' : '') + (full ? ' is-gone' : ''));
      opt.type = 'button';
      opt.disabled = full || !!r.in_checkout;

      var line = make('span', 'ad-pick-line');
      line.appendChild(make('span', 'ad-pick-name', shortName(t)));
      line.appendChild(make('span', 'ad-pick-price', money(t.price_cents)));
      opt.appendChild(line);
      opt.appendChild(make('span', 'ad-pick-left',
        current ? 'booked as this'
          : full ? 'full — add a space on Tonight first'
          : t.spots_left_gate + ' left'));

      opt.addEventListener('click', function () {
        state.editTier = t.code;
        renderEditTiers();
        renderEditCharge();
      });
      wrap.appendChild(opt);
    });
  }

  // What the booking will be worth once saved, worked out the way the
  // database will: a paid booking that moves keeps what it paid; an unpaid
  // one takes the new space's price. The database still records the figure.
  function editAmounts() {
    var r = state.edit;
    var method = el('ad-edit-payment').value;
    var moved = state.editTier !== r.tier_code;
    var tier = state.tiers.filter(function (t) { return t.code === state.editTier; })[0];
    var paid = r.status === 'paid';
    var space = moved && !paid && tier ? tier.price_cents : (r.amount_cents || 0);
    var sub = space + (r.addons_cents || 0);
    var surcharge = method === r.payment_method && !moved
      ? (r.surcharge_cents || 0)
      : surchargeOn(sub, method);
    return { method: method, moved: moved, tier: tier, paid: paid, total: sub + surcharge };
  }

  function renderEditCharge() {
    var r = state.edit;
    if (!r) return;
    var a = editAmounts();

    var hint = el('ad-edit-move-hint');
    if (a.moved && a.tier) {
      text(hint, a.paid
        ? 'Moves them to ' + shortName(a.tier) + ' and frees their ' +
          r.tier_code.replace(/_/g, ' ') + ' space. What they paid stays as it was — ' +
          'no refund, nothing extra to charge.'
        : 'Moves them to ' + shortName(a.tier) + '. Not paid yet, so they owe the ' +
          shortName(a.tier) + ' price.');
      show(hint);
    } else {
      hide(hint);
    }

    var nowPaying = r.owes && a.method !== 'unpaid';
    var label = a.method === 'unpaid' ? 'They owe'
      : nowPaying ? 'Charge them'
      : 'Paid';
    text(el('ad-edit-charge-label'), label);
    text(el('ad-edit-charge-total'), money(a.total));

    text(el('ad-edit-submit'), nowPaying
      ? 'Paid by ' + METHOD_NAMES[a.method].toLowerCase() + ' — ' + money(a.total)
      : 'Save');
  }

  function submitEdit(e) {
    e.preventDefault();
    var r = state.edit;
    if (!r) return;
    var form = el('ad-edit-form');
    var btn = el('ad-edit-submit');
    var box = el('ad-edit-error');
    box.hidden = true;

    var params = {
      booking_id: r.booking_id,
      vehicle_rego: form.rego.value.trim(),
      name: form.editname.value.trim(),
      phone: form.editphone.value.trim(),
      // Blank leaves the address it has: a booking must keep one.
      email: form.editemail.value.trim(),
      vehicle_low_clearance: form.editlow.checked,
      notes: form.editnotes.value.trim(),
    };
    var pay = el('ad-edit-payment');
    if (!pay.disabled && pay.value !== r.payment_method) params.payment_method = pay.value;
    if (state.editTier && state.editTier !== r.tier_code) params.tier_code = state.editTier;

    btn.disabled = true;
    call('edit_booking', params)
      .then(function (data) {
        hide(el('ad-edit'));
        var b = data.booking || {};
        var who = form.rego.value.trim().toUpperCase() || 'Booking';
        var said = [];
        if (params.tier_code) said.push('moved to ' + params.tier_code.replace(/_/g, ' '));
        if (params.payment_method) {
          said.push(params.payment_method === 'unpaid' ? 'marked not paid'
            : 'paid ' + money(b.total_cents));
        }
        toast(who + ' — ' + (said.length ? said.join(', ') : 'saved'), 'good');
        state.edit = null;
        return loadList(true);
      })
      .catch(function (err) {
        text(box, err.message);
        show(box);
      })
      .finally(function () { btn.disabled = false; });
  }

  function cancelUnpaid() {
    var r = state.edit;
    if (!r || !r.owes) return;
    if (!window.confirm('Cancel ' + (r.vehicle_rego || 'this booking') +
        '? The space goes back on sale.')) return;
    call('cancel_unpaid', { booking_id: r.booking_id })
      .then(function () {
        hide(el('ad-edit'));
        state.edit = null;
        toast((r.vehicle_rego || 'Booking') + ' cancelled', 'good');
        return loadList(true);
      })
      .catch(function (err) {
        var box = el('ad-edit-error');
        text(box, err.message);
        show(box);
      });
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

    post(CFG.supabaseUrl + '/functions/v1/check-setup', {})
      .then(function (d) {
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
  // The tier headings then park under the search bar, so measure that too —
  // its height moves with the font size the phone is set to.
  function measureHead() {
    var head = el('ad-head') || document.querySelector('.ad-head');
    if (head) {
      document.documentElement.style.setProperty(
        '--ad-head-h', head.offsetHeight + 'px');
    }
    var tools = document.querySelector('#ad-pane-gate .ad-tools');
    if (tools) {
      document.documentElement.style.setProperty(
        '--ad-tools-h', tools.offsetHeight + 'px');
    }
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
    el('ad-signin').addEventListener('click', function () {
      AUTH.signInWithGoogle();
    });

    el('ad-lock-swap').addEventListener('click', function () {
      AUTH.signInWithGoogle({ chooseAccount: true });
    });

    el('ad-signout').addEventListener('click', function () {
      AUTH.signOut().then(function () {
        state.who = null;
        window.location.reload();
      });
    });

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

    el('ad-new-open').addEventListener('click', openNew);
    el('ad-new-close').addEventListener('click', function () { hide(el('ad-new')); });
    el('ad-new-form').addEventListener('submit', submitNew);
    el('ad-new-save-template').addEventListener('click', saveTemplate);
    el('ad-new-tier-add').addEventListener('click', function () {
      state.newTiers.push(tierDraft());
      renderNewTiers();
    });

    el('ad-sell-open').addEventListener('click', openSell);
    el('ad-sell-close').addEventListener('click', function () { hide(el('ad-sell')); });
    el('ad-sell-form').addEventListener('submit', submitSell);
    // Cash and card are different numbers. Switching the method has to move
    // the figure being read out, not just what gets recorded.
    el('ad-sell-payment').addEventListener('change', renderSellCharge);

    el('ad-edit-close').addEventListener('click', function () { hide(el('ad-edit')); });
    el('ad-edit-form').addEventListener('submit', submitEdit);
    el('ad-edit-payment').addEventListener('change', renderEditCharge);
    el('ad-edit-cancel').addEventListener('click', cancelUnpaid);

    el('ad-pricepick-select').addEventListener('change', paintPricePick);
    el('ad-pricepick-apply').addEventListener('click', applyPricePick);

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

    // Coming back from Google with the person having cancelled, or with a
    // redirect URL the project does not allow: say what happened rather
    // than showing the same button as if nothing had been pressed.
    if (AUTH.landingError) {
      showSignIn(AUTH.landingError);
      return;
    }

    // A session on this device gets straight back in — but only because
    // the server said so. openSession() failing routes through post()'s
    // 401/403 handling and puts the card up on its own; anything else
    // (offline, Supabase down) says so and leaves the button there to
    // press again.
    if (!AUTH.hasSession()) {
      showSignIn(null);
      return;
    }

    openSession().catch(function (err) {
      if (err && (err.status === 401 || err.status === 403)) return;
      showSignIn(err.message, err.code);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
