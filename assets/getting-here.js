/* =====================================================================
   Talli Parking — directions for the block a customer booked

   getting-here.html is 86 Paice Ave as written in the HTML. With
   ?block=<id> it is that block instead: its anchor's address, and maps
   to the anchor's position. The confirmation page and email link here
   with the booked block, so a Gribblehurst customer is never sent to
   Paice Ave.

   Read with the anon key from `block` and `property`, which the booking
   page already reads: an address and a position, nothing private.

   If a block was asked for and cannot be shown, the Paice Ave directions
   are taken away rather than left standing. Wrong directions are worse
   than none: the customer still has the address in their email.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function el(id) { return document.getElementById(id); }

  function blockId() {
    var id = new URLSearchParams(window.location.search).get('block') || '';
    return UUID.test(id) ? id.toLowerCase() : (id ? false : null);
  }

  function noDirections() {
    el('gh-address').textContent = 'Your parking address is in your confirmation email.';
    ['gh-buttons', 'gh-map'].forEach(function (id) { el(id).hidden = true; });
    var note = el('gh-note');
    note.textContent = 'We could not load the map for your booking just now. ' +
      'Use the address in your confirmation email, or try this page again.';
    note.hidden = false;
  }

  function show(block) {
    var anchor = block.anchor || {};
    var address = anchor.address || block.name;
    var lat = anchor.lat != null ? anchor.lat : block.lat;
    var lng = anchor.lng != null ? anchor.lng : block.lng;
    // A position beats an address: it lands on the driveway, not the
    // middle of the street.
    var to = lat != null && lng != null ? lat + ',' + lng : address;

    el('gh-address').textContent = address;
    el('gh-google').href = 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(to);
    el('gh-apple').href = 'https://maps.apple.com/?daddr=' + encodeURIComponent(to) +
      '&saddr=Current+Location';
    el('gh-frame').src = 'https://www.google.com/maps?q=' + encodeURIComponent(to) +
      '&output=embed';

    ['gh-buttons', 'gh-map'].forEach(function (n) { el(n).hidden = false; });

    var note = el('gh-note');
    note.textContent = 'Come to ' + String(address).split(',')[0] +
      '. A Talli warden will meet you and show you which driveway to park in — ' +
      'it may be one of the neighbours within 100m.';
    note.hidden = false;

    document.title = 'Getting Here — ' + String(address).split(',')[0] + ' — Talli Parking';
  }

  function load() {
    var id = blockId();
    if (id === null) return;           // no block asked for: Paice Ave, as written
    if (id === false || !CFG.supabaseUrl) { noDirections(); return; }

    // Paice Ave must not show, even for a moment, to someone booked elsewhere.
    el('gh-address').textContent = 'Finding your parking…';
    ['gh-buttons', 'gh-map'].forEach(function (n) { el(n).hidden = true; });

    fetch(CFG.supabaseUrl + '/rest/v1/block?select=id,name,lat,lng,' +
          'anchor:anchor_property_id(name,address,lat,lng)' +
          '&active=eq.true&id=eq.' + id, {
      headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey },
    })
      .then(function (res) {
        if (!res.ok) throw new Error('block lookup ' + res.status);
        return res.json();
      })
      .then(function (rows) {
        var block = rows && rows[0];
        if (!block || !(block.anchor && block.anchor.address)) throw new Error('no such block');
        show(block);
      })
      .catch(noDirections);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
