/* =====================================================================
   Talli Parking — booking flow (plan A3: a shopping catalogue)

   Night → block → type of space → details → checkout, revealed one step
   at a time. The type is a filter over the blocks (Standard / Priority /
   Valet chips, Standard first), so a block card always shows the price
   and what is left for the type being looked at. The last step posts to
   the create-checkout edge function, which holds a real space before it
   ever talks to Stripe, and hands back a Checkout URL to redirect to.

   Two pages run this file:
     /events/<slug>  a series page. The nights are on the page already
                     (rendered on the server); tapping one opens the flow
                     under them. ?night=<id> chooses one on arrival.
     /book           every night on sale, listed here. An old link,
                     /book?event=<id>, is sent to that night's series page
                     with the night chosen.

   "Sold out online" is not sold out (plan § 3.3): when the website's
   share of a type is gone but the gate still holds some, the card says
   walk-ups are possible on the night, with the block's address. It never
   says how many — the view only carries a yes/no.

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
    rows: [],        // v_block_tier_availability for the chosen night
    pins: [],        // v_event_site_map for the chosen night
    type: null,      // the type chip that is on: 'standard', 'priority', …, or 'all'
    open: null,      // under 'all': the block_id whose card is open at its types
    block: null,     // the block row chosen, for the type that is on
    tier: null,      // that same row, once chosen: what is being bought
    extras: [],      // the catalogue, as the database has it
    picked: {},      // code -> quantity
    interestEvent: null,
    submitting: false,
    // Basis points. 400 = 4%. Read from the database, because the number on
    // this page and the number Stripe charges have to be the same number.
    surchargeBps: 0,
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

  // Mirrors card_surcharge_cents() in the database. Online is always a card
  // payment, so this applies to every booking made on this page — on the
  // whole order, extras included, because that is what the card costs us.
  function surchargeOn(baseCents) {
    if (!state.surchargeBps) return 0;
    return Math.round(baseCents * state.surchargeBps / 10000);
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

  /* ---------------------------------------------------- the card surcharge */

  // One row, world-readable, and deliberately so: the surcharge is itemised
  // before anyone commits to paying it, which means the browser needs it.
  function loadSurcharge() {
    read('/payment_setting?select=card_surcharge_bps&limit=1')
      .then(function (rows) {
        state.surchargeBps = (rows && rows[0] && rows[0].card_surcharge_bps) || 0;
        // Not announced in step 2 (Andrew, 14 Nov): the surcharge is its own
        // line in the summary before payment, which is where it means
        // something, and the sign in the driveway is not to be relied on.
        if (state.tier) paintSummary();
      })
      .catch(function () {
        // Better to show the sign price and let Stripe present the surcharge
        // than to block a booking over a settings row that would not load.
        state.surchargeBps = 0;
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
              'as well — come to one of our parking addresses and ask the warden.'
            )
          );
          return;
        }

        listed.forEach(function (ev) { list.appendChild(eventCard(ev)); });
        preselect(listed);
      })
      .catch(function (err) {
        list.innerHTML = '';
        list.appendChild(make('p', 'bk-empty', err.message));
      });
  }

  function param(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // /book?event=<id> is the old way in, from emails and links already out
  // there. The flow lives on the series page now, so send them there with
  // the night chosen. Resolves true when the browser is on its way; false
  // (an unknown night, or the series cannot be read) leaves them here,
  // where the same night is chosen from the list as before.
  function sendToSeries(id) {
    if (!id || !UUID.test(id)) return Promise.resolve(false);
    return read('/event?id=eq.' + encodeURIComponent(id) +
                '&status=in.(on_sale,announced)&select=id,event_series(slug)&limit=1')
      .then(function (rows) {
        var slug = rows && rows[0] && rows[0].event_series && rows[0].event_series.slug;
        if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return false;
        window.location.replace('/events/' + slug + '?night=' + encodeURIComponent(id));
        return true;
      })
      .catch(function () { return false; });
  }

  // A night chosen on arrival, exactly as if they had tapped it: a bookable
  // one goes on to the blocks, any other opens "tell me". An id that is not
  // in the list — gone, or never real — changes nothing.
  function preselect(listed) {
    var wanted = param('event');
    if (!wanted) return;
    var ev = listed.filter(function (e) { return e.id === wanted; })[0];
    if (!ev) return;
    if (!ev.sellable) { openInterest(ev); return; }
    var radio = document.querySelector('input[name="bk-event"][value="' + ev.id + '"]');
    if (radio) radio.checked = true;
    chooseEvent(ev);
  }

  /* ------------------------------------------ step 1 on a series page */

  // The nights are already on the page, rendered on the server with what
  // a night is and whether it is on sale. Each carries its id and state in
  // data attributes; "Book parking" opens the flow underneath instead of
  // leaving the page.
  function nightFrom(li) {
    var state = li.getAttribute('data-night-state');
    return {
      id: li.getAttribute('data-night-id'),
      name: li.getAttribute('data-night-name'),
      starts_at: li.getAttribute('data-night-starts'),
      sellable: state === 'on_sale',
      closed: state === 'closed',
    };
  }

  function bindNights(list) {
    var items = Array.prototype.slice.call(list.querySelectorAll('[data-night-id]'));
    items.forEach(function (li) {
      var go = li.querySelector('.ev-night-go');
      if (!go) return;
      go.addEventListener('click', function (e) {
        e.preventDefault();
        pickNight(items, li, true);
      });
    });

    var wanted = param('night');
    var li = wanted && items.filter(function (x) {
      return x.getAttribute('data-night-id') === wanted;
    })[0];
    if (li) { pickNight(items, li, false); return; }

    // One night on sale (Robbie Williams has one): that is the one they
    // want, so the flow opens on it without a tap, and without pulling
    // the page down past the picture and the night they came to read.
    var onSale = items.filter(function (x) { return x.getAttribute('data-night-state') === 'on_sale'; });
    if (!wanted && onSale.length === 1) pickNight(items, onSale[0], false, true);
  }

  function pickNight(items, li, tapped, quiet) {
    var ev = nightFrom(li);
    if (!ev.sellable) { openInterest(ev); return; }
    items.forEach(function (x) { x.classList.toggle('is-chosen', x === li); });
    // The address bar names the night, so a shared link opens it again.
    if (tapped && window.history && history.replaceState) {
      try { history.replaceState(null, '', '?night=' + encodeURIComponent(ev.id)); } catch (e) { /* cosmetic */ }
    }
    chooseEvent(ev, quiet);
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
        'you know if a space frees up — or just come along on the night and ask a Talli warden.'
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

  function chooseEvent(ev, quiet) {
    var sameNight = state.event && state.event.id === ev.id;
    state.event = ev;
    state.tier = null;
    state.block = null;
    state.open = null;
    if (!sameNight) state.rows = [];
    el('bk-details').hidden = true;
    el('bk-extras-step').hidden = true;
    clearError();

    text(el('bk-tier-event'), ev.name + ' · ' + asDate(ev.starts_at));
    if (quiet) show(el('bk-tiers-step'));
    else reveal(el('bk-tiers-step'));
    loadNight(ev.id);
  }

  /* ------------------------------------------- step 2: block and type */

  function loadNight(eventId) {
    var cards = el('bk-blocks');
    cards.innerHTML = '';
    el('bk-types').innerHTML = '';
    cards.appendChild(make('p', 'bk-empty', 'Loading options…'));

    loadMap(eventId);

    read(
      '/v_block_tier_availability?event_id=eq.' + encodeURIComponent(eventId) +
      '&order=block_sort.asc,sort_order.asc'
    )
      .then(function (rows) {
        // A slow answer for a night they have since moved off is dropped.
        if (!state.event || state.event.id !== eventId) return;
        state.rows = rows || [];
        var types = typesIn(state.rows);
        if (!types.length) {
          cards.innerHTML = '';
          cards.appendChild(make('p', 'bk-empty',
            'Nothing is on sale for this night yet. We take arrivals on the night ' +
            'as well — come to one of our parking addresses and ask the warden.'));
          return;
        }
        // Keep the chip they had on, if this night sells it; else "All"
        // (Andrew, 14 Nov: start from every type), else the only type.
        var codes = types.map(function (t) { return t.code; });
        if (types.length > 1) codes.push(ALL);
        if (codes.indexOf(state.type) === -1) {
          state.type = types.length > 1 ? ALL : codes[0];
        }
        renderTypes(types);
        renderBlocks();
      })
      .catch(function (err) {
        cards.innerHTML = '';
        cards.appendChild(make('p', 'bk-empty', err.message));
      });
  }

  // The types this night sells, in the running order of the config's
  // headline list (Standard, Priority, Valet), then any others by the
  // database's sort order. One entry per code, whatever the block.
  function typesIn(rows) {
    var seen = {};
    var out = [];
    rows.forEach(function (r) {
      if (seen[r.code]) return;
      seen[r.code] = true;
      out.push({ code: r.code, label: r.label, sort: r.sort_order });
    });
    var rank = function (t) {
      var i = HEADLINE.indexOf(t.code);
      return i === -1 ? HEADLINE.length + (t.sort || 0) : i;
    };
    return out.sort(function (a, b) { return rank(a) - rank(b); });
  }

  // The "All" chip: every type at once. Each area is shown once, at the
  // cheapest type it still sells online ("from $X"), and opens to show
  // its types. Only offered when the night sells more than one type.
  var ALL = 'all';

  // The rows for the chip that is on. With "All", one row per area: the
  // cheapest type still for sale online there, or — when it has nothing
  // left online — its first type, so the card can say sold out.
  function rowsOfType() {
    if (state.type !== ALL) {
      return state.rows.filter(function (r) { return r.code === state.type; });
    }
    var byBlock = {};
    var order = [];
    state.rows.forEach(function (r) {
      var best = byBlock[r.block_id];
      if (!best) { byBlock[r.block_id] = r; order.push(r.block_id); return; }
      var open = r.spots_left > 0;
      var bestOpen = best.spots_left > 0;
      if ((open && !bestOpen) || (open === bestOpen && r.price_cents < best.price_cents)) {
        byBlock[r.block_id] = r;
      }
    });
    return order.map(function (id) { return byBlock[id]; });
  }

  // Every type one area sells tonight, in the chips' order.
  function rowsOfArea(blockId) {
    var rank = {};
    typesIn(state.rows).forEach(function (t, i) { rank[t.code] = i; });
    return state.rows
      .filter(function (r) { return r.block_id === blockId; })
      .sort(function (a, b) { return rank[a.code] - rank[b.code]; });
  }

  // The chips: "All" when there is a choice, then one per type, Standard
  // first. They filter; they do not choose anything. Picking a block (and,
  // under "All", a type within it) is what moves the booking on.
  function renderTypes(types) {
    var box = el('bk-types');
    box.innerHTML = '';
    if (types.length > 1) types = [{ code: ALL, label: 'All' }].concat(types);
    types.forEach(function (t) {
      var chip = make('label', 'bk-chip');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'bk-type';
      input.value = t.code;
      input.className = 'bk-chip-input';
      input.checked = t.code === state.type;
      input.addEventListener('change', function () { chooseType(t.code); });
      chip.appendChild(input);
      chip.appendChild(make('span', 'bk-chip-name', splitLabel(t.label).name));
      box.appendChild(chip);
    });
    paintTypeNote();
  }

  function chooseType(code) {
    if (code === state.type) return;
    state.type = code;
    state.open = null;
    // A block chosen for another type is no longer the thing being bought.
    if (state.tier) {
      state.tier = null;
      state.block = null;
      el('bk-details').hidden = true;
      el('bk-extras-step').hidden = true;
    }
    paintTypeNote();
    renderBlocks();
    if (state.pins.length) drawMap(el('bk-map'), state.pins);
  }

  // What the type on means, and when to arrive: the same for every block,
  // so it is said once above the cards rather than on each of them.
  function paintTypeNote() {
    var note = el('bk-type-note');
    var row = rowsOfType()[0];
    if (!row || state.type === ALL) { note.hidden = true; return; }
    var parts = splitLabel(row.label);
    var bits = [];
    if (parts.detail) bits.push(parts.detail.charAt(0).toUpperCase() + parts.detail.slice(1) + '.');
    if (row.arrival_from && row.arrival_until) {
      bits.push('Arrive ' + asTime(row.arrival_from) + '–' + asTime(row.arrival_until) + '.');
    }
    text(note, bits.join(' '));
    note.hidden = !bits.length;
  }

  /* ------------------------------------------------- the map */

  // Eden Park's main entrance area. Every pin is placed against it.
  var EDEN_PARK = [-36.8749, 174.7448];
  var map = null;
  var mapLayer = null;

  // Every bookable house for this event, plus Eden Park, fitted to the
  // frame. Tapping a house picks its area. A failure here is cosmetic: the
  // cards below still sell everything, so the map just stays hidden.
  function loadMap(eventId) {
    var box = el('bk-map');
    state.pins = [];
    mapShown(false);
    if (!box || (!window.L && !CFG.googleMapsKey)) return;
    read('/v_event_site_map?event_id=eq.' + encodeURIComponent(eventId) +
         '&select=block_id,block_name,lat,lng,is_anchor')
      .then(function (pins) {
        if (!state.event || state.event.id !== eventId) return;
        state.pins = (pins || []).filter(function (p) { return p.lat != null && p.lng != null; });
        drawMap(box, state.pins);
      })
      .catch(function () { box.hidden = true; mapShown(false); });
  }

  // Whether the map is on the page. With it, areas are picked on the map
  // and only the one picked is shown below it; without it (no positions,
  // or no map would load) every area is listed, as before. A list of 20
  // or 30 areas is not something to scroll through to get to the next step.
  function mapShown(on) {
    if (!!state.mapReady === on) return;
    state.mapReady = on;
    if (state.rows.length) renderBlocks();
  }

  // Google Maps when there is a key and it loads; otherwise OpenStreetMap.
  // Decided once per page: the two cannot share the same box.
  var mapKind = null;

  function drawMap(box, pins) {
    if (!pins.length) { box.hidden = true; mapShown(false); return; }
    box.hidden = false;
    if (mapKind === null) mapKind = CFG.googleMapsKey ? 'google' : 'osm';
    if (mapKind === 'google') {
      loadGoogleMaps()
        .then(function () { drawGoogleMap(box, pins); mapShown(true); })
        .catch(function () {
          mapKind = 'osm';
          drawOsmMap(box, pins);
          mapShown(!box.hidden);
        });
      return;
    }
    drawOsmMap(box, pins);
    mapShown(!box.hidden);
  }

  /* ---- Google Maps ---- */

  var googleReady = null;

  function loadGoogleMaps() {
    if (googleReady) return googleReady;
    googleReady = new Promise(function (resolve, reject) {
      if (window.google && window.google.maps) { resolve(); return; }
      var cb = '__talliMapsReady';
      window[cb] = function () { resolve(); };
      // A key that is refused (quota spent, wrong referrer) calls this
      // instead of failing the script load.
      window.gm_authFailure = function () { reject(new Error('maps auth')); };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(CFG.googleMapsKey) + '&callback=' + cb + '&loading=async';
      s.async = true;
      s.onerror = function () { reject(new Error('maps script')); };
      document.head.appendChild(s);
      setTimeout(function () { reject(new Error('maps timeout')); }, 8000);
    });
    return googleReady;
  }

  var gmap = null;
  var gOverlays = [];

  // A piece of HTML pinned to a point: the price pills and the Eden Park
  // badge, styled by the same CSS as the OpenStreetMap version.
  function htmlOverlay(at, className, html, onClick) {
    var g = window.google.maps;
    var ov = new g.OverlayView();
    var div = null;
    ov.onAdd = function () {
      div = document.createElement('div');
      div.className = className;
      div.innerHTML = html;
      div.style.position = 'absolute';
      if (onClick) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', onClick);
        this.getPanes().overlayMouseTarget.appendChild(div);
      } else {
        this.getPanes().overlayLayer.appendChild(div);
      }
    };
    ov.draw = function () {
      var px = this.getProjection().fromLatLngToDivPixel(new g.LatLng(at[0], at[1]));
      if (px && div) { div.style.left = px.x + 'px'; div.style.top = px.y + 'px'; }
    };
    ov.onRemove = function () { if (div && div.parentNode) div.parentNode.removeChild(div); div = null; };
    return ov;
  }

  function drawGoogleMap(box, pins) {
    var g = window.google.maps;
    if (!gmap) {
      gmap = new g.Map(box, {
        center: { lat: EDEN_PARK[0], lng: EDEN_PARK[1] },
        zoom: 15,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        gestureHandling: 'cooperative',
        // Quiet the map so the price pills are what stands out.
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'poi.park', stylers: [{ visibility: 'on' }] },
          { featureType: 'poi.sports_complex', stylers: [{ visibility: 'on' }] },
          { featureType: 'transit.station', stylers: [{ visibility: 'simplified' }] },
        ],
      });
    }
    gOverlays.forEach(function (o) { o.setMap(null); });
    gOverlays = [];

    var m = mapModel(pins);
    var add = function (o) { o.setMap(gmap); gOverlays.push(o); };

    add(htmlOverlay(EDEN_PARK, 'bk-map-venue bk-map-venue-g',
      '<span class="bk-map-venue-dot" aria-hidden="true"></span>' +
      '<span class="bk-map-venue-name">Eden Park</span>'));
    m.areas.forEach(function (a) {
      a.houses.forEach(function (h) {
        if (h === a.at) return;
        add(htmlOverlay(h, 'bk-map-dot' + (a.full ? ' is-full' : ''), ''));
      });
      add(htmlOverlay(a.at,
        'bk-map-pin' + (a.full ? ' is-full' : '') + (a.chosen ? ' is-chosen' : ''),
        '<span class="bk-map-pill" title="' + escapeHtml(a.title) + '">' + escapeHtml(a.label) + '</span>',
        function () { pickArea(a.block_id); }));
    });

    var bounds = new g.LatLngBounds();
    m.framed.forEach(function (pt) { bounds.extend({ lat: pt[0], lng: pt[1] }); });
    gmap.fitBounds(bounds, { top: 52, left: 40, right: 40, bottom: 24 });
    g.event.addListenerOnce(gmap, 'idle', function () {
      if (gmap.getZoom() > 16) gmap.setZoom(16);
      if (gmap.getZoom() < 14) { gmap.setCenter({ lat: EDEN_PARK[0], lng: EDEN_PARK[1] }); gmap.setZoom(14); }
    });
  }

  // What both maps draw: one pill per area at its anchor house, the other
  // houses as dots, and a frame centred on Eden Park (every point mirrored
  // through the stadium, so there is as much ground above it as below).
  // Each pill is the block's price for the type chip that is on, so the
  // map and the cards below it always say the same thing. A block that
  // does not sell that type is drawn as full.
  function mapModel(pins) {
    var byBlock = {};
    var order = [];
    var framed = [EDEN_PARK];
    var offer = {};
    rowsOfType().forEach(function (r) { offer[r.block_id] = r; });
    pins.forEach(function (p) {
      var a = byBlock[p.block_id];
      if (!a) {
        a = byBlock[p.block_id] = {
          block_id: p.block_id, block_name: p.block_name, at: null, houses: [],
        };
        order.push(a);
      }
      var at = [Number(p.lat), Number(p.lng)];
      framed.push(at, [2 * EDEN_PARK[0] - at[0], 2 * EDEN_PARK[1] - at[1]]);
      if (p.is_anchor || !a.at) a.at = at;
      a.houses.push(at);
    });
    order.forEach(function (a) {
      var r = offer[a.block_id];
      a.full = !r || r.spots_left <= 0;
      a.chosen = !!(state.block && state.block.block_id === a.block_id);
      a.label = a.full ? (r && r.walk_ups_on_the_night ? 'Walk-up' : 'Full')
                       : (state.type === ALL ? 'from ' : '') + money(r.price_cents);
      a.title = a.block_name + (a.full
        ? (r && r.walk_ups_on_the_night ? ' — sold out online, walk-up spaces on the night'
                                        : ' — sold out online')
        : ' — ' + a.label);
    });
    return { areas: order, framed: framed };
  }

  // A tap on an area on the map. Under "All" it opens that area's card at
  // its types: which type is still the customer's to choose. Under one
  // type it chooses the area, if it has that type left; a sold-out area
  // just shows its card, which says whether there are walk-ups.
  function pickArea(blockId) {
    var r = rowsOfType().filter(function (x) { return x.block_id === blockId; })[0];
    if (!r) return;
    if (state.type === ALL) { openArea(blockId, true); return; }
    state.open = blockId;
    if (r.spots_left > 0) chooseBlock(r);
    renderBlocks();
  }

  /* ---- OpenStreetMap (Leaflet) ---- */

  function drawOsmMap(box, pins) {
    if (!window.L) { box.hidden = true; return; }
    if (!map) {
      map = window.L.map(box, { scrollWheelZoom: false, tap: true, zoomControl: false });
      window.L.control.zoom({ position: 'bottomright' }).addTo(map);
      // A light, quiet basemap so the price pills are what stands out.
      window.L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
          'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(map);
    }
    if (mapLayer) mapLayer.remove();
    mapLayer = window.L.layerGroup().addTo(map);

    var m = mapModel(pins);

    // Eden Park: a badge, not a pin. It is the thing everyone is walking to.
    window.L.marker(EDEN_PARK, {
      icon: window.L.divIcon({
        className: 'bk-map-venue',
        html: '<span class="bk-map-venue-dot" aria-hidden="true"></span>' +
              '<span class="bk-map-venue-name">Eden Park</span>',
        iconSize: null,
        iconAnchor: [14, 14],
      }),
      keyboard: false,
      interactive: false,
    }).addTo(mapLayer);

    m.areas.forEach(function (a) {
      a.houses.forEach(function (h) {
        if (h === a.at) return;
        window.L.circleMarker(h, {
          radius: 5, color: '#fff', weight: 2,
          fillColor: a.full ? '#9a9a9a' : '#2B4C7E', fillOpacity: 1, interactive: false,
        }).addTo(mapLayer);
      });
      var marker = window.L.marker(a.at, {
        icon: window.L.divIcon({
          className: 'bk-map-pin' + (a.full ? ' is-full' : '') + (a.chosen ? ' is-chosen' : ''),
          html: '<span class="bk-map-pill">' + escapeHtml(a.label) + '</span>',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        title: a.title,
        riseOnHover: true,
      }).addTo(mapLayer);
      marker.on('click', function () { pickArea(a.block_id); });
    });

    // Leaflet measures the box when it is drawn; the step may have only just
    // been un-hidden, so measure again before fitting.
    map.invalidateSize();
    map.fitBounds(window.L.latLngBounds(m.framed), {
      paddingTopLeft: [40, 52], paddingBottomRight: [40, 24], maxZoom: 16,
    });
    if (map.getZoom() < 14) map.setView(EDEN_PARK, 14);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------ step 2a: the block */

  function whereToCome(row) {
    if (row && row.anchor_address) return shortAddress(row.anchor_address);
    return 'one of our parking addresses';
  }

  function shortAddress(a) { return String(a || '').split(',')[0]; }

  // One card per block that sells the type chip that is on: its price,
  // "<anchor> or within 100m", and what is left. Blocks that do not sell
  // that type are not shown at all — the chip is a filter.
  function renderBlocks() {
    var box = el('bk-blocks');
    box.innerHTML = '';
    var rows = rowsOfType();

    if (!rows.length) {
      box.appendChild(make('p', 'bk-empty', 'Nothing of this type for this night.'));
      return;
    }

    // With the map on the page, only the area picked on it is shown here.
    if (state.mapReady && rows.length > 1) {
      var picked = rows.filter(function (r) { return r.block_id === state.open; });
      if (!picked.length) {
        box.appendChild(make('p', 'bk-card-meta bk-blocks-lead bk-map-prompt',
          'Tap a price on the map to choose where to park. You\u2019re booked for that ' +
          'address or a driveway within 100m \u2014 a Talli warden will show you in.'));
        if (state.pins.length) drawMap(el('bk-map'), state.pins);
        return;
      }
      rows = picked;
    }

    box.appendChild(make('p', 'bk-card-meta bk-blocks-lead',
      rows.length > 1
        ? 'Pick where you’d like to park. You’re booked for that address or a ' +
          'driveway within 100m — a Talli warden will show you in.'
        : 'You’re booked for this address or a driveway within 100m — ' +
          'a Talli warden will show you in.'));

    rows.forEach(function (r) {
      if (state.type === ALL) { box.appendChild(areaCard(r)); return; }
      box.appendChild(blockCard(r));
      if (r.spots_left <= 0) box.appendChild(soldOutNote(r));
    });
    if (state.pins.length) drawMap(el('bk-map'), state.pins);
  }

  // Under "All": one card per area at "from $X", which opens in place to
  // the types that area sells, each with its own price. Choosing one of
  // those is choosing the block, exactly as a card under a type chip is.
  function areaCard(summary) {
    var blockId = summary.block_id;
    var open = state.open === blockId;
    var wrap = make('div', 'bk-area' + (open ? ' is-open' : ''));
    wrap.setAttribute('data-block-id', blockId);

    var soldOut = summary.spots_left <= 0;
    var head = make('button', 'bk-card bk-card-area' + (soldOut ? ' is-soldout' : ''));
    head.type = 'button';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    var body = make('span', 'bk-card-body');
    var top = make('span', 'bk-tier-head');
    top.appendChild(make('span', 'bk-card-title', summary.block_name));
    top.appendChild(make('span', 'bk-tier-price',
      soldOut ? 'Sold out online' : 'from ' + money(summary.price_cents)));
    body.appendChild(top);
    if (summary.anchor_address) {
      body.appendChild(make('span', 'bk-card-meta', shortAddress(summary.anchor_address) + ' or within 100m'));
    }
    head.appendChild(body);
    head.appendChild(make('span', 'bk-area-caret', '›'));
    head.addEventListener('click', function () { openArea(open ? null : blockId, false); });
    wrap.appendChild(head);

    if (open) {
      var list = make('div', 'bk-area-types');
      rowsOfArea(blockId).forEach(function (r) {
        list.appendChild(areaTypeOption(r));
        if (r.spots_left <= 0) list.appendChild(soldOutNote(r));
      });
      wrap.appendChild(list);
    }
    return wrap;
  }

  function areaTypeOption(r) {
    var soldOut = r.spots_left <= 0;
    var label = make('label', 'bk-card bk-card-tier bk-area-type' + (soldOut ? ' is-soldout' : ''));
    label.setAttribute('data-code', r.code);
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bk-block';
    input.value = r.block_id + '|' + r.code;
    input.className = 'bk-radio';
    input.disabled = soldOut;
    input.checked = !!(state.tier && state.tier.block_id === r.block_id &&
                       state.tier.code === r.code && !soldOut);
    input.addEventListener('change', function () { chooseBlock(r); });

    var parts = splitLabel(r.label);
    var body = make('span', 'bk-card-body');
    var head = make('span', 'bk-tier-head');
    head.appendChild(make('span', 'bk-card-title', parts.name));
    head.appendChild(make('span', 'bk-tier-price', money(r.price_cents)));
    body.appendChild(head);
    if (parts.detail) body.appendChild(make('span', 'bk-card-meta', parts.detail));
    if (!soldOut && r.spots_left <= 3) {
      var facts = make('span', 'bk-tier-facts');
      facts.appendChild(make('span', 'bk-fact bk-fact-low', r.spots_left + ' left'));
      body.appendChild(facts);
    }
    label.appendChild(input);
    label.appendChild(body);
    return label;
  }

  // Open one area under "All" (or close them all), and — when it came
  // from the map — bring its card into view.
  function openArea(blockId, scroll) {
    state.open = blockId;
    if (state.tier && state.tier.block_id !== blockId) {
      state.tier = null;
      state.block = null;
      el('bk-details').hidden = true;
      el('bk-extras-step').hidden = true;
    }
    renderBlocks();
    if (!scroll || !blockId) return;
    var card = el('bk-blocks').querySelector('.bk-area[data-block-id="' + blockId + '"]');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function blockCard(r) {
    var soldOut = r.spots_left <= 0;
    var label = make('label', 'bk-card bk-card-tier bk-card-block' + (soldOut ? ' is-soldout' : ''));
    label.setAttribute('data-block-id', r.block_id);

    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bk-block';
    input.value = r.block_id;
    input.className = 'bk-radio';
    input.disabled = soldOut;
    input.checked = !!(state.block && state.block.block_id === r.block_id && !soldOut);
    input.addEventListener('change', function () { chooseBlock(r); });

    var body = make('span', 'bk-card-body');
    var head = make('span', 'bk-tier-head');
    head.appendChild(make('span', 'bk-card-title', r.block_name));
    head.appendChild(make('span', 'bk-tier-price', money(r.price_cents)));
    body.appendChild(head);
    if (r.anchor_address) {
      body.appendChild(make('span', 'bk-card-meta', shortAddress(r.anchor_address) + ' or within 100m'));
    }

    var facts = make('span', 'bk-tier-facts');
    if (soldOut) {
      facts.appendChild(make('span', 'bk-fact bk-fact-warn', 'Sold out online'));
    } else if (r.spots_left <= 3) {
      facts.appendChild(make('span', 'bk-fact bk-fact-low', r.spots_left + ' left'));
    }
    if (facts.childNodes.length) body.appendChild(facts);

    label.appendChild(input);
    label.appendChild(body);
    return label;
  }

  // Under a sold-out card, in its own row so it is not faded with the card.
  // Walk-ups are promised only when the database says the gate still has
  // one; it never says how many.
  function soldOutNote(r) {
    return make('p', 'bk-soldout-note' + (r.walk_ups_on_the_night ? ' is-walk-up' : ''),
      r.walk_ups_on_the_night
        ? 'Sold out online — walk-up spaces on the night. Come to ' +
          whereToCome(r) + ' and a Talli warden will park you.'
        : 'Sold out online for this type.');
  }

  // The tier labels in the database read as "Standard — best value, expect to
  // wait". Split on the dash: the short name is the heading, the rest is the
  // explanation underneath.
  function splitLabel(label) {
    var parts = String(label || '').split(/\s+—\s+/);
    return { name: parts[0], detail: parts.slice(1).join(' — ') };
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

  // The catalogue stores pictures as site paths ("assets/poncho.jpg"). This
  // flow also runs on /events/<slug>, where a relative path would be looked
  // for under /events/ and not found, so it is taken from the site's root.
  function fromRoot(path) {
    var p = String(path || '');
    return /^(https?:)?\/\//.test(p) || p.charAt(0) === '/' ? p : '/' + p;
  }

  // Picture on the left, as tall as the card; name and blurb beside it;
  // on the right, the price at the top and the stepper at the bottom.
  function extraCard(item) {
    var card = make('div', 'bk-extra');
    card.dataset.code = item.code;

    if (item.image_path) {
      var shot = make('div', 'bk-extra-shot');
      var img = document.createElement('img');
      img.src = fromRoot(item.image_path);
      img.alt = '';
      img.loading = 'lazy';
      shot.appendChild(img);
      card.appendChild(shot);
    }

    var body = make('div', 'bk-extra-body');
    body.appendChild(make('span', 'bk-extra-name', item.name));
    if (item.blurb) body.appendChild(make('span', 'bk-extra-blurb', item.blurb));
    card.appendChild(body);

    var side = make('div', 'bk-extra-side');
    side.appendChild(make('span', 'bk-extra-price', extraPriceLine(item)));
    card.appendChild(side);

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
    side.appendChild(step);

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
        img.src = fromRoot(item.image_path);
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

    var subtotal = state.tier.price_cents + extrasTotal();
    var surcharge = surchargeOn(subtotal);

    var row = el('bk-summary-surcharge');
    if (surcharge > 0) {
      text(el('bk-summary-surcharge-price'), money(surcharge));
      row.hidden = false;
    } else {
      row.hidden = true;
    }

    // Worth spelling out whenever the total is not simply the price on the
    // card — which, once a surcharge exists, is every booking.
    var total = el('bk-summary-total');
    if (lines.length || surcharge > 0) {
      text(el('bk-summary-total-price'), money(subtotal + surcharge));
      total.hidden = false;
    } else {
      total.hidden = true;
    }
  }

  // A block chosen for the type that is on: that row is what is bought.
  function chooseBlock(tier) {
    if (tier.spots_left <= 0) return;
    state.open = tier.block_id;
    state.block = tier;
    state.tier = tier;
    clearError();
    if (state.pins.length) drawMap(el('bk-map'), state.pins);

    var parts = splitLabel(tier.label);
    text(el('bk-summary-tier'), parts.name + ' · ' + tier.block_name);
    text(el('bk-summary-price'), money(tier.price_cents));
    text(
      el('bk-summary-event'),
      state.event.name + ' · ' + asDate(state.event.starts_at) +
      (tier.anchor_address ? ' · ' + shortAddress(tier.anchor_address) + ' or within 100m' : '')
    );

    var arrival = el('bk-summary-arrival');
    if (tier.arrival_from && tier.arrival_until) {
      text(arrival, 'Arrive between ' + asTime(tier.arrival_from) +
        ' and ' + asTime(tier.arrival_until));
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
      // The area, not the driveway: the system picks the site within it.
      block_id: state.tier.block_id,
      tier_code: state.tier.code,
      // The price this page showed. Not what is charged — the database
      // decides that — but checkout refuses if the two differ, so nobody
      // pays a figure they were never shown.
      expected_price_cents: state.tier.price_cents,
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim() || null,
      vehicle_rego: form.rego.value.trim().toUpperCase(),
      // Advisory, not a product choice: it buys no different spot and costs
      // nothing. It exists so the marshal knows before waving the car in.
      vehicle_low_clearance: form.low.checked,
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
               'bookings@talli.co.nz with your name, phone, plate and the ' +
               'event, and we\u2019ll hold a spot for you.');
          return;
        }

        fail(result.data.error || 'Something went wrong starting checkout.');
        // Availability may have moved under us; refresh so the counts are honest.
        loadNight(state.event.id);
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

    el('bk-form').addEventListener('submit', submit);
    el('bk-interest-form').addEventListener('submit', submitInterest);
    el('bk-interest-close').addEventListener('click', function () {
      el('bk-interest').hidden = true;
    });

    loadExtras();
    loadSurcharge();

    // A series page: its nights are on the page already.
    var nights = el('bk-nights');
    if (nights) { bindNights(nights); return; }

    // /book. An old link to one night goes to that night's series page;
    // if that cannot be done, the night is chosen here instead.
    sendToSeries(param('event')).then(function (leaving) {
      if (!leaving) loadEvents();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
