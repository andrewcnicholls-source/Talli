/* =====================================================================
   Talli Parking — booking flow

   Three steps, revealed one at a time: pick the event, pick the tier,
   give us your details. The last step posts to the create-checkout edge
   function, which holds a real bay before it ever talks to Stripe, and
   hands back a Checkout URL to redirect to.

   No price is ever sent from here. The browser names a tier; the database
   decides what that costs.
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
      '/event?status=eq.on_sale&order=starts_at.asc' +
      '&select=id,name,venue,starts_at,gates_open_at,online_sales_close_at'
    )
      .then(function (events) {
        var now = Date.now();
        var open = events.filter(function (e) {
          // The server enforces this too; filtering here just avoids offering
          // a fixture that will immediately reject.
          return !e.online_sales_close_at || new Date(e.online_sales_close_at) > now;
        });

        list.innerHTML = '';

        if (!open.length) {
          list.appendChild(
            make(
              'p',
              'bk-empty',
              'No events are open for online booking right now. We take arrivals ' +
              'on the night as well — come to 86 Paice Ave and ask the marshal.'
            )
          );
          return;
        }

        open.forEach(function (ev) { list.appendChild(eventCard(ev)); });
      })
      .catch(function (err) {
        list.innerHTML = '';
        list.appendChild(make('p', 'bk-empty', err.message));
      });
  }

  function eventCard(ev) {
    var label = make('label', 'bk-card bk-card-event');

    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bk-event';
    input.value = ev.id;
    input.className = 'bk-radio';
    input.addEventListener('change', function () { chooseEvent(ev); });

    var body = make('span', 'bk-card-body');
    body.appendChild(make('span', 'bk-card-title', ev.name));
    body.appendChild(
      make('span', 'bk-card-meta', asDate(ev.starts_at) + ' · ' + asTime(ev.starts_at) +
        (ev.venue ? ' · ' + ev.venue : ''))
    );

    label.appendChild(input);
    label.appendChild(body);
    return label;
  }

  function chooseEvent(ev) {
    state.event = ev;
    state.tier = null;
    el('bk-details').hidden = true;
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
    if (tier.departure_by) {
      facts.appendChild(make('span', 'bk-fact bk-fact-warn', 'Away by ' + asTime(tier.departure_by)));
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
        (tier.departure_by ? ', away by ' + asTime(tier.departure_by) : ''));
      arrival.hidden = false;
    } else {
      arrival.hidden = true;
    }

    reveal(el('bk-details'));
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
      accepts_street_parking: form.accepts_street.checked,
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
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (result.ok && result.data.url) {
          window.location.href = result.data.url;
          return;
        }

        // CONSENT_REQUIRED is recoverable in place: tick the box and retry.
        if (result.data.code === 'CONSENT_REQUIRED') {
          el('bk-street-row').classList.add('is-flagged');
          form.accepts_street.focus();
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

    loadEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
