// =====================================================================
//  Talli Parking — gate operations
//
//  Everything the person on the driveway needs: the arrivals list, ticking
//  cars off as they turn in, handing over pre-purchased extras, selling a
//  space to someone who just rolled up, moving a booked car out to overflow,
//  and — new — keeping the night's capacity and prices honest as they move.
//
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

// The database raises named errors for the cases that mean something
// specific. Pass the name through so the screen can say what happened.
const named = (err: { message?: string }) => ({
  error: err.message ?? 'That did not work',
  code: (err.message ?? '').split(':')[0].trim(),
})

type Row = Record<string, any>

// Everything the gate screen draws, from one round trip. On a phone at the
// end of a driveway, one request that sometimes carries a little too much
// beats four that each might not arrive.
async function nightState(eventId: string) {
  const [listRes, capRes, tierRes] = await Promise.all([
    db.from('v_gate_list').select('*').eq('event_id', eventId),
    db.from('v_night_capacity').select('*').eq('event_id', eventId)
      .order('exit_rank', { ascending: true }),
    db.from('v_tier_availability').select('*').eq('event_id', eventId)
      .order('sort_order', { ascending: true }),
  ])
  if (listRes.error) throw listRes.error
  if (capRes.error) throw capRes.error
  if (tierRes.error) throw tierRes.error

  // Not yet arrived first — that is the working list. Within each group,
  // earliest arrival window first.
  const rows = (listRes.data ?? []).sort((a, b) => {
    if (a.arrived !== b.arrived) return a.arrived ? 1 : -1
    return String(a.arrival_from ?? '').localeCompare(String(b.arrival_from ?? ''))
  })

  const zones = capRes.data ?? []
  const paid = rows.filter((r: Row) => r.status === 'paid')
  const value = (r: Row) => (r.amount_cents ?? 0) + (r.addons_cents ?? 0)

  // What is still in the box. Counted across the whole event, because the
  // question at 5pm is "have I got enough ponchos", not "who bought them".
  const extras = new Map<string, { code: string; name: string; total: number; pending: number }>()
  for (const r of rows) {
    if (r.status !== 'paid') continue
    for (const line of (r.addons ?? []) as Row[]) {
      const at = extras.get(line.code) ??
        { code: line.code, name: line.name, total: 0, pending: 0 }
      at.total += line.qty
      if (!line.handed) at.pending += line.qty
      extras.set(line.code, at)
    }
  }

  const capacity = zones.reduce((n: number, z: Row) => n + z.capacity, 0)
  const filled = zones.reduce((n: number, z: Row) => n + z.filled, 0)

  return {
    rows,
    zones,
    tiers: tierRes.data ?? [],
    extras: [...extras.values()].sort((a, b) => a.name.localeCompare(b.name)),
    summary: {
      total: rows.length,
      arrived: rows.filter((r: Row) => r.arrived).length,
      unpaid_holds: rows.filter((r: Row) => r.status === 'held').length,
      // Spaces, not bookings. A valet car and a berm car both take one.
      capacity,
      filled,
      free: capacity - filled,
      lost: zones.reduce((n: number, z: Row) => n + z.lost, 0),
      opened: zones.reduce((n: number, z: Row) => n + z.opened, 0),
      cash_due_cents: rows
        .filter((r: Row) => r.payment_method !== 'stripe' && !r.arrived)
        .reduce((sum: number, r: Row) => sum + value(r), 0),
      taken_cents: paid.reduce((sum: number, r: Row) => sum + value(r), 0),
      online_cents: paid.filter((r: Row) => r.channel === 'online')
        .reduce((sum: number, r: Row) => sum + value(r), 0),
      gate_cents: paid.filter((r: Row) => r.channel === 'gate')
        .reduce((sum: number, r: Row) => sum + value(r), 0),
      addons_cents: paid.reduce((sum: number, r: Row) => sum + (r.addons_cents ?? 0), 0),
      extras_pending: rows
        .filter((r: Row) => r.status === 'paid')
        .reduce((sum: number, r: Row) => sum + (r.addons_pending ?? 0), 0),
    },
  }
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
  const eventId = String(body.event_id ?? '')

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
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        return json(await nightState(eventId))
      }

      // What is still sellable right now, for the walk-up form.
      case 'tiers': {
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        const { data, error } = await db
          .from('v_tier_availability')
          .select('code, label, price_cents, spots_left_gate, manually_sold_out, property_id, sort_order')
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

      // One tap covers the whole bag. Nobody hands over a poncho and an
      // earplug pair as two separate transactions.
      case 'hand_over': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)
        const { data, error } = await db.rpc('set_addons_handed_over', {
          p_booking_id: id,
          p_handed: body.handed !== false,
        })
        if (error) throw error
        return json({ ok: true, lines: data })
      }

      // Shift a booked car out to overflow. The bay it was holding goes back
      // on sale, which is the whole point: a prepaid Standard sitting in the
      // back yard is worth more to you parked on the verge when there is a
      // queue at the gate.
      //
      // Nobody is asked to agree to this in advance any more, so nobody is
      // asked to confirm it here either. Standing in the driveway telling
      // someone where to put their car IS the conversation.
      case 'move_to_overflow': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)

        const { data: booking, error: bErr } = await db
          .from('booking')
          .select('id, event_id, accepts_street_parking, vehicle_rego')
          .eq('id', id)
          .maybeSingle()
        if (bErr) throw bErr
        if (!booking) return json({ error: 'No such booking' }, 404)

        // reassign_booking refuses to place someone whose row does not say
        // they will go on the verge. Record the decision that was just made
        // out loud, then move them.
        if (!booking.accepts_street_parking) {
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
        if (rErr) return json(named(rErr), 409)

        return json({ ok: true, moved_to: free[0].bay_label })
      }

      case 'sell': {
        const { data, error } = await db.rpc('sell_at_gate', {
          p_event_id: eventId,
          p_property_id: String(body.property_id ?? ''),
          p_tier_code: String(body.tier_code ?? ''),
          p_payment_method: String(body.payment_method ?? 'cash'),
          p_rego: body.vehicle_rego ? String(body.vehicle_rego).toUpperCase() : null,
          p_name: body.name ? String(body.name) : null,
          p_phone: body.phone ? String(body.phone) : null,
          p_email: body.email ? String(body.email) : null,
          // Always true at the gate. This flag is what lets sell_at_gate reach
          // the berm zones at all, and standing in the driveway telling
          // someone where to put their car IS the consent conversation.
          p_accepts_street: true,
        })
        if (error) return json(named(error), 409)

        // Extras sold with the space. Priced by the database, same as online.
        const addons = Array.isArray(body.addons) ? body.addons : []
        if (addons.length) {
          const { error: aErr } = await db.rpc('add_booking_addons', {
            p_booking_id: data,
            p_items: addons,
            p_channel: 'gate',
          })
          if (aErr) {
            // The space is sold and the car is being waved in; an extras
            // failure must not read as a failed sale. Say so and move on.
            console.error('gate addons failed', aErr)
            return json({ ok: true, booking_id: data, addons_failed: true })
          }
          // Handed over across the bonnet, there and then.
          await db.rpc('set_addons_handed_over', { p_booking_id: data, p_handed: true })
        }

        return json({ ok: true, booking_id: data })
      }

      // ------------------------------------------------ the night's levers

      // A space lost to a bad park, or found because a hatchback fitted where
      // an SUV would not. Always ±1 from the screen; the function picks which
      // bay so nobody has to think about bay labels in the rain.
      case 'adjust_capacity': {
        const zoneId = String(body.zone_id ?? '')
        const delta = Number(body.delta ?? 0)
        if (!eventId || !zoneId) return json({ error: 'event_id and zone_id are required' }, 400)
        if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10) {
          return json({ error: 'delta must be a whole number between -10 and 10' }, 400)
        }
        const { data, error } = await db.rpc('adjust_zone_capacity', {
          p_event_id: eventId,
          p_zone_id: zoneId,
          p_delta: delta,
          p_note: body.note ? String(body.note) : null,
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, capacity: data })
      }

      // The signage is a rack of swappable cards and it gets swapped. This is
      // how the database follows.
      case 'set_price': {
        const { data, error } = await db.rpc('set_tier_price', {
          p_event_id: eventId,
          p_property_id: String(body.property_id ?? ''),
          p_tier_code: String(body.tier_code ?? ''),
          p_price_cents: Number(body.price_cents ?? 0),
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, price_cents: data })
      }

      // "Standard's gone" — called by eye, ahead of the bay maths, and
      // reversible in one tap when a space comes back.
      case 'set_sold_out': {
        const { data, error } = await db.rpc('set_tier_sold_out', {
          p_event_id: eventId,
          p_property_id: String(body.property_id ?? ''),
          p_tier_code: String(body.tier_code ?? ''),
          p_sold_out: body.sold_out === true,
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, sold_out: data })
      }

      default:
        return json({ error: 'Unknown action' }, 400)
    }
  } catch (err) {
    console.error(action, err)
    return json({ error: (err as Error).message ?? 'Something went wrong' }, 500)
  }
})
