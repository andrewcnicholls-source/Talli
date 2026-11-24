/* Talli Parking — rate us (docs/plans/reviews-and-contact.md, slice 1)

   The "How was your night?" form at the bottom of the homepage. Sends to
   the submit-review edge function, which is the only way into the review
   table.

   Opened with ?s=<checkout session> (from a booking), the review goes with
   that booking: the server takes the site and the night from it, so the
   site list is not asked and the page scrolls straight to the form.
 */
(function () {
  'use strict';

  var CFG = window.TALLI;
  var form = document.getElementById('rate-form');
  if (!CFG || !form) return;

  var FN = CFG.supabaseUrl + '/functions/v1/submit-review';
  var el = function (id) { return document.getElementById(id); };

  var session = null;
  try { session = new URLSearchParams(window.location.search).get('s'); } catch (e) { /* old browser */ }
  if (session && !/^cs_[A-Za-z0-9_]+$/.test(session)) session = null;

  function post(body) {
    return fetch(FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; })
        .then(function (data) { return { ok: res.ok, data: data }; });
    });
  }

  /* ---------------------------------------------------------- stars */

  // A radio group underneath, so a keyboard and a screen reader get the
  // ordinary behaviour. The stars up to the chosen one light up.
  var stars = Array.prototype.slice.call(form.querySelectorAll('input[name="rating"]'));
  function paintStars() {
    var chosen = 0;
    stars.forEach(function (s) { if (s.checked) chosen = Number(s.value); });
    stars.forEach(function (s) {
      var label = form.querySelector('label[for="' + s.id + '"]');
      if (label) label.classList.toggle('is-on', Number(s.value) <= chosen);
    });
  }
  stars.forEach(function (s) { s.addEventListener('change', paintStars); });

  /* ----------------------------------------------------- the site */

  // The thumbs are about a site, so they show once one is known.
  function showThumbs() {
    el('rate-thumbs').hidden = !(session || el('rate-site').value);
  }

  if (session) {
    el('rate-site-field').hidden = true;
    el('rate-booked').hidden = false;
    showThumbs();
    var section = el('rate');
    if (section && section.scrollIntoView) section.scrollIntoView();
  } else {
    el('rate-site').addEventListener('change', showThumbs);
    post({ action: 'options' })
      .then(function (r) {
        if (!r.ok || !Array.isArray(r.data.sites)) return;
        var sel = el('rate-site');
        r.data.sites.forEach(function (s) {
          sel.appendChild(new Option(s.label, s.id));
        });
      })
      .catch(function () { /* the list is optional; the form still works */ });
  }

  /* ---------------------------------------------------------- send */

  function yesNo(name) {
    var picked = form.querySelector('input[name="' + name + '"]:checked');
    return picked ? picked.value === 'yes' : null;
  }

  function fail(message) {
    var box = el('rate-error');
    box.textContent = message;
    box.hidden = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    el('rate-error').hidden = true;

    var rating = 0;
    stars.forEach(function (s) { if (s.checked) rating = Number(s.value); });
    if (!rating) {
      fail('Choose 1 to 5 stars.');
      if (stars[0]) stars[0].focus();
      return;
    }

    var button = el('rate-submit');
    button.disabled = true;

    post({
      rating: rating,
      comment: el('rate-comment').value,
      // Not form.name: on a form element that is the form's own name.
      name: el('rate-name').value,
      contact: el('rate-contact').value,
      property_id: session ? null : (el('rate-site').value || null),
      easy_to_find: yesNo('easy_to_find'),
      easy_to_leave: yesNo('easy_to_leave'),
      session_id: session,
      website: el('rate-website').value,
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Could not send that just then. Try again?');
        form.hidden = true;
        el('rate-done-text').textContent = r.data.updated
          ? 'We’ve updated the review you sent for this booking.'
          : 'We’ve got it.';
        el('rate-done').hidden = false;
      })
      .catch(function (err) {
        fail(err.message || 'Could not send that just then. Try again?');
      })
      .finally(function () { button.disabled = false; });
  });
})();
