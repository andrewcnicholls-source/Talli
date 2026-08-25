// =====================================================================
//  Talli Parking — create a Checkout Session for one parking booking
//
//  Flow, and the order matters:
//    1. hold_booking() allocates a real bay inside one transaction. If the
//       yard is full it raises and we never touch Stripe.
//    2. add_booking_addons() prices any extras — server side, from the
//       catalogue, never from the request body.
//    3. Only then do we create the Checkout Session, priced from the rows
//       the database just wrote.
//    4. The session's expiry sits INSIDE the hold, so Stripe stops accepting
//       payment before the sweeper can release the bay. A customer can never
//       pay for a spot that has just been given away.
//
//  No price is ever sent from here. A browser does not get to choose what
//  it pays — not for the bay, and not for a poncho.
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

// Service role: this function is the only thing allowed to write bookings.
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// ---------------------------------------------------------------------
//  TEST-PROJECT FALLBACKS
//
//  The test Supabase project has no secrets of its own, so this block
//  supplies workable defaults there and ONLY there. IS_TEST compares the
//  project's own SUPABASE_URL — injected by Supabase, not settable by a
//  caller — against the test project's ref. On production it is false and
//  every fallback below is unreachable. A real secret always wins: these
//  are fallbacks, never overrides.
// ---------------------------------------------------------------------
const TEST_PROJECT_REF = 'uhdoverwvlxvyyctskle'
const IS_TEST = (Deno.env.get('SUPABASE_URL') ?? '').includes(TEST_PROJECT_REF)

const SITE_URL = Deno.env.get('SITE_URL') ??
  (IS_TEST ? 'https://talli-test.netlify.app' : 'https://talli.co.nz')
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

// Holds run slightly longer than the Stripe session so the sweeper can never
// beat a payment in flight. Stripe's minimum session life is 30 minutes.
const SESSION_MINUTES = 30
const HOLD_MINUTES = 34

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

