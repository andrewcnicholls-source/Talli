// =====================================================================
//  Talli Parking — gate operations
//
//  Everything the person on the driveway needs: the arrivals list, ticking
//  cars off as they turn in, handing over pre-purchased extras, selling a
//  space to someone who just rolled up, moving a booked car out to overflow,
//  keeping the night's capacity and prices honest as they move, and — new —
//  making the event itself: a template to start from, the details edited on
//  the phone, and the status moved from draft to on sale without a dashboard.
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

// Minutes either side of kickoff, as the modal sends them. An absent field
// falls back to the caller's default; an explicit null stays null, because
// "online sales never close" is a decision and not a missing value.
function minutes(v: unknown, fallback: number | null): number | null {
  if (v === null) return null
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

type Row = Record<string, any>

// Everything the gate screen draws, from one round trip. On a phone at the
// end of a driveway, one request that sometimes carries a little too much
// beats four that each might not arrive.
async function nightState(eventId: string) {
  const [listRes, capRes, tierRes, rateRes, chargeRes] = await Promise.all([
    db.from('v_gate_list').select('*').eq('event_id', eventId),
    db.from('v_night_capacity').select('*').eq('event_id', eventId)
      .order('exit_rank', { ascending: true }),
    db.from('v_tier_availability').select('*').eq('event_id', eventId)
      .order('sort_order', { ascending: true }),
    // The gate screen has to be able to say "charge them $46" before the sale
    // exists, so it needs the rate, not just the figure on a finished booking.
    db.from('payment_setting').select('card_surcharge_bps').maybeSingle(),
    // Straight from booking rather than through v_gate_list. Adding a column
    // to that view means restating all of it, and a restatement written
    // against one branch drops whatever another branch added. This join costs
    // one small query and cannot go stale.
    db.from('booking').select('id, surcharge_cents').eq('event_id', eventId),
  ])
  if (listRes.error) throw listRes.error
  if (capRes.error) throw capRes.error
  if (tierRes.error) throw tierRes.error
  if (chargeRes.error) throw chargeRes.error

  const surcharges = new Map<string, number>()
  for (const b of (chargeRes.data ?? []) as Row[]) {
    surcharges.set(String(b.id), b.surcharge_cents ?? 0)
  }

  // Not yet arrived first — that is the working list. Within each group,
  // earliest arrival window first.
  const rows = ((listRes.data ?? []) as Row[])
    .map((r: Row): Row => ({ ...r, surcharge_cents: surcharges.get(r.booking_id) ?? 0 }))
    .sort((a, b) => {
      if (a.arrived !== b.arrived) return a.arrived ? 1 : -1
      return String(a.arrival_from ?? '').localeCompare(String(b.arrival_from ?? ''))
    })

  const zones = capRes.data ?? []
  const paid = rows.filter((r: Row) => r.status === 'paid')
  // What the car is worth to the till: the space, the extras, and the card
  // surcharge if they paid by card. A cash sale carries no surcharge, so this
  // is still the sign price for everyone paying in notes.
  const value = (r: Row) =>
    (r.amount_cents ?? 0) + (r.addons_cents ?? 0) + (r.surcharge_cents ?? 0)

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
    card_surcharge_bps: rateRes.data?.card_surcharge_bps ?? 0,
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
      surcharge_cents: paid.reduce(
        (sum: number, r: Row) => sum + (r.surcharge_cents ?? 0), 0),
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
        const [{ data, error }, { data: rate }] = await Promise.all([
          db.from('v_tier_availability')
            .select('code, label, price_cents, spots_left_gate, manually_sold_out, property_id, sort_order')
            .eq('event_id', eventId)
            .order('sort_order', { ascending: true }),
          db.from('payment_setting').select('card_surcharge_bps').maybeSingle(),
        ])
        if (error) throw error
        return json({ tiers: data, card_surcharge_bps: rate?.card_surcharge_bps ?? 0 })
      }

      // --------------------------------------------- making a new event

      // Everything the "new event" modal needs to open, in one round trip:
      // the templates to choose from, and the properties an event can be
      // sold at. Neither list is long enough to be worth paging.
      case 'event_form': {
        const [tplRes, propRes] = await Promise.all([
          db.from('event_template')
            .select('id, name, event_name, venue, demand_tier, status, property_id, ' +
                    'gates_open_minutes, expected_end_minutes, online_close_minutes, tiers')
            .eq('active', true)
            .order('sort_order', { ascending: true }),
          db.from('property').select('id, name').eq('active', true)
            .order('name', { ascending: true }),
        ])
        if (tplRes.error) throw tplRes.error
        if (propRes.error) throw propRes.error

        const { data: fallback } = await db.rpc('default_event_property')
        return json({
          templates: tplRes.data ?? [],
          properties: propRes.data ?? [],
          default_property_id: fallback ?? null,
        })
      }

      // The date arrives as the wall clock someone typed plus the zone the
      // phone is in, never as an instant. A staging session run from another
      // timezone must not quietly book a 7:05pm kickoff for 7:05pm elsewhere.
      case 'create_event': {
        const { data, error } = await db.rpc('create_gate_event', {
          p_name: String(body.name ?? ''),
          p_starts_at_local: String(body.starts_at_local ?? ''),
          p_venue: body.venue ? String(body.venue) : 'Eden Park',
          p_status: String(body.status ?? 'draft'),
          p_demand_tier: String(body.demand_tier ?? 'standard'),
          p_property_id: body.property_id ? String(body.property_id) : null,
          p_gates_open_minutes: minutes(body.gates_open_minutes, -150),
          p_expected_end_minutes: minutes(body.expected_end_minutes, 150),
          // Null here is a decision, not a missing value: online sales never
          // close on their own and the gate keeps selling.
          p_online_close_minutes: minutes(body.online_close_minutes, null),
          p_tiers: Array.isArray(body.tiers) ? body.tiers : [],
          p_timezone: body.timezone ? String(body.timezone) : 'Pacific/Auckland',
        })
        if (error) return json(named(error), 409)

        const { data: made } = await db.from('event')
          .select('id, name, venue, starts_at, status')
          .eq('id', data)
          .maybeSingle()
        return json({ ok: true, event_id: data, event: made })
      }

      // The shape of a night, kept so it never has to be retyped. Saving
      // under a name that already exists replaces it rather than making a
      // second template nobody can tell apart.
      case 'save_template': {
        const { data, error } = await db.rpc('save_event_template', {
          p_name: String(body.template_name ?? ''),
          p_id: body.template_id ? String(body.template_id) : null,
          p_event_name: body.name ? String(body.name) : null,
          p_venue: body.venue ? String(body.venue) : 'Eden Park',
          p_status: String(body.status ?? 'draft'),
          p_demand_tier: String(body.demand_tier ?? 'standard'),
          p_property_id: body.property_id ? String(body.property_id) : null,
          p_gates_open_minutes: minutes(body.gates_open_minutes, -150),
          p_expected_end_minutes: minutes(body.expected_end_minutes, 150),
          p_online_close_minutes: minutes(body.online_close_minutes, null),
          p_tiers: Array.isArray(body.tiers) ? body.tiers : [],
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, template_id: data })
      }

      // Draft, announced, on sale, closed, cancelled. This is the lever that
      // decides whether the public site sells the night at all, so it belongs
      // on the phone next to everything else that moves during an event.
      case 'set_event_status': {
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        const { data, error } = await db.rpc('set_event_status', {
          p_event_id: eventId,
          p_status: String(body.status ?? ''),
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, status: data })
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

        // Hand back what the database settled on, so the confirmation the
        // marshal reads is the figure that was actually recorded — not the
        // one the screen worked out a moment before the sale.
        const { data: sold } = await db.from('booking')
          .select('amount_cents, addons_cents, surcharge_cents')
          .eq('id', data)
          .maybeSingle()

        return json({
          ok: true,
          booking_id: data,
          charge_cents: sold
            ? (sold.amount_cents ?? 0) + (sold.addons_cents ?? 0) + (sold.surcharge_cents ?? 0)
            : null,
        })
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

      // The whole sign at once. What actually moves a Talli price is what
      // the council has done to the roads, and that is one decision for the
      // night, not three — so the templates are named for the road state and
      // this sets every tier from the one that was picked.
      case 'apply_price_template': {
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        const { data, error } = await db.rpc('apply_price_template', {
          p_event_id: eventId,
          p_template_id: String(body.template_id ?? ''),
          // Every property selling this night. The gate screen never
          // mentions properties, so it must not have to name one here.
          p_property_id: body.property_id ? String(body.property_id) : null,
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, applied: data })
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
