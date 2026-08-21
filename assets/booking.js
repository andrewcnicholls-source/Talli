/* =====================================================================
   Talli Parking — booking flow

   Three steps, revealed one at a time: pick the event, pick the tier,
   give us your details. The last step posts to the create-checkout edge
   function, which holds a real bay before it ever talks to Stripe, and
   hands back a Checkout URL to redirect to.

   No price is ever sent from here. The browser names a tier and, if they
   want them, a few extras; the database decides what all of that costs.
   The totals shown on this page are a preview, not the invoice.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var REST = CFG.supabaseUrl + '/rest/v1';
  var FN = CFG.supabaseUrl + '/functions/v1';
  var TZ = 'Pacific/Auckland';
  var HEADLINE = CFG.headlineTiers || [];

  var state = {
    event: null,
    tiers: [],
    tier: null,
    extras: [],      // the catalogue, as the database has it
    picked: {},      // code -> quantity
    interestEvent: null,
    submitting: false,
  };

  /* ---------------------------------------------------------------- utils */

  function el(id) { return document.getElementById(id); }

  function money(cents) {
    var dollars = cents / 100;
    return '$' + (cents % 100 === 0 ? dollars.toFixed(0) : dollars.toFixed(2));
  }

  function fmt(iso, opts) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString('en-NZ', Object.assign({ timeZone: TZ }, opts));
  }

  var asDate = function (iso) {
    return fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  var asTime = function (iso) {
    return fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true })
      .replace(/\s/g, '')
      .toLowerCase();
  };

  function text(node, value) { node.textContent = value; return node; }

  // Mirrors addon_price_cents() in the database so the page can show a running
  // total. The database still does the sum that gets charged — this one only
  // has to be right enough to be honest on screen.
  function extraTotal(item, qty) {
    if (qty <= 0) return 0;
    if (!item.bundle_qty || !item.bundle_price_cents) return item.price_cents * qty;
    return Math.min(
      item.price_cents * qty,
      Math.floor(qty / item.bundle_qty) * item.bundle_price_cents +
        (qty % item.bundle_qty) * item.price_cents
    );
  }

  // "$3 each, or 2 for $5" — the same sentence as the sign in the driveway.
  function extraPriceLine(item) {
    var each = money(item.price_cents) + ' each';
    return item.bundle_qty
      ? each + ', or ' + item.bundle_qty + ' for ' + money(item.bundle_price_cents)
      : each;
  }

  function pickedList() {
    return state.extras
      .map(function (item) {
        return { item: item, qty: state.picked[item.code] || 0 };
      })
      .filter(function (line) { return line.qty > 0; });
  }

  function extrasTotal() {
    return pickedList().reduce(function (sum, line) {
      return sum + extraTotal(line.item, line.qty);
    }, 0);
  }

  function make(tag, className, content) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.textContent = content;
    return n;
  }

  function show(node) { node.hidden = false; }

  function reveal(node) {
    show(node);
    // Let the browser paint the newly shown step before scrolling to it.
    requestAnimationFrame(function () {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function fail(message) {
    var box = el('bk-error');
    text(box, message);
    show(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearError() { el('bk-error').hidden = true; }

  /* ------------------------------------------------------------ transport */

  function read(path) {
    return fetch(REST + path, {
      headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey },
    }).then(function (res) {
      if (!res.ok) throw new Error('Could not reach the booking system (' + res.status + ')');
      return res.json();
    });
  }

  /* --------------------------------------------------------- step 1: event */

  function loadEvents() {
    var list = el('bk-events');
    read(
      '/event?status=in.(on_sale,announced)&order=starts_at.asc' +
      '&select=id,name,venue,starts_at,gates_open_at,online_sales_close_at,status'
    )
      .then(function (events) {
        var now = Date.now();

        var listed = events
          .filter(function (e) { return new Date(e.starts_at) > now; })
          .map(function (e) {
            // Sales close before kick-off. Past that the fixture is still worth
            // showing — people do turn up on the night — but it cannot be booked.
            var closed = !!e.online_sales_close_at &&
                         new Date(e.online_sales_close_at) <= now;
            e.sellable = e.status === 'on_sale' && !closed;
            e.closed = closed;
            return e;
          });

        list.innerHTML = '';

        if (!listed.length) {
          list.appendChild(
            make(
              'p',
              'bk-empty',
              'Nothing on the calendar just now. We take arrivals on the night ' +
              'as well — come to 86 Paice Ave and ask the marshal.'
            )
          );
          return;
        }

        listed.forEach(function (ev) { list.appendChild(eventCard(ev)); });
      })
      .catch(function (err) {
        list.innerHTML = '';
        list.appendChild(make('p', 'bk-empty', err.message));
      });
  }

  // People pick a night, not an opponent — you go to support your team, and the
  // date is the thing you have to fit around. So the date leads, big enough to
  // read at a glance, and the fixture sits beside it.
  function eventCard(ev) {
    var d = new Date(ev.starts_at);
    var row = make(ev.sellable ? 'label' : 'button',
      'bk-fixture' + (ev.sellable ? '' : ' is-unsellable'));

    if (ev.sellable) {
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'bk-event';
      input.value = ev.id;
      input.className = 'bk-radio bk-radio-fixture';
      input.addEventListener('change', function () { chooseEvent(ev); });
      row.appendChild(input);
    } else {
      row.type = 'button';
      row.addEventListener('click', function () { openInterest(ev); });
    }

    var date = make('span', 'bk-date');
    date.appendChild(make('span', 'bk-date-dow', fmt(ev.starts_at, { weekday: 'short' })));
    date.appendChild(make('span', 'bk-date-day', String(d.getDate())));
    date.appendChild(make('span', 'bk-date-mon', fmt(ev.starts_at, { month: 'short' })));
    row.appendChild(date);

    var body = make('span', 'bk-fixture-body');
    body.appendChild(make('span', 'bk-card-title', ev.name));
    body.appendChild(make('span', 'bk-card-meta',
      asTime(ev.starts_at) + (ev.venue ? ' · ' + ev.venue : '')));

    if (!ev.sellable) {
      body.appendChild(make('span', 'bk-fixture-tag',
        ev.closed ? 'Online booking closed — tap to ask'
                  : 'Not bookable yet — tap to be told first'));
    }
    row.appendChild(body);

    return row;
  }

  /* ------------------------------------------------- interest in a fixture */

  function openInterest(ev) {
    state.interestEvent = ev;
    text(el('bk-interest-name'), ev.name);
    text(el('bk-interest-when'), asDate(ev.starts_at) + ' · ' + asTime(ev.starts_at));
    text(el('bk-interest-lead'), ev.closed
      ? 'Online booking has closed for this one. Leave your email and we\u2019ll let ' +
        'you know if a space frees up — or just come to 86 Paice Ave on the night.'
      : 'We haven\u2019t set prices for this one yet. Leave your email and you\u2019ll be ' +
        'the first to know when it opens.');
    el('bk-interest-error').hidden = true;
    el('bk-interest-done').hidden = true;
    el('bk-interest-form').hidden = false;
    el('bk-interest-form').reset();
    el('bk-interest').hidden = false;
  }

  function submitInterest(e) {
    e.preventDefault();
    var form = el('bk-interest-form');
    var button = el('bk-interest-submit');
    button.disabled = true;
    el('bk-interest-error').hidden = true;

    fetch(FN + '/register-interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify({
        event_id: state.interestEvent.id,
        email: form.interestemail.value.trim(),
        name: form.interestname.value.trim() || null,
      }),
    })
      .then(function (res) {
        return res.json().then(function (d) { return { ok: res.ok, data: d }; });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'That did not work.');
        el('bk-interest-form').hidden = true;
        text(el('bk-interest-done'), result.data.already
          ? 'You\u2019re already on the list for this one — we\u2019ll be in touch.'
          : 'Done. We\u2019ll email you the moment this one opens.');
        el('bk-interest-done').hidden = false;
      })
      .catch(function (err) {
        var box = el('bk-interest-error');
        text(box, err.message);
        box.hidden = false;
      })
      .finally(function () { button.disabled = false; });
  }

  function chooseEvent(ev) {
    state.event = ev;
    state.tier = null;
    el('bk-details').hidden = true;
    el('bk-extras-step').hidden = true;
    clearError();

    text(el('bk-tier-event'), ev.name + ' · ' + asDate(ev.starts_at));
    reveal(el('bk-tiers-step'));
    loadTiers(ev.id);
  }

  /* ---------------------------------------------------------- step 2: tier */

  function loadTiers(eventId) {
    var primary = el('bk-tiers');
    var extra = el('bk-tiers-more');
    primary.innerHTML = '';
    extra.innerHTML = '';
    el('bk-more-toggle').hidden = true;
    primary.appendChild(make('p', 'bk-empty', 'Loading options…'));

    read(
      '/v_tier_availability?event_id=eq.' + encodeURIComponent(eventId) +
      '&order=sort_order.asc'
    )
      .then(function (tiers) {
        state.tiers = tiers;
        primary.innerHTML = '';

        var sellable = tiers.filter(function (t) { return t.spots_left > 0; });
        if (!sellable.length) {
          primary.appendChild(
            make(
              'p',
              'bk-empty',
              'Everything for this event is sold out online. There may still be ' +
              'space on the night — come to 86 Paice Ave and ask the marshal.'
            )
          );
          return;
        }

        // Headline order follows the config list, not the database's
        // sort_order — the point of the trio is a deliberate running order.
        var headline = [];
        HEADLINE.forEach(function (code) {
          tiers.forEach(function (t) { if (t.code === code) headline.push(t); });
        });
        var rest = tiers.filter(function (t) { return headline.indexOf(t) === -1; });

        // If none of the usual three exist for this fixture, promote the first
        // few rather than hiding every option behind the toggle.
        if (!headline.length) {
          headline = rest.splice(0, 3);
        }

        headline.forEach(function (t) { primary.appendChild(tierCard(t)); });

        if (rest.length) {
          el('bk-more-toggle').hidden = false;
          rest.forEach(function (t) { extra.appendChild(tierCard(t)); });
        }
      })
      .catch(function (err) {
        primary.innerHTML = '';
        primary.appendChild(make('p', 'bk-empty', err.message));
      });
  }

  // The tier labels in the database read as "Standard — best value, expect to
  // wait". Split on the dash: the short name is the heading, the rest is the
  // explanation underneath.
  function splitLabel(label) {
    var parts = String(label || '').split(/\s+—\s+/);
    return { name: parts[0], detail: parts.slice(1).join(' — ') };
  }

  function tierCard(tier) {
    var soldOut = tier.spots_left <= 0;
    var label = make('label', 'bk-card bk-card-tier' + (soldOut ? ' is-soldout' : ''));
    var parts = splitLabel(tier.label);

    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bk-tier';
    input.value = tier.code;
    input.className = 'bk-radio';
    input.disabled = soldOut;
    input.addEventListener('change', function () { chooseTier(tier); });

    var body = make('span', 'bk-card-body');

    var head = make('span', 'bk-tier-head');
    head.appendChild(make('span', 'bk-card-title', parts.name));
    head.appendChild(make('span', 'bk-tier-price', money(tier.price_cents)));
    body.appendChild(head);

    if (parts.detail) body.appendChild(make('span', 'bk-card-meta', parts.detail));

    var facts = make('span', 'bk-tier-facts');
    if (tier.arrival_from && tier.arrival_until) {
      facts.appendChild(
        make('span', 'bk-fact', 'Arrive ' + asTime(tier.arrival_from) + '–' + asTime(tier.arrival_until))
      );
    }
    // Not "leave by". Nobody leaves an event early — but the car at the front
    // of a stack blocks the one behind it, so it has to be back promptly.
    if (tier.departure_by) {
      facts.appendChild(make('span', 'bk-fact bk-fact-warn',
        'Back at your car by ' + asTime(tier.departure_by)));
    }
    if (soldOut) {
      facts.appendChild(make('span', 'bk-fact bk-fact-warn', 'Sold out online'));
    } else if (tier.spots_left <= 3) {
      facts.appendChild(
        make('span', 'bk-fact bk-fact-low', tier.spots_left + (tier.spots_left === 1 ? ' left' : ' left'))
      );
    }
    if (facts.childNodes.length) body.appendChild(facts);

    label.appendChild(input);
    label.appendChild(body);
    return label;
  }

  /* -------------------------------------------------------- step 3: extras */

  // One catalogue, drawn twice: as steppers inside the booking flow, and as
  // the shop window further down the page. Both read the same rows, so a
  // price can never be right in one place and stale in the other.
  function loadExtras() {
    read('/addon?active=is.true&order=sort_order.asc' +
         '&select=code,name,blurb,image_path,price_cents,bundle_qty,bundle_price_cents,max_qty')
      .then(function (items) {
        state.extras = items || [];
        renderExtras();
        renderMerch();
      })
      .catch(function () {
        // Extras are a nicety. If the catalogue will not load, the booking
        // still has to work, so the step simply stays empty.
        state.extras = [];
      });
  }

  function renderExtras() {
    var wrap = el('bk-extras');
    wrap.innerHTML = '';
    if (!state.extras.length) return;
    state.extras.forEach(function (item) { wrap.appendChild(extraCard(item)); });
    // Every card starts at zero, so every minus starts dead. Without this the
    // buttons only settle into a correct state after the first tap.
    paintExtras();
  }

  function extraCard(item) {
    var card = make('div', 'bk-extra');
    card.dataset.code = item.code;

    if (item.image_path) {
      var shot = make('div', 'bk-extra-shot');
      var img = document.createElement('img');
      img.src = item.image_path;
      img.alt = '';
      img.loading = 'lazy';
      shot.appendChild(img);
      card.appendChild(shot);
    }

    var body = make('div', 'bk-extra-body');
    body.appendChild(make('span', 'bk-extra-name', item.name));
    if (item.blurb) body.appendChild(make('span', 'bk-extra-blurb', item.blurb));
    body.appendChild(make('span', 'bk-extra-price', extraPriceLine(item)));
    card.appendChild(body);

    var step = make('div', 'bk-step-count');

    var less = make('button', 'bk-count-btn', '\u2212');
    less.type = 'button';
    less.setAttribute('aria-label', 'One fewer ' + item.name);
    less.addEventListener('click', function () { bump(item, -1); });

    var count = make('span', 'bk-count', '0');

    var more = make('button', 'bk-count-btn', '+');
    more.type = 'button';
    more.setAttribute('aria-label', 'One more ' + item.name);
    more.addEventListener('click', function () { bump(item, 1); });

    step.appendChild(less);
    step.appendChild(count);
    step.appendChild(more);
    card.appendChild(step);

    return card;
  }

  function bump(item, by) {
    var max = item.max_qty || 10;
    var next = Math.min(Math.max((state.picked[item.code] || 0) + by, 0), max);
    if (next === 0) delete state.picked[item.code];
    else state.picked[item.code] = next;
    paintExtras();
    paintSummary();
  }

  function paintExtras() {
    var cards = el('bk-extras').querySelectorAll('.bk-extra');
    Array.prototype.forEach.call(cards, function (card) {
      var qty = state.picked[card.dataset.code] || 0;
      card.classList.toggle('is-picked', qty > 0);
      text(card.querySelector('.bk-count'), String(qty));
      var buttons = card.querySelectorAll('.bk-count-btn');
      buttons[0].disabled = qty === 0;
    });
  }

  // The same items again at the foot of the page, for anyone reading rather
  // than booking.
  function renderMerch() {
    var grid = el('bk-merch');
    if (!grid) return;
    grid.innerHTML = '';
    state.extras.forEach(function (item) {
      var cell = make('div', 'merch-item');
      if (item.image_path) {
        var photo = make('div', 'merch-photo');
        var img = document.createElement('img');
        img.src = item.image_path;
        img.alt = item.name;
        img.loading = 'lazy';
        photo.appendChild(img);
        cell.appendChild(photo);
      }
      var body = make('div', 'merch-body');
      body.appendChild(make('h3', null, item.name));
      body.appendChild(make('p', null, extraPriceLine(item)));
      cell.appendChild(body);
      grid.appendChild(cell);
    });
  }

  /* ------------------------------------------------------- the money so far */

  function paintSummary() {
    if (!state.tier) return;

    var lines = pickedList();
    var box = el('bk-summary-extras');
    box.innerHTML = '';

    lines.forEach(function (line) {
      var row = make('div', 'bk-summary-line bk-summary-extra');
      row.appendChild(make('span', null,
        line.item.name + (line.qty > 1 ? ' \u00d7 ' + line.qty : '')));
      row.appendChild(make('span', null, money(extraTotal(line.item, line.qty))));
      box.appendChild(row);
    });
    box.hidden = lines.length === 0;

    var total = el('bk-summary-total');
    if (lines.length) {
      text(el('bk-summary-total-price'),
        money(state.tier.price_cents + extrasTotal()));
      total.hidden = false;
    } else {
      total.hidden = true;
    }
  }

  function chooseTier(tier) {
    state.tier = tier;
    clearError();

    var parts = splitLabel(tier.label);
    text(el('bk-summary-tier'), parts.name);
    text(el('bk-summary-price'), money(tier.price_cents));
    text(
      el('bk-summary-event'),
      state.event.name + ' · ' + asDate(state.event.starts_at)
    );

    var arrival = el('bk-summary-arrival');
    if (tier.arrival_from && tier.arrival_until) {
      text(arrival, 'Arrive between ' + asTime(tier.arrival_from) + ' and ' + asTime(tier.arrival_until) +
        (tier.departure_by
          ? ', and back at your car by ' + asTime(tier.departure_by)
          : ''));
      arrival.hidden = false;
    } else {
      arrival.hidden = true;
    }

    paintSummary();

    // Both remaining steps open together, and the scroll lands on the extras.
    // Nothing here has to be answered, so making it a gate would only be a
    // toll booth in front of the form.
    show(el('bk-details'));
    if (state.extras.length) reveal(el('bk-extras-step'));
    else reveal(el('bk-details'));
  }

  /* ------------------------------------------------------- step 3: details */

  function submit(e) {
    e.preventDefault();
    if (state.submitting || !state.event || !state.tier) return;
    clearError();

    var form = el('bk-form');
    var payload = {
      event_id: state.event.id,
      property_id: state.tier.property_id,
      tier_code: state.tier.code,
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim() || null,
      vehicle_rego: form.rego.value.trim().toUpperCase(),
      addons: pickedList().map(function (line) {
        return { code: line.item.code, qty: line.qty };
      }),
    };

    state.submitting = true;
    var button = el('bk-submit');
    var original = button.textContent;
    button.disabled = true;
    text(button, 'Holding your spot…');

    fetch(FN + '/create-checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .then(function (result) {
        if (result.ok && result.data.url) {
          window.location.href = result.data.url;
          return;
        }

        // 503 means card payments are not switched on yet. That is our problem,
        // not the customer's, and "payments are not configured on this project"
        // is not something to say to someone trying to give us money. Point
        // them at the way that does work.
        if (result.data.code === 'NOT_CONFIGURED' || result.status === 503) {
          fail('Card payment isn\u2019t switched on just yet. Email ' +
               'talli.parking@gmail.com with your name, phone, plate and the ' +
               'event, and we\u2019ll hold a spot for you.');
          return;
        }

        fail(result.data.error || 'Something went wrong starting checkout.');
        // Availability may have moved under us; refresh so the counts are honest.
        loadTiers(state.event.id);
      })
      .catch(function () {
        fail('We could not reach the booking system. Check your connection and try again.');
      })
      .finally(function () {
        state.submitting = false;
        button.disabled = false;
        text(button, original);
      });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    if (!CFG.supabaseUrl || !CFG.anonKey) return;

    el('bk-more-toggle').addEventListener('click', function () {
      var more = el('bk-tiers-more');
      var open = !more.hidden;
      more.hidden = open;
      text(this, open ? 'More options' : 'Fewer options');
      this.setAttribute('aria-expanded', String(!open));
    });

    el('bk-form').addEventListener('submit', submit);
    el('bk-interest-form').addEventListener('submit', submitInterest);
    el('bk-interest-close').addEventListener('click', function () {
      el('bk-interest').hidden = true;
    });

    loadEvents();
    loadExtras();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
