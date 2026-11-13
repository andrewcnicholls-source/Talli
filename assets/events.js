/* =====================================================================
   Talli Parking — what is left, on the events pages (plan A2)

   /events and /events/<slug> are rendered on the server with the details
   of each night and nothing about availability, so a copy held in a cache
   can never claim a space that has gone. This fills that in afterwards,
   from the same view the booking page reads.

   Every element with data-event-ids="<id>,<id>" gets "from $X": the
   cheapest headline type of space still for sale online across those
   nights. When nothing is, it says nothing rather than guess — the
   booking page has the detail, including walk-ups on the night.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var HEADLINE = CFG.headlineTiers || ['standard', 'priority', 'valet'];
  var slots = Array.prototype.slice.call(document.querySelectorAll('[data-event-ids]'));
  if (!slots.length || !CFG.supabaseUrl) return;

  var ids = {};
  slots.forEach(function (node) {
    node.getAttribute('data-event-ids').split(',').forEach(function (id) {
      if (/^[0-9a-f-]{36}$/i.test(id)) ids[id] = true;
    });
  });
  var list = Object.keys(ids);
  if (!list.length) return;

  function money(cents) {
    var dollars = cents / 100;
    return '$' + (cents % 100 === 0 ? dollars.toFixed(0) : dollars.toFixed(2));
  }

  fetch(CFG.supabaseUrl + '/rest/v1/v_block_tier_availability' +
        '?event_id=in.(' + list.join(',') + ')' +
        '&code=in.(' + HEADLINE.join(',') + ')' +
        '&spots_left=gt.0' +
        '&select=event_id,price_cents', {
    headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey },
  })
    .then(function (res) { return res.ok ? res.json() : []; })
    .then(function (rows) {
      var cheapest = {};
      rows.forEach(function (r) {
        if (r.price_cents == null) return;
        if (cheapest[r.event_id] == null || r.price_cents < cheapest[r.event_id]) {
          cheapest[r.event_id] = r.price_cents;
        }
      });
      slots.forEach(function (node) {
        var low = null;
        node.getAttribute('data-event-ids').split(',').forEach(function (id) {
          if (cheapest[id] != null && (low == null || cheapest[id] < low)) low = cheapest[id];
        });
        if (low != null) {
          node.textContent = 'Parking from ' + money(low);
          node.classList.add('is-priced');
        }
      });
    })
    .catch(function () { /* the page is complete without a price */ });
})();
