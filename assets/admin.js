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
    if (r.accepts_street_parking && r.channel === 'online') {
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

    // Valet holds keys, so those cars are already movable by hand and do not
    // need this. Anything already out on the verge has nowhere further to go.
    var inOverflow = /overflow/i.test(String(r.zone_label || ''));
    if (!inOverflow && r.tier_code !== 'valet') {
      var move = make('button', 'ad-move', '\u2192 Overflow');
      move.type = 'button';
      move.title = 'Move this car to overflow and free its bay';
      move.disabled = !!state.busy[r.booking_id];
      move.addEventListener('click', function () { moveToOverflow(r, move); });
      actions.appendChild(move);
    }

    card.appendChild(actions);

    return card;
  }

  // Moving a prepaid car out to the verge puts its bay back on sale. That is
  // the point: when there is a queue at the gate, a Standard sitting in the
  // back yard is worth more to you parked on the overflow.
  function moveToOverflow(r, btn) {
    var who = r.vehicle_rego || r.customer_name || 'this car';

    function go(confirmedConsent) {
      state.busy[r.booking_id] = true;
      btn.disabled = true;
      call('move_to_overflow', {
        booking_id: r.booking_id,
        confirmed_consent: confirmedConsent === true,
      })
        .then(function (data) {
          toast(who + ' moved to ' + (data.moved_to || 'overflow'), 'good');
          return loadList(true);
        })
        .catch(function (err) {
          if (err.code === 'NEEDS_CONSENT' || /did not agree/.test(err.message)) {
            if (window.confirm(
              who + ' did not tick the overflow box when booking.\n\n' +
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
          btn.disabled = false;
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
    text(el('ad-check-summary'), 'Checking\u2026');
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
            c.ok === true ? '\u2713' : c.ok === false ? '\u2715' : '?');
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
