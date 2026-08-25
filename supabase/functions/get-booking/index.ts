// =====================================================================
//  Talli Parking — read one booking back for the confirmation page
//
//  The customer lands here straight from Stripe, often before the webhook
//  has been delivered. So this reports the booking exactly as it stands and
//  lets the page decide whether to wait: "held" means paid-but-not-yet-
//  confirmed from the browser's point of view, and the page polls.
//
//  Keyed on the Checkout Session id, which is long and unguessable and
//  only ever appears in the URL Stripe redirects to. Nothing sensitive is
//  returned — no email, no payment identifiers.
// =====================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  const sessionId = String(body.session_id ?? '').trim()
  if (!sessionId.startsWith('cs_')) {
    return json({ error: 'A Checkout Session id is required' }, 400)
  }

  const { data: booking, error } = await db
    .from('booking')
    .select(
      'id, status, tier_code, customer_name, vehicle_rego, amount_cents, addons_cents, ' +
      'currency, arrival_from, arrival_until, must_depart_by, event_id, property_id',
    )
    .eq('stripe_checkout_session_id', sessionId)
    .maybeSingle()

  if (error) {
    console.error('booking lookup failed', error)
    return json({ error: 'Could not look that booking up' }, 500)
  }
  if (!booking) return json({ error: 'No booking found for that session' }, 404)

  const [{ data: ev }, { data: property }, { data: tier }, { data: addons }] =
    await Promise.all([
      db.from('event').select('name, venue, starts_at').eq('id', booking.event_id).maybeSingle(),
      db.from('property').select('name, address, walk_minutes').eq('id', booking.property_id)
        .maybeSingle(),
      db.from('offer_tier').select('label').eq('code', booking.tier_code).limit(1).maybeSingle(),
      db.from('booking_addon').select('code, name, qty, amount_cents')
        .eq('booking_id', booking.id).order('code'),
    ])

  return json({
    // Short enough to read down the phone, long enough not to collide.
    reference: booking.id.slice(0, 8).toUpperCase(),
    status: booking.status,
    tier_label: tier?.label ?? booking.tier_code,
    customer_name: booking.customer_name,
    vehicle_rego: booking.vehicle_rego,
    amount_cents: booking.amount_cents,
    addons_cents: booking.addons_cents ?? 0,
    // Named on the page so the customer knows to ask for them, and knows
    // they are already paid for.
    addons: addons ?? [],
    currency: booking.currency,
    arrival_from: booking.arrival_from,
    arrival_until: booking.arrival_until,
    must_depart_by: booking.must_depart_by,
    event: ev ?? null,
    property: property ?? null,
  })
})
