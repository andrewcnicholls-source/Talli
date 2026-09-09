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

// A row as PostgREST hands it back. Same reasoning as the other functions:
// this project generates no database types, so the client's inference gives
// up and returns an error-shaped type instead of a row.
type Row = Record<string, any>

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

// =====================================================================
//  THE CONFIRMATION EMAIL
//
//  Until 9 September 2026 there was not one. The first real customer paid,
//  was returned to the wrong site by a misconfigured secret, and had
//  nothing to show for it afterwards: no page, no email, a card charge and
//  a phone number to guess at. create-checkout now gets the return address
//  right; this is the other half of it, so that a booking survives the
//  customer closing the tab.
//
//  Three rules, and all three are about not making a paid booking worse:
//
//    * It never fails the webhook. Stripe is being told whether we have
//      recorded the payment, not whether we managed to send mail. Throwing
//      here would have Stripe retry a booking that is already confirmed.
//    * It never sends twice. Stripe re-delivers, so the send is claimed in
//      the database first — the update matches only a row whose
//      confirmation_email_sent_at is still null, and losing that race means
//      another delivery is already sending it.
//    * It goes last, after the booking is confirmed and read back. The
//      email says "you are booked in", so it must not be able to arrive
//      before that is true.
//
//  With no RESEND_API_KEY the whole thing is a no-op, which is the normal
//  state of the test project.
// =====================================================================

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const TZ = 'Pacific/Auckland'

const FROM_EMAIL = Deno.env.get('TALLI_FROM_EMAIL') ??
  'Talli Parking <bookings@talli.co.nz>'
const REPLY_TO = Deno.env.get('TALLI_REPLY_TO') ?? 'talli.parking@gmail.com'

const money = (cents: number) =>
  '$' + (cents % 100 === 0 ? (cents / 100).toFixed(0) : (cents / 100).toFixed(2))

const onDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-NZ', {
        timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      })
    : null

const atTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-NZ', {
        timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
      }).replace(/\s/g, '').toLowerCase()
    : null

// Customer-supplied text goes into HTML. Their name is whatever they typed.
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