// The database raises these deliberately. Each one means something different
// to the customer, so pass the distinction through rather than flattening it
// into "sorry, unavailable".
const SALE_ERRORS: Record<string, { status: number; message: string }> = {
  SOLD_OUT: {
    status: 409,
    message: 'That option has just sold out.',
  },
  HELD_FOR_GATE: {
    status: 409,
    message:
      'Online sales for that option have finished — there are still spaces, ' +
      'but they are held for arrivals on the night. Come to 86 Paice Ave and ' +
      'ask the marshal.',
  },
  ONLINE_SALES_CLOSED: {
    status: 409,
    message:
      'Online booking has closed for this event. There may still be space on ' +
      'the night — come to 86 Paice Ave and ask the marshal.',
  },
  CONSENT_REQUIRED: {
    status: 409,
    message:
      'The only space left is on the street verge, which we place by hand on ' +
      'the night. Come to 86 Paice Ave and ask the marshal.',
  },
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  // With no key at all, production must refuse. The test project instead
  // falls through to the stub below, so the booking flow stays testable
  // before anyone has pasted a Stripe test key in.
  let stripe: Stripe | null = null
  try {
    stripe = getStripe()
  } catch (err) {
    if (!IS_TEST) {
      console.error(err)
      return json({ error: 'Payments are not configured on this project yet' }, 503)
    }
  }
  const stubPayments = stripe === null

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  const eventId = String(body.event_id ?? '')
  const propertyId = String(body.property_id ?? '')
  const tierCode = String(body.tier_code ?? '')
  const email = String(body.email ?? '').trim()

  if (!eventId || !propertyId || !tierCode || !email) {
    return json(
      { error: 'event_id, property_id, tier_code and email are all required' },
      400,
    )
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'That email address does not look right' }, 400)
  }

  // Extras arrive as {code, qty} and are taken no further than that. The
  // database looks up what each code costs and how many one booking may have.
  const addonsRequested = Array.isArray(body.addons)
    ? (body.addons as Array<Record<string, unknown>>)
        .map((a) => ({ code: String(a?.code ?? ''), qty: Number(a?.qty ?? 0) }))
        .filter((a) => a.code && Number.isFinite(a.qty) && a.qty > 0)
    : []

  // Only sell what is actually on sale. Draft and closed fixtures are invisible
  // to the public key anyway, but this function runs as service role, which
  // bypasses RLS — so check explicitly.
  const { data: ev, error: evErr } = await db
    .from('event')
    .select('id, name, status, starts_at')
    .eq('id', eventId)
    .maybeSingle()

  if (evErr) return json({ error: 'Could not load that event' }, 500)
  if (!ev) return json({ error: 'No such event' }, 404)
  if (ev.status !== 'on_sale') {
    return json({ error: 'That event is not on sale', code: 'NOT_ON_SALE' }, 409)
  }

  // ---- 1. Allocate a bay. Atomic: booking and allocation, or neither.
  //
  // Nothing is asked about the overflow verge any more. Where a car actually
  // ends up is a judgement made in the driveway on the night, by someone
  // standing next to it — not a checkbox ticked a fortnight earlier.
  const { data: bookingId, error: holdErr } = await db.rpc('hold_booking', {
    p_event_id: eventId,
    p_property_id: propertyId,
    p_tier_code: tierCode,
    p_email: email,
    p_name: body.name ? String(body.name) : null,
    p_phone: body.phone ? String(body.phone) : null,
    p_rego: body.vehicle_rego ? String(body.vehicle_rego) : null,
    p_hold_minutes: HOLD_MINUTES,
    p_channel: 'online',
    p_accepts_street: false,
    p_payment_method: 'stripe',
  })

  if (holdErr) {
    const code = (holdErr.message ?? '').split(':')[0].trim()
    const known = SALE_ERRORS[code]
    if (known) return json({ error: known.message, code }, known.status)
    console.error('hold_booking failed', holdErr)
    return json({ error: 'Could not hold a space just then' }, 500)
  }

  // Give the bay back rather than leave it held for half an hour.
  const abandon = async () => {
    await db.rpc('release_booking', { p_booking_id: bookingId, p_status: 'cancelled' })
  }

  // ---- 2. Price the extras, if any.
  if (addonsRequested.length) {
    const { error: addonErr } = await db.rpc('add_booking_addons', {
      p_booking_id: bookingId,
      p_items: addonsRequested,
      p_channel: 'online',
    })
    if (addonErr) {
      console.error('add_booking_addons failed', addonErr)
      await abandon()
      return json({ error: 'We could not add those extras. Try again without them.' }, 400)
    }
  }

  // ---- 3. Read back what the database actually wrote. Prices come from here.
  const [{ data: booking, error: bErr }, { data: addonRows }] = await Promise.all([
    db.from('booking')
      .select('id, amount_cents, addons_cents, currency, arrival_from, arrival_until, must_depart_by, tier_code')
      .eq('id', bookingId)
      .single(),
    db.from('booking_addon')
      .select('code, name, qty, amount_cents')
      .eq('booking_id', bookingId)
      .order('code'),
  ])

  if (bErr || !booking) {
    await abandon()
    return json({ error: 'Could not read the booking back' }, 500)
  }

  const [{ data: tier }, { data: property }] = await Promise.all([
    db.from('offer_tier').select('label, event_offer_id').eq('code', tierCode)
      .limit(1).maybeSingle(),
    db.from('property').select('name, address, walk_minutes').eq('id', propertyId)
      .maybeSingle(),
  ])

  const tz = 'Pacific/Auckland'
  const hhmm = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString('en-NZ', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
        })
      : null

  const arrival = booking.arrival_from && booking.arrival_until
    ? `Arrive ${hhmm(booking.arrival_from)}–${hhmm(booking.arrival_until)}`
    : null
  const departure = booking.must_depart_by
    ? `Back at your car by ${hhmm(booking.must_depart_by)}`
    : null

  const description = [
    property?.name,
    property?.walk_minutes ? `${property.walk_minutes} min walk to the ground` : null,
    arrival,
    departure,
  ].filter(Boolean).join(' · ')

  const currency = booking.currency ?? 'nzd'

  // One line per item at quantity 1, carrying the count in the name. Bundle
  // pricing means unit × qty does not equal what is owed — "2 for $5" is not
  // expressible as a Stripe unit price — so the line total is the honest one.
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
    quantity: 1,
    price_data: {
      currency,
      unit_amount: booking.amount_cents,   // <- from the database, always
      product_data: {
        name: `${tier?.label ?? tierCode} — ${ev.name}`,
        description: description || undefined,
      },
    },
  }]

  for (const line of addonRows ?? []) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency,
        unit_amount: line.amount_cents,
        product_data: {
          name: line.qty > 1 ? `${line.name} × ${line.qty}` : line.name,
          description: 'Collect from the marshal when you arrive',
        },
      },
    })
  }

  // ---- 3a. TEST ONLY: stand in for the entire Stripe round-trip.
  // Writes a recognisable fake session id, confirms the booking exactly as
  // the webhook would, and hands back the same confirmation URL the real
  // flow uses — so every screen after this point is still exercised for
  // real, extras included. Unreachable on production: see IS_TEST above.
  if (stubPayments) {
    const fakeSession = `cs_test_stub_${crypto.randomUUID().replace(/-/g, '')}`
    await db.from('booking')
      .update({ stripe_checkout_session_id: fakeSession })
      .eq('id', bookingId)
    await db.rpc('confirm_booking', {
      p_booking_id: bookingId,
      p_payment_intent_id: `pi_test_stub_${fakeSession.slice(-12)}`,
    })
    console.log('stubbed payment for booking', bookingId,
      'with', (addonRows ?? []).length, 'extras')
    return json({
      url: `${SITE_URL}/booking-confirmed.html?session_id=${fakeSession}`,
      booking_id: bookingId,
      stubbed_payment: true,
    })
  }

  // ---- 4. Create the session, expiring inside the hold.
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60

  try {
    const session = await stripe!.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      expires_at: expiresAt,
      line_items: lineItems,
      // Session metadata does NOT reach the PaymentIntent; set both, so a
      // refund or dispute months later still points at the booking.
      metadata: {
        booking_id: String(bookingId),
        event_id: eventId,
        property_id: propertyId,
        tier_code: tierCode,
      },
      payment_intent_data: {
        metadata: { booking_id: String(bookingId) },
      },
      success_url: `${SITE_URL}/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/?cancelled=1`,
    })

    await db.from('booking')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', bookingId)

    return json({ url: session.url, booking_id: bookingId, expires_at: expiresAt })
  } catch (err) {
    // Stripe refused.
    console.error('stripe session failed', err)
    await abandon()
    return json({ error: 'Could not start checkout just then' }, 502)
  }
})
