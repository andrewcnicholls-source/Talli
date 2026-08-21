// =====================================================================
//  Talli Parking — gate operations
//
//  Everything the person on the driveway needs: the arrivals list, ticking
//  cars off as they turn in, selling a space to someone who just rolled up,
//  and shifting a booked car out to overflow to free the bay it was holding.
//  All of it writes, so all of it runs under the service role here rather
//  than being exposed through RLS.
//
//  Access is a shared passphrase held in the GATE_PASSPHRASE secret. That is
//  a deliberate MVP choice for a single operator with a phone in the rain —
//  no login flow, no email round-trip. It is checked in constant time, and
//  the function refuses to run at all if the secret is unset, so there is no
//  quiet default-open state.
// =====================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

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

// Compare without leaking length or position through timing.
function sameSecret(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  // Production refuses outright with no passphrase set, so there is never a
  // quiet default-open state on the live site. The test project gets a known
  // one instead, so the gate screen is usable without any secret setup.
  const expected = Deno.env.get('GATE_PASSPHRASE') ??
    (IS_TEST ? 'talli-test' : null)
  if (!expected) {
    console.error('GATE_PASSPHRASE is not set')
    return json({ error: 'The gate screen is not configured yet.' }, 503)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  if (!sameSecret(String(body.passphrase ?? ''), expected)) {
    return json({ error: 'Wrong passphrase.' }, 401)
  }

  const action = String(body.action ?? '')

  try {
    switch (action) {
      // Every event, not just the ones on sale — the gate needs drafts,
      // announced fixtures and closed ones too.
      case 'events': {
        const { data, error } = await db
          .from('event')
          .select('id, name, venue, starts_at, status')
          .order('starts_at', { ascending: true })
        if (error) throw error
        return json({ events: data })
      }

      case 'list': {
        const eventId = String(body.event_id ?? '')
        if (!eventId) return json({ error: 'event_id is required' }, 400)

        const { data, error } = await db
          .from('v_gate_list')
          .select('*')
          .eq('event_id', eventId)
        if (error) throw error

        // Not yet arrived first — that is the working list. Within each
        // group, earliest arrival window first.
        const rows = (data ?? []).sort((a, b) => {
          if (a.arrived !== b.arrived) return a.arrived ? 1 : -1
          return String(a.arrival_from ?? '').localeCompare(String(b.arrival_from ?? ''))
        })

        return json({
          rows,
          summary: {
            total: rows.length,
            arrived: rows.filter((r) => r.arrived).length,
            unpaid_holds: rows.filter((r) => r.status === 'held').length,
            cash_due_cents: rows
              .filter((r) => r.payment_method !== 'stripe' && !r.arrived)
              .reduce((sum, r) => sum + (r.amount_cents ?? 0), 0),
            taken_cents: rows
              .filter((r) => r.status === 'paid')
              .reduce((sum, r) => sum + (r.amount_cents ?? 0), 0),
          },
        })
      }

      // What is still sellable right now, for the walk-up form.
      case 'tiers': {
        const eventId = String(body.event_id ?? '')
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        const { data, error } = await db
          .from('v_tier_availability')
          .select('code, label, price_cents, spots_left_gate, property_id, sort_order')
          .eq('event_id', eventId)
          .order('sort_order', { ascending: true })
        if (error) throw error
        return json({ tiers: data })
      }

      case 'check_in': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)
        const { error } = await db.rpc('check_in_booking', { p_booking_id: id })
        if (error) throw error
        return json({ ok: true })
      }

      // Mis-taps happen, and happen most when it is busy.
      case 'undo_check_in': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)
        const { error } = await db
          .from('booking')
          .update({ checked_in_at: null })
          .eq('id', id)
        if (error) throw error
        return json({ ok: true })
      }

      // Shift a booked car out to overflow. The bay it was holding goes back
      // on sale, which is the whole point: a prepaid Standard sitting in the
      // back yard is worth more to you parked on the verge when there is a
      // queue at the gate.
      case 'move_to_overflow': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)

        const { data: booking, error: bErr } = await db
          .from('booking')
          .select('id, event_id, property_id, accepts_street_parking, vehicle_rego')
          .eq('id', id)
          .maybeSingle()
        if (bErr) throw bErr
        if (!booking) return json({ error: 'No such booking' }, 404)

        // reassign_booking refuses to place someone who never agreed to the
        // verge, and it is right to. At the gate you can simply ask them, so
        // allow that answer through — but only as a deliberate act, never as
        // a silent default.
        if (!booking.accepts_street_parking) {
          if (body.confirmed_consent !== true) {
            return json({
              error: 'This customer did not agree to overflow when they booked.',
              code: 'NEEDS_CONSENT',
            }, 409)
          }
          const { error: cErr } = await db
            .from('booking')
            .update({ accepts_street_parking: true })
            .eq('id', id)
          if (cErr) throw cErr
        }

        // First free overflow bay for this event. Ordered so the property's
        // own verge fills before the neighbour's.
        const { data: free, error: fErr } = await db
          .from('v_bay_inventory')
          .select('bay_id, bay_label, zone_code')
          .eq('event_id', booking.event_id)
          .eq('available', true)
          .eq('requires_consent', true)
          .order('zone_code', { ascending: true })
          .order('bay_label', { ascending: true })
          .limit(1)
        if (fErr) throw fErr
        if (!free || !free.length) {
          return json({ error: 'Overflow is full.', code: 'OVERFLOW_FULL' }, 409)
        }

        const { error: rErr } = await db.rpc('reassign_booking', {
          p_booking_id: id,
          p_target_bay_id: free[0].bay_id,
        })
        if (rErr) {
          const code = (rErr.message ?? '').split(':')[0].trim()
          return json({ error: rErr.message, code }, 409)
        }

        return json({ ok: true, moved_to: free[0].bay_label })
      }

      case 'sell': {
        const { data, error } = await db.rpc('sell_at_gate', {
          p_event_id: String(body.event_id ?? ''),
          p_property_id: String(body.property_id ?? ''),
          p_tier_code: String(body.tier_code ?? ''),
          p_payment_method: String(body.payment_method ?? 'cash'),
          p_rego: body.vehicle_rego ? String(body.vehicle_rego).toUpperCase() : null,
          p_name: body.name ? String(body.name) : null,
          p_phone: body.phone ? String(body.phone) : null,
          p_email: body.email ? String(body.email) : null,
          p_accepts_street: body.accepts_street === true,
        })
        if (error) {
          // The database raises named errors for the cases that mean
          // something specific. Pass the name through so the page can say
          // what actually happened.
          const code = (error.message ?? '').split(':')[0].trim()
          return json({ error: error.message, code }, 409)
        }
        return json({ ok: true, booking_id: data })
      }

      default:
        return json({ error: 'Unknown action' }, 400)
    }
  } catch (err) {
    console.error(action, err)
    return json({ error: (err as Error).message ?? 'Something went wrong' }, 500)
  }
})