async function sendConfirmationEmail(bookingId: string): Promise<void> {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) {
    console.log('no RESEND_API_KEY on this project; not emailing', bookingId)
    return
  }

  const { data: bookingRow } = await db
    .from('booking')
    .select(
      'id, status, customer_email, customer_name, vehicle_rego, ' +
      'vehicle_low_clearance, tier_code, amount_cents, addons_cents, ' +
      'surcharge_cents, arrival_from, arrival_until, must_depart_by, ' +
      'event_id, property_id, confirmation_email_sent_at',
    )
    .eq('id', bookingId)
    .maybeSingle()

  const b = bookingRow as Row | null
  if (!b) return
  // Only a booking that actually holds a bay gets told that it does.
  if (b.status !== 'paid') return
  if (!b.customer_email) return
  if (b.confirmation_email_sent_at) return

  // Claim the send. Whoever's update matches the row owns it; a concurrent
  // re-delivery matches nothing and goes home.
  const { data: claimed } = await db
    .from('booking')
    .update({ confirmation_email_sent_at: new Date().toISOString() })
    .eq('id', bookingId)
    .is('confirmation_email_sent_at', null)
    .select('id')
    .maybeSingle()
  if (!claimed) return

  const unclaim = () =>
    db.from('booking')
      .update({ confirmation_email_sent_at: null })
      .eq('id', bookingId)

  try {
    const [{ data: ev }, { data: property }, { data: tier }, { data: addons }] =
      await Promise.all([
        db.from('event').select('name, starts_at').eq('id', b.event_id).maybeSingle(),
        db.from('property').select('name, address').eq('id', b.property_id).maybeSingle(),
        db.from('offer_tier').select('label').eq('code', b.tier_code).limit(1).maybeSingle(),
        db.from('booking_addon').select('name, qty').eq('booking_id', b.id).order('code'),
      ])

    const reference = String(b.id).slice(0, 8).toUpperCase()
    const total = (b.amount_cents ?? 0) + (b.addons_cents ?? 0) + (b.surcharge_cents ?? 0)
    const spot = String(tier?.label ?? b.tier_code).split(/\s+—\s+/)[0]
    const address = property?.address ?? '86 Paice Avenue, Sandringham'
    const extras = (addons ?? []).map((a: Row) =>
      a.qty > 1 ? `${a.name} × ${a.qty}` : String(a.name))

    const arrival = b.arrival_from && b.arrival_until
      ? `between ${atTime(b.arrival_from)} and ${atTime(b.arrival_until)}`
      : null

    // Label, value. Anything without a value never reaches the email.
    const rows: Array<[string, string | null]> = [
      ['Event', ev?.name ?? null],
      ['Date', ev?.starts_at ? `${onDate(ev.starts_at)}, ${atTime(ev.starts_at)}` : null],
      ['Where', address],
      ['Arrive', arrival],
      ['Back at your car by', atTime(b.must_depart_by)],
      ['Spot', spot],
      ['Vehicle', b.vehicle_rego ?? null],
      ['Low car', b.vehicle_low_clearance ? 'Noted — we will keep you off the steep entry' : null],
      ['Card surcharge', b.surcharge_cents ? money(b.surcharge_cents) : null],
      ['Paid', money(total)],
    ]
    const shown = rows.filter((r): r is [string, string] => Boolean(r[1]))

    // The plate line is dropped rather than softened when there is no rego
    // on the booking: telling someone to have handy a thing they never gave
    // us reads as a mistake, because it is one.
    //
    // Nothing here names an arrival time. The booking's own window is in the
    // table above, worked out from kick-off for this event, and a second
    // instruction beside it could only ever agree with it by accident.
    const onTheNight = [
      'Please follow the marshal’s directions on where to park. We double-park ' +
        'to fit everyone in, and on a full night that can mean being parked in ' +
        'an overflow area.',
      b.vehicle_rego
        ? `Have your plate handy (${b.vehicle_rego}) — that is how we find your booking.`
        : null,
      'Ponchos, earplugs and lolly bags are available on arrival, cash or bank transfer.',
    ].filter((line): line is string => Boolean(line))

    const subject = ev?.name
      ? `You’re booked in — ${ev.name} (${reference})`
      : `You’re booked in — Talli Parking (${reference})`

    const text = [
      'You’re booked in.',
      '',
      `Reference: ${reference}`,
      '',
      ...shown.map(([k, v]) => `${k}: ${v}`),
      ...(extras.length ? ['', 'Already paid for:', ...extras.map((e) => `  ${e}`),
        '  Ask the marshal for these when you pull in.'] : []),
      '',
      'On the night',
      ...onTheNight.map((l) => `- ${l}`),
      '',
      `Coming in a different car? Reply to this email with your reference and the`,
      `new plate before the night, so the marshal is looking for the right car.`,
      '',
      `Questions: ${REPLY_TO}`,
    ].join('\n')

    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;
        max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">
  <h1 style="font-size:22px;margin:0 0 4px">You&rsquo;re booked in.</h1>
  <p style="margin:0 0 20px;color:#555">We&rsquo;ve saved you a spot. Keep this email
     — your reference is below.</p>
  <p style="margin:0 0 20px;padding:12px 16px;background:#f4f2ee;border-radius:6px;
     font-size:18px"><strong>${esc(reference)}</strong></p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
    ${shown.map(([k, v]) => `<tr>
      <td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;
          white-space:nowrap">${esc(k)}</td>
      <td style="padding:6px 0"><strong>${esc(v)}</strong></td></tr>`).join('')}
  </table>
  ${extras.length ? `<h2 style="font-size:15px;margin:0 0 6px">Already paid for</h2>
  <ul style="margin:0 0 6px;padding-left:20px">
    ${extras.map((e) => `<li>${esc(e)}</li>`).join('')}
  </ul>
  <p style="margin:0 0 20px;color:#666">Ask the marshal for these when you pull in.</p>` : ''}
  <h2 style="font-size:15px;margin:0 0 6px">On the night</h2>
  <ul style="margin:0 0 20px;padding-left:20px">
    ${onTheNight.map((l) => `<li style="margin-bottom:4px">${esc(l)}</li>`).join('')}
  </ul>
  <p style="margin:0 0 20px;padding:12px 16px;background:#f4f2ee;border-radius:6px">
    <strong>Coming in a different car?</strong> Reply to this email with your
    reference and the new plate before the night, so the marshal is looking for
    the right car.</p>
  <p style="margin:0;color:#666;font-size:13px">Questions:
    <a href="mailto:${esc(REPLY_TO)}">${esc(REPLY_TO)}</a></p>
</div>`

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [b.customer_email],
        reply_to: REPLY_TO,
        subject,
        text,
        html,
      }),
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300)
      await unclaim()
      await note(bookingId, `Confirmation email FAILED (${res.status}): ${detail}`)
      console.error('confirmation email failed', bookingId, res.status, detail)
      return
    }

    console.log('confirmation email sent', bookingId)
  } catch (err) {
    // Reaching here means the booking is paid and the customer has not been
    // told. That is a thing a human has to see, so it goes on the booking
    // where the gate screen shows it, not only into the logs.
    await unclaim()
    await note(bookingId, `Confirmation email FAILED: ${(err as Error).message}`)
    console.error('confirmation email threw', bookingId, err)
  }
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
        // Last, and never able to fail this handler: see above.
        await sendConfirmationEmail(bookingId)
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
        await sendConfirmationEmail(bookingId)
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
