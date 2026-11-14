/* =====================================================================
   Talli Parking — Getting Here

   Every area Talli parks in, each linking to its /go/<slug> page (plan
   A4): the directions, the pictures of where to park, and what is on
   next. That page is what a customer's confirmation and the Locate Us
   card open; this one is for someone who has not booked yet, or who
   came in from the menu.

   ?block=<id> is the address confirmations used before /go/ existed.
   It still works: it forwards to that block's /go/ page. If the block
   cannot be found it says so and lists the areas, rather than guessing
   one. Wrong directions are worse than none: the customer still has
   the address in their email.

   Above the list, a map: Eden Park in the middle and one pill per area at
   its anchor house, as on the booking page. Tapping a pill opens that
   area's /go/ page. The map is a nicety — the list below it is the page.

   Read with the anon key from `block` and `property`, which the booking
   page already reads: an address and a position, nothing private.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function el(id) { return document.getElementById(id); }

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function read(path) {
    return fetch(CFG.supabaseUrl + '/rest/v1/' + path, {
      headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey },
    }).then(function (res) {
      if (!res.ok) throw new Error('lookup ' + res.status);
      return res.json();
    });
  }

  function say(message) {
    var note = el('gh-note');
    note.textContent = message || '';
    note.hidden = !message;
  }

  // The street part of an address: "12 Example Road, Sandringham" → the
  // first part. Enough to recognise, without the suburb every one shares.
  function street(address) {
    return String(address || '').split(',')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
  }

  function showAreas(blocks) {
    var list = el('gh-areas');
    list.innerHTML = '';
    blocks.forEach(function (b) {
      var anchor = b.anchor || {};
      var li = make('li', 'gh-area');
      var a = make('a', 'gh-area-link');
      a.href = '/go/' + encodeURIComponent(b.slug);
      a.appendChild(make('span', 'gh-area-name', street(anchor.address) || b.name));
      var meta = [];
      if (anchor.walk_minutes != null) meta.push(anchor.walk_minutes + ' min walk to Eden Park');
      meta.push('or a driveway within 100m');
      a.appendChild(make('span', 'gh-area-meta', meta.join(' · ')));
      a.appendChild(make('span', 'gh-area-go', 'Directions →'));
      li.appendChild(a);
      list.appendChild(li);
    });
    el('gh-areas-wrap').hidden = !blocks.length;
    drawMap(blocks);
    if (!blocks.length) {
      say('We could not find any parking areas just now. Email bookings@talli.co.nz and we will tell you where to come.');
    }
  }

  // Eden Park's main entrance area, as on the booking page.
  var EDEN_PARK = [-36.8749, 174.7448];

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // One pill per area at its anchor, framed around Eden Park (every point
  // mirrored through the stadium, so it sits in the middle). Areas with no
  // position are only in the list. No Leaflet, no positions: no map.
  function drawMap(blocks) {
    var box = el('gh-map');
    if (!box || !window.L) return;
    var placed = blocks.filter(function (b) {
      return b.anchor && b.anchor.lat != null && b.anchor.lng != null;
    });
    if (!placed.length) { box.hidden = true; return; }
    box.hidden = false;

    var map = window.L.map(box, { scrollWheelZoom: false, tap: true, zoomControl: false });
    window.L.control.zoom({ position: 'bottomright' }).addTo(map);
    window.L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
        'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

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
    }).addTo(map);

    var framed = [EDEN_PARK];
    placed.forEach(function (b) {
      var at = [Number(b.anchor.lat), Number(b.anchor.lng)];
      framed.push(at, [2 * EDEN_PARK[0] - at[0], 2 * EDEN_PARK[1] - at[1]]);
      var name = street(b.anchor.address) || b.name;
      var marker = window.L.marker(at, {
        icon: window.L.divIcon({
          className: 'bk-map-pin',
          html: '<span class="bk-map-pill">' + escapeHtml(name) + '</span>',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        title: name + ' — directions',
        riseOnHover: true,
      }).addTo(map);
      marker.on('click', function () {
        window.location.href = '/go/' + encodeURIComponent(b.slug);
      });
    });

    map.invalidateSize();
    map.fitBounds(window.L.latLngBounds(framed), {
      paddingTopLeft: [40, 52], paddingBottomRight: [40, 24], maxZoom: 16,
    });
    if (map.getZoom() < 14) map.setView(EDEN_PARK, 14);
  }

  function loadAreas() {
    return read('block?active=is.true&order=sort_order.asc,name.asc' +
                '&select=id,name,slug,anchor:anchor_property_id(address,walk_minutes,lat,lng)')
      .then(function (rows) {
        showAreas((rows || []).filter(function (b) { return b.slug; }));
      })
      .catch(function () {
        say('We could not load the parking areas just now. Try this page again, or use the ' +
            'address in your confirmation email.');
      });
  }

  function load() {
    if (!CFG.supabaseUrl) { say('Directions are not available just now.'); return; }
    var asked = new URLSearchParams(window.location.search).get('block');
    if (!asked) { loadAreas(); return; }

    if (!UUID.test(asked)) {
      say('That directions link is not one we recognise. Pick your parking area below.');
      loadAreas();
      return;
    }
    say('Finding your parking…');
    read('block?active=is.true&select=slug&id=eq.' + asked.toLowerCase())
      .then(function (rows) {
        var slug = rows && rows[0] && rows[0].slug;
        if (!slug) throw new Error('no such block');
        window.location.replace('/go/' + encodeURIComponent(slug));
      })
      .catch(function () {
        say('We could not find the parking for that booking just now. Your parking address is ' +
            'in your confirmation email, or pick your area below.');
        loadAreas();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
