/* =====================================================================
   Talli Parking — booking confirmation

   Stripe redirects here the instant payment succeeds, which is usually
   before the webhook has landed and moved the booking to "paid". So the
   page reads the booking as it stands and, while it is still "held",
   quietly polls until the webhook catches up.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.TALLI || {};
  var FN = CFG.supabaseUrl + '/functions/v1';
  var TZ = 'Pacific/Auckland';

  var POLL_EVERY_MS = 2000;
  var POLL_FOR_MS = 40000;

  var startedAt = Date.now();

  function el(id) { return document.getElementById(id); }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }

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
  function asDate(iso) {
    return fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function asTime(iso) {
    var s = fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true });
    return s ? s.replace(/\s/g, '').toLowerCase() : null;
  }

  function sessionId() {
    return new URLSearchParams(window.location.search).get('session_id') || '';
  }

  function problem(message) {
    hide(el('cf-loading'));
    hide(el('cf-body'));
    el('cf-problem-text').textContent = message;
    show(el('cf-problem'));
  }

  function row(label, value) {
    if (!value) return null;
    var wrap = document.createElement('div');
    wrap.className = 'cf-row';
    var k = document.createElement('span');
    k.className = 'cf-row-key';
    k.textContent = label;
    var v = document.createElement('span');
    v.className = 'cf-row-val';
    v.textContent = value;
    wrap.appendChild(k);
    wrap.appendChild(v);
    return wrap;
  }

  // Named on the page so they know to ask for them — and know they are not
  // paying twice.
  function renderExtras(lines) {
    var box = el('cf-extras');
    var list = el('cf-extras-list');
    list.innerHTML = '';
    if (!lines.length) {
      hide(box);
      return;
    }
    lines.forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line.qty > 1 ? line.name + ' \u00d7 ' + line.qty : line.name;
      list.appendChild(li);
    });
    show(box);
  }

  function render(b) {
    var settled = b.status === 'paid' || b.status === 'checked_in';

    el('cf-headline').textContent = settled
      ? 'You’re booked in.'
      : 'Payment received.';
    el('cf-sub').textContent = settled
      ? 'We’ve saved you a spot. Here are the details — screenshot this page.'
      : 'We’re just confirming your spot. This page will update on its own.';

    el('cf-reference').textContent = b.reference;

    var details = el('cf-details');
    details.innerHTML = '';

    var parts = String(b.tier_label || '').split(/\s+—\s+/);

    [
      row('Event', b.event ? b.event.name : null),
      row('Date', b.event ? asDate(b.event.starts_at) + ', ' + asTime(b.event.starts_at) : null),
      row('Spot', parts[0]),
      row('Where', b.property ? b.property.address : null),
      row(
        'Arrive',
        b.arrival_from && b.arrival_until
          ? 'between ' + asTime(b.arrival_from) + ' and ' + asTime(b.arrival_until)
          : null
      ),
      row('Back by', b.must_depart_by ? asTime(b.must_depart_by) : null),
      row('Vehicle', b.vehicle_rego),
      // Named separately from the total, because a line the customer can see
      // on their bank statement should be a line they can see here.
      row('Card surcharge', b.surcharge_cents ? money(b.surcharge_cents) : null),
      row('Paid', b.amount_cents != null
        ? money(b.amount_cents + (b.addons_cents || 0) + (b.surcharge_cents || 0))
        : null),
    ].forEach(function (r) { if (r) details.appendChild(r); });

    renderExtras(b.addons || []);

    var pending = el('cf-pending');
    if (settled) hide(pending); else show(pending);

    hide(el('cf-loading'));
    hide(el('cf-problem'));
    show(el('cf-body'));

    return settled;
  }

  function load() {
    var id = sessionId();
    if (!id) {
      problem(
        'We couldn’t tell which booking this is. If you’ve paid, check your ' +
        'email for the Stripe receipt, or get in touch and we’ll find you.'
      );
      return;
    }

    fetch(FN + '/get-booking', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify({ session_id: id }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Could not load that booking.');

        var settled = render(result.data);
        if (!settled && Date.now() - startedAt < POLL_FOR_MS) {
          setTimeout(load, POLL_EVERY_MS);
        }
      })
      .catch(function (err) {
        // A booking that has not been written yet reads as missing. Keep
        // trying for a while before telling the customer anything worrying.
        if (Date.now() - startedAt < POLL_FOR_MS) {
          setTimeout(load, POLL_EVERY_MS);
          return;
        }
        problem(err.message);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
