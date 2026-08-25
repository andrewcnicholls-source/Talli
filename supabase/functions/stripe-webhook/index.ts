// =====================================================================
//  Talli Parking — Stripe webhook
//
//  Runs with verify_jwt = false, because Stripe cannot send a Supabase JWT.
//  Authentication is the signature check below — which is why this function
//  must never do anything before constructEventAsync succeeds.
//
//  Two rules that matter more than they look:
//    * Verify against the RAW body. Parsing the JSON first breaks the
//      signature.
//    * Record the event id before acting. Stripe re-delivers, and a
//      double-processed booking is a double-sold bay.
// =====================================================================

import Stripe from 'https://esm.sh/stripe@18?target=denonext'
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Built lazily so a missing secret returns a readable error instead of
// crashing the whole function at module load.
let _stripe: Stripe | null = null
function getStripe(): Stripe {
  if (!_stripe) {
    const key = Deno.env.get('STRIPE_SECRET_KEY')
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set on this project')
    _stripe = new Stripe(key)
  }
  return _stripe
}

// Deno needs the Web Crypto provider for signature verification.
const cryptoProvider = Stripe.createSubtleCryptoProvider()

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const ok = (note: string) =>
  new Response(JSON.stringify({ received: true, note }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

async function bookingIdFrom(obj: Record<string, any>): Promise<string | null> {
  const direct = obj?.metadata?.booking_id
  if (direct) return String(direct)

  // Charges and disputes carry the PaymentIntent, not our metadata.
  const pi = obj?.payment_intent
  if (typeof pi === 'string') {
    const { data } = await db.from('booking')
      .select('id').eq('stripe_payment_intent_id', pi).maybeSingle()
    if (data?.id) return data.id
    try {
      const intent = await getStripe().paymentIntents.retrieve(pi)
      if (intent.metadata?.booking_id) return String(intent.metadata.booking_id)
    } catch { /* fall through */ }
  }
  return null
}

async function note(bookingId: string, text: string) {
  const { data } = await db.from('booking').select('notes').eq('id', bookingId).maybeSingle()
  const stamped = `[${new Date().toISOString()}] ${text}`
  await db.from('booking')
    .update({ notes: data?.notes ? `${data.notes}\n${stamped}` : stamped })
    .eq('id', bookingId)
}

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature')
  if (!signature) return new Response('Missing signature', { status: 400 })

  const secret = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET')
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SIGNING_SECRET is not set')
    return new Response('Webhook not configured', { status: 503 })
  }

  let stripe: Stripe
  try {
    stripe = getStripe()
  } catch (err) {
    console.error(err)
    return new Response('Payments not configured', { status: 503 })
  }

  const raw = await req.text()

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw,
      signature,
      secret,
      undefined,
      cryptoProvider,
    )
  } catch (err) {
    console.error('signature verification failed', err)
    return new Response('Invalid signature', { status: 400 })
  }

  // Idempotency gate. A conflict means we have already handled this delivery.
  const { error: seenErr } = await db
    .from('processed_webhook_event')
    .insert({ stripe_event_id: event.id, type: event.type })
  if (seenErr) {
    if (seenErr.code === '23505') return ok('duplicate delivery, ignored')
    console.error('idempotency insert failed', seenErr)
    // Fail loudly so Stripe retries rather than us silently skipping work.
    return new Response('Could not record event', { status: 500 })
  }

  const obj = event.data.object as Record<string, any>

  try {
    switch (event.type) {
      // ------------------------------------------------ payment succeeded
      case 'checkout.session.completed': {
        const bookingId = await bookingIdFrom(obj)
        if (!bookingId) return ok('no booking_id in metadata')

        // Delayed-notification methods complete the session while still
        // unpaid; they settle later via async_payment_succeeded. Anything
        // that is not explicitly unpaid is fulfillable now.
        if (obj.payment_status === 'unpaid') {
          await note(bookingId, 'Checkout completed, awaiting payment settlement.')
          return ok('completed but unpaid, waiting')
        }

        await db.rpc('confirm_booking', {
          p_booking_id: bookingId,
          p_payment_intent_id: obj.payment_intent ?? null,
        })

        // confirm_booking only touches held/paid rows. If the hold had already
        // been swept we have taken money for a bay we no longer own — rare,
        // because the session expires inside the hold, but it must never pass
        // silently.
        const { data: after } = await db.from('booking')
          .select('status').eq('id', bookingId).maybeSingle()
        if (after?.status !== 'paid') {
          await note(
            bookingId,
            `PAID BUT NOT ALLOCATED — status was "${after?.status}" when payment ` +
            `landed. Refund or place manually.`,
          )
          console.error('PAID BUT NOT ALLOCATED', bookingId, after?.status)
          return ok('paid but booking was not holdable — flagged')
        }
        return ok('confirmed')
      }

      // ------------------------------------------------ delayed settlement
      case 'checkout.session.async_payment_succeeded': {
        const bookingId = await bookingIdFrom(obj)
        if (!bookingId) return ok('no booking_id in metadata')
        await db.rpc('confirm_booking', {
          p_booking_id: bookingId,
          p_payment_intent_id: obj.payment_intent ?? null,
        })
        return ok('confirmed after delayed settlement')
      }

      case 'checkout.session.async_payment_failed': {
        const bookingId = await bookingIdFrom(obj)
        if (!bookingId) return ok('no booking_id in metadata')
        await db.rpc('release_booking', {
          p_booking_id: bookingId, p_status: 'cancelled',
        })
        return ok('released after failed settlement')
      }

      // ------------------------------------------------ abandoned checkout
      case 'checkout.session.expired': {
        const bookingId = await bookingIdFrom(obj)
        if (!bookingId) return ok('no booking_id in metadata')
        await db.rpc('release_booking', {
          p_booking_id: bookingId, p_status: 'expired',
        })
        return ok('bay returned to sale')
      }

      // ------------------------------------------------ money going back
      case 'charge.refunded': {
        const bookingId = await bookingIdFrom(obj)
        if (!bookingId) return ok('no booking found for that charge')
        const fully = obj.amount_refunded >= obj.amount
        if (fully) {
          await db.rpc('release_booking', {
            p_booking_id: bookingId, p_status: 'refunded',
          })
          await note(bookingId, 'Fully refunded; bay returned to sale.')
          return ok('refunded and released')
        }
        await note(
          bookingId,
          `Partial refund of ${(obj.amount_refunded / 100).toFixed(2)} ` +
          `${String(obj.currency).toUpperCase()}. Bay kept.`,
        )
        return ok('partial refund noted')
      }

      // ------------------------------------------------ disputes
      case 'charge.dispute.created': {
        const bookingId = await bookingIdFrom(obj)
        if (!bookingId) return ok('no booking found for that dispute')
        await note(
          bookingId,
          `DISPUTE opened for ${(obj.amount / 100).toFixed(2)} ` +
          `${String(obj.currency).toUpperCase()}, reason "${obj.reason}". ` +
          `Respond in the Stripe Dashboard. NZ$25 fee applies.`,
        )
        console.error('dispute opened', bookingId, obj.reason)
        return ok('dispute flagged on the booking')
      }

      default:
        return ok(`ignored ${event.type}`)
    }
  } catch (err) {
    console.error('handler failed', event.type, err)
    // Let Stripe retry. The idempotency row is already written, so remove it
    // first or the retry would be treated as a duplicate.
    await db.from('processed_webhook_event')
      .delete().eq('stripe_event_id', event.id)
    return new Response('Handler error', { status: 500 })
  }
})
