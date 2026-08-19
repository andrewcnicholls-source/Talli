/* =====================================================================
   Talli Parking — gate screen

   Built for one hand, outdoors, at night. The list is the page: search by
   the first few characters of a plate, tap the row, the car is ticked off.
   Everything else is secondary.

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
    tiers: [],
    filter: '',
    busy: {},
  };

  function el(id) { return document.getElementById(id); }
  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }

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

  /* --------------------------------------------------------- the list */

  function loadList(quiet) {
    if (!state.eventId) return;
    if (!quiet) el('ad-list').setAttribute('aria-busy', 'true');

    return call('list', { event_id: state.eventId })
      .then(function (data) {
        state.rows = data.rows || [];
        renderSummary(data.summary);
        renderList();
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

    var rows = state.rows.filter(matches);

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

    var who = [r.customer_name, r.customer_phone].filter(Boolean).join(' · ');
    if (who) main.appendChild(make('div', 'ad-who', who));

    var meta = make('div', 'ad-meta');
    if (r.tier_code) meta.appendChild(make('span', 'ad-chip', r.tier_code.replace(/_/g, ' ')));
    if (r.arrival_from && r.arrival_until) {
      meta.appendChild(make('span', 'ad-chip', asTime(r.arrival_from) + '–' + asTime(r.arrival_until)));
    }
    if (r.must_depart_by) {
      meta.appendChild(make('span', 'ad-chip is-warn', 'out by ' + asTime(r.must_depart_by)));
    }
    if (r.payment_method && r.payment_method !== 'stripe') {
      meta.appendChild(make('span', 'ad-chip is-cash', r.payment_method + ' ' + money(r.amount_cents)));
    }
    if (r.status === 'held') meta.appendChild(make('span', 'ad-chip is-warn', 'unpaid hold'));
    if (r.accepts_street_parking) meta.appendChild(make('span', 'ad-chip', 'berm ok'));
    main.appendChild(meta);

    card.appendChild(main);

    var btn = make('button', 'ad-tick' + (r.arrived ? ' is-on' : ''),
      r.arrived ? 'Here' : 'Tick in');
    btn.type = 'button';
    btn.disabled = !!state.busy[r.booking_id];
    btn.addEventListener('click', function () { toggleArrived(r, btn); });
    card.appendChild(btn);

    return card;
  }

  function toggleArrived(r, btn) {
    var action = r.arrived ? 'undo_check_in' : 'check_in';
    state.busy[r.booking_id] = true;
    btn.disabled = true;

    call(action, { booking_id: r.booking_id })
      .then(function () {
        r.arrived = !r.arrived;
        toast(r.vehicle_rego + (r.arrived ? ' ticked in' : ' un-ticked'), 'good');
        return loadList(true);
      })
      .catch(function (err) { toast(err.message, 'bad'); })
      .finally(function () {
        delete state.busy[r.booking_id];
        btn.disabled = false;
      });
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
      vehicle_rego: form.rego.value.trim(),
      name: form.sellname.value.trim() || null,
      phone: form.sellphone.value.trim() || null,
      accepts_street: form.sellstreet.checked,
    })
      .then(function () {
        hide(el('ad-sell'));
        toast('Sold — ' + form.rego.value.trim().toUpperCase(), 'good');
        return loadList(true);
      })
      .catch(function (err) {
        var box = el('ad-sell-error');
        box.textContent = err.message;
        show(box);
      })
      .finally(function () { btn.disabled = false; });
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

    el('ad-sell-open').addEventListener('click', openSell);
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
