/* Talli Parking — gate screen: card-qr.js

   Card by QR: a walk-up paying by card on their own phone.
 */

import { call, el, hide, make, money, show, text, toast } from './core.js';
import { fatal } from './session.js';
import { loadList } from './night.js';

/* -------------------------------------------------------- card by QR */

// gate-ops makes the Stripe link for what the booking owes; this draws it
// and watches for the payment. Closing the sheet changes nothing: the
// booking stays owing, and the link stays good until Stripe expires it.
var cardWatch = null;

export function stopCardWatch() {
  if (cardWatch) clearTimeout(cardWatch.timer);
  cardWatch = null;
}

function drawQr(url) {
  var box = el('ad-qr-code');
  box.innerHTML = '';
  if (typeof window.qrcode !== 'function') {
    box.appendChild(make('p', 'ad-empty', 'The QR could not be drawn. Close and try again.'));
    return;
  }
  // Error correction L: a Stripe link is long, and the fewer, larger
  // squares scan more easily from one phone screen to another.
  var qr = window.qrcode(0, 'L');
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

function cardState(kind, message) {
  var sheet = el('ad-qr');
  sheet.classList.toggle('is-paid', kind === 'paid');
  text(el('ad-qr-status'), message);
  el('ad-qr-hint').hidden = kind !== 'waiting';
  text(el('ad-qr-done'), kind === 'paid' ? 'Done' : 'Close');
}

export function openCardQr(bookingId, plate) {
  stopCardWatch();
  var watch = { bookingId: bookingId, timer: null };
  cardWatch = watch;
  text(el('ad-qr-title'), 'Scan to pay by card' + (plate ? ' — ' + plate : ''));
  text(el('ad-qr-amount'), '');
  el('ad-qr-code').innerHTML = '';
  cardState('making', 'Making the card link…');
  hide(el('ad-edit'));
  show(el('ad-qr'));

  call('card_link', { booking_id: bookingId })
    .then(function (data) {
      if (cardWatch !== watch) return;
      text(el('ad-qr-amount'), money(data.amount_cents) + ' including the card surcharge');
      drawQr(data.url);
      cardState('waiting', 'Waiting for them to pay…');
      pollCard(watch);
    })
    .catch(function (err) {
      if (cardWatch !== watch || fatal(err)) return;
      cardState('error', err.message + ' The car is saved as owing.');
    });
}

function pollCard(watch) {
  watch.timer = setTimeout(function () {
    if (cardWatch !== watch) return;
    call('card_status', { booking_id: watch.bookingId })
      .then(function (data) {
        if (cardWatch !== watch) return;
        if (data.paid) {
          el('ad-qr-code').innerHTML = '';
          cardState('paid', 'Paid by card ✓');
          toast('Paid by card', 'good');
          stopCardWatch();
          return loadList(true);
        }
        pollCard(watch);
      })
      .catch(function (err) {
        if (cardWatch !== watch || fatal(err)) return;
        pollCard(watch);   // a dropped request on a driveway is not a failure
      });
  }, 3000);
}

export function closeCardQr() {
  var wasWaiting = !!cardWatch;
  stopCardWatch();
  hide(el('ad-qr'));
  if (wasWaiting) loadList(true);
}
