/* Talli Parking — contact us (docs/plans/reviews-and-contact.md, slice 2)

   Two jobs, on any page that loads it:

   1. Contact links. Any element marked data-talli-email, data-talli-phone
      or data-talli-sms is pointed at TALLI.contact, the one place the
      number lives. The page's own markup carries the same number, so it
      still works without JavaScript; this keeps them from drifting.
      data-talli-sms takes an optional data-sms-body, prefilled into the
      text.

   2. The homepage "Send us a message" form, sent to the submit-contact
      edge function.

   TalliContact.smsHref(body) is for other scripts (the confirmation page)
   building a "Text Andrew" link with the booking in it.
 */
(function () {
  'use strict';

  var CFG = window.TALLI;
  if (!CFG || !CFG.contact) return;
  var C = CFG.contact;

  // "?&body=" is the one form both iOS and Android read.
  function smsHref(body) {
    return 'sms:' + C.phoneIntl + (body ? '?&body=' + encodeURIComponent(body) : '');
  }
  window.TalliContact = { smsHref: smsHref, phone: C.phone, email: C.email };

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }
  each('[data-talli-email]', function (a) {
    a.href = 'mailto:' + C.email;
    a.textContent = C.email;
  });
  each('[data-talli-phone]', function (a) {
    a.href = 'tel:' + C.phoneIntl;
    a.textContent = C.phone;
  });
  each('[data-talli-sms]', function (a) {
    a.href = smsHref(a.getAttribute('data-sms-body') || '');
  });

  /* ------------------------------------------------------- the form */

  var form = document.getElementById('contact-form');
  if (!form) return;
  var el = function (id) { return document.getElementById(id); };

  function fail(message) {
    var box = el('contact-error');
    box.textContent = message;
    box.hidden = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    el('contact-error').hidden = true;

    var message = el('contact-message').value.trim();
    var email = el('contact-email').value.trim();
    var phone = el('contact-phone').value.trim();
    if (!message) { fail('Write a message first.'); el('contact-message').focus(); return; }
    if (!email && !phone) {
      fail('Leave an email or a phone number so we can reply.');
      el('contact-email').focus();
      return;
    }

    var button = el('contact-submit');
    button.disabled = true;

    fetch(CFG.supabaseUrl + '/functions/v1/submit-contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.anonKey,
        Authorization: 'Bearer ' + CFG.anonKey,
      },
      body: JSON.stringify({
        message: message,
        name: el('contact-name').value,
        email: email,
        phone: phone,
        website: el('contact-website').value,
      }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; })
          .then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Could not send that just then.');
        form.hidden = true;
        el('contact-done').hidden = false;
      })
      .catch(function (err) {
        fail((err.message || 'Could not send that just then.') +
          ' You can also email ' + C.email + '.');
      })
      .finally(function () { button.disabled = false; });
  });
})();
