/* Fake Stripe webhook deliveries, signed the way Stripe signs them, with
   the local stack's stand-in signing secret (supabase/config.toml). */
'use strict';
const crypto = require('node:crypto');
const { callFn } = require('./stack');

const WEBHOOK_SECRET = 'whsec_local_stack_not_a_secret';

function sign(payload, secret = WEBHOOK_SECRET) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function deliver(event, secret) {
  const payload = JSON.stringify(event);
  return callFn('stripe-webhook', payload, undefined, { 'Stripe-Signature': sign(payload, secret) });
}

const hex = () => crypto.randomUUID().replace(/-/g, '');

function sessionCompleted(bookingId, sessionId = `cs_test_${hex()}`) {
  return {
    id: `evt_test_${hex()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: {
      id: sessionId, object: 'checkout.session',
      payment_status: 'paid', payment_intent: `pi_test_${hex()}`,
      metadata: { booking_id: bookingId },
    } },
  };
}

module.exports = { WEBHOOK_SECRET, deliver, sessionCompleted };
