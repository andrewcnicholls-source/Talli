// =====================================================================
//  Talli Parking — gate operations
//
//  Everything the person on the driveway needs: the arrivals list, ticking
//  cars off as they turn in, handing over pre-purchased extras, selling a
//  space to someone who just rolled up, moving a booked car out to overflow,
//  keeping the night's capacity and prices honest as they move, sending a
//  car to another address altogether, and calling a booking off.
//
//  All of it writes, so all of it runs under the service role here rather
//  than being exposed through RLS.
//
//  Access is a shared passphrase held in the GATE_PASSPHRASE secret. That is
//  a deliberate MVP choice for a single operator with a phone in the rain —
//  no login flow, no email round-trip. It is checked in constant time, and
//  the function refuses to run at all if the secret is unset, so there is no
//  quiet default-open state.
//
//  Two things are held to a higher bar than the rest, because they are the
//  only ones that cannot be undone by tapping again: cancelling a booking,
//  and sending money back. Both demand the passphrase a SECOND time, typed
//  right then, on top of an explicit confirmation. An unlocked phone in
//  somebody else's hand is not enough to lose a customer their space.
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

// Money leaving the account, one call, once. The idempotency key is built
// from the booking and what is being done to it, so a double tap in a bad
// signal spot cannot pay somebody twice.
async function refundOnCard(
  paymentIntentId: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<string> {
  const key = Deno.env.get('STRIPE_SECRET_KEY')
  if (!key) throw new Error('NO_STRIPE_KEY: card refunds are not configured')

  const form = new URLSearchParams({
    payment_intent: paymentIntentId,
    amount: String(amountCents),
  })

  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: form,
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error('STRIPE_REFUSED: ' + (data?.error?.message ?? 'the refund did not go through'))
  }
  return String(data.id)
}

// Everything the gate screen draws, from one round trip. On a phone at the
// end of a driveway, one request that sometimes carries a little too much
// beats four that each might not arrive.
async function nightState(eventId: string) {
  const [listRes, capRes, tierRes, siteRes] = await Promise.all([
    db.from('v_gate_list').select('*').eq('event_id', eventId),
    db.from('v_night_capacity').select('*').eq('event_id', eventId)
      .order('exit_rank', { ascending: true }),
    db.from('v_tier_availability').select('*').eq('event_id', eventId)
      .order('sort_order', { ascending: true }),
    db.from('v_overflow_site_status').select('*').eq('event_id', eventId)
      .order('sort_order', { ascending: true }),
  ])
  if (listRes.error) throw listRes.error
  if (capRes.error) throw capRes.error
  if (tierRes.error) throw tierRes.error
  if (siteRes.error) throw siteRes.error

  // Not yet arrived first — that is the working list. Within each group,
  // earliest arrival window first.
  const rows = (listRes.data ?? []).sort((a, b) => {
    if (a.arrived !== b.arrived) return a.arrived ? 1 : -1
    return String(a.arrival_from ?? '').localeCompare(String(b.arrival_from ?? ''))
  })

  const zones = capRes.data ?? []
  const sites = siteRes.data ?? []

  // A car sent to somebody else's driveway is off the working list — it is
  // not going to turn in, and its bay is back on sale — but the money is
  // still ours unless it was handed back.
  const here = rows.filter((r: Row) => r.status !== 'transferred')
  const sent = rows.filter((r: Row) => r.status === 'transferred')
  const paid = rows.filter((r: Row) => r.status === 'paid' || r.status === 'transferred')
  const value = (r: Row) => (r.amount_cents ?? 0) + (r.addons_cents ?? 0) -
    (r.transfer_refund_cents ?? 0)

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
    sites,
    extras: [...extras.values()].sort((a, b) => a.name.localeCompare(b.name)),
    summary: {
      total: here.length,
      arrived: here.filter((r: Row) => r.arrived).length,
      unpaid_holds: here.filter((r: Row) => r.status === 'held').length,
      // Spaces, not bookings. A valet car and a berm car both take one.
      capacity,
      filled,
      free: capacity - filled,
      lost: zones.reduce((n: number, z: Row) => n + z.lost, 0),
      opened: zones.reduce((n: number, z: Row) => n + z.opened, 0),
      // Sent elsewhere, and what the introductions are worth.
      transferred: sent.length,
      overflow_spots_left: sites
        .filter((s: Row) => s.open)
        .reduce((n: number, s: Row) => n + s.spots_left, 0),
      referral_cents: sites.reduce((n: number, s: Row) => n + (s.referral_cents ?? 0), 0),
      refunded_cents: sites.reduce((n: number, s: Row) => n + (s.refunded_cents ?? 0), 0),
      cash_due_cents: here
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

  const expected = Deno.env.get('GATE_PASSPHRASE')
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

  // The second gate, for the two things that cannot be tapped back: losing
  // somebody their space, and sending money out. The passphrase has to be
  // typed again on the confirmation screen, and the screen has to say out
  // loud that it means it.
  const reauthorised = () =>
    body.confirm === true &&
    sameSecret(String(body.confirm_passphrase ?? ''), expected)

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
      //
      // Note this is OUR grass. Handing the car to another address is a
      // transfer, below, and that is a different promise entirely.
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

      // -------------------------------------------------- overflow areas

      // The destinations and what each will take tonight.
      case 'overflow_sites': {
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        const { data, error } = await db
          .from('v_overflow_site_status')
          .select('*')
          .eq('event_id', eventId)
          .order('sort_order', { ascending: true })
        if (error) throw error
        return json({ sites: data })
      }

      // Tonight's limit for one destination, and whether it is taking cars
      // at all. Separate from the standing arrangement, which does not move
      // because somebody had people over on a Saturday.
      case 'set_overflow_limit': {
        const siteId = String(body.site_id ?? '')
        if (!eventId || !siteId) {
          return json({ error: 'event_id and site_id are required' }, 400)
        }
        const spots = body.spots == null ? null : Number(body.spots)
        if (spots != null && (!Number.isInteger(spots) || spots < 0 || spots > 200)) {
          return json({ error: 'spots must be a whole number between 0 and 200' }, 400)
        }
        const { data, error } = await db.rpc('set_event_overflow_limit', {
          p_event_id: eventId,
          p_site_id: siteId,
          p_spots: spots,
          p_open: body.open == null ? null : body.open === true,
          p_note: body.note ? String(body.note) : null,
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, spots: data })
      }

      // Hand the car to another address. The bay here goes back on sale, the
      // introduction is booked, and — where the destination takes the money
      // at their own gate — what was paid here goes back.
      //
      // The customer has to have said yes to THIS, just now. Whatever they
      // ticked when booking was about our overflow, not somebody else's
      // driveway, so consent is asked for again and recorded separately.
      case 'transfer': {
        const id = String(body.booking_id ?? '')
        const siteId = String(body.site_id ?? '')
        if (!id || !siteId) {
          return json({ error: 'booking_id and site_id are required' }, 400)
        }
        if (body.confirmed_consent !== true) {
          return json({
            error: 'Nobody has agreed to this move yet.',
            code: 'CONSENT_REQUIRED',
          }, 400)
        }

        const { data: booking, error: bErr } = await db
          .from('booking')
          .select('id, status, amount_cents, addons_cents, payment_method, stripe_payment_intent_id')
          .eq('id', id)
          .maybeSingle()
        if (bErr) throw bErr
        if (!booking) return json({ error: 'No such booking' }, 404)

        const paidCents = (booking.amount_cents ?? 0) + (booking.addons_cents ?? 0)
        const wantsRefund = body.refund === true
        const refundCents = wantsRefund
          ? Math.min(Number(body.refund_cents ?? paidCents), paidCents)
          : 0

        // Money going out is held to the same bar as a cancellation.
        if (refundCents > 0 && !reauthorised()) {
          return json({
            error: 'Refunding needs the passphrase again.',
            code: 'REAUTH_REQUIRED',
          }, 401)
        }

        let refundId: string | null = null
        if (refundCents > 0) {
          if (booking.payment_method === 'stripe' && booking.stripe_payment_intent_id) {
            try {
              refundId = await refundOnCard(
                booking.stripe_payment_intent_id,
                refundCents,
                `transfer:${id}:${refundCents}`,
              )
            } catch (err) {
              return json(named(err as Error), 409)
            }
          }
          // Anything paid in cash or by transfer is handed back by hand. The
          // row records that it is owed; nothing here can move that money.
        }

        const { error: tErr } = await db.rpc('transfer_booking_to_site', {
          p_booking_id: id,
          p_site_id: siteId,
          p_reason: body.reason ? String(body.reason) : null,
          p_refund_cents: refundCents,
          p_consent_confirmed: true,
          p_stripe_refund_id: refundId,
        })
        if (tErr) {
          // A refund that went through against a transfer that did not is
          // worth shouting about — the money is gone and the booking still
          // stands. Retrying is safe; the idempotency key holds.
          if (refundId) console.error('refund landed but transfer failed', id, refundId)
          return json({ ...named(tErr), refund_id: refundId }, 409)
        }

        const { data: site } = await db
          .from('v_overflow_site_status')
          .select('name, spots_left, referral_fee_cents')
          .eq('event_id', eventId)
          .eq('site_id', siteId)
          .maybeSingle()

        return json({
          ok: true,
          site: site?.name ?? 'overflow',
          spots_left: site?.spots_left ?? null,
          refunded_cents: refundCents,
          refund_by_hand: refundCents > 0 && !refundId,
          refund_id: refundId,
        })
      }

      // They came back, or the neighbour waved them off. Puts the car back
      // in the yard if there is anywhere left to put it. Money already
      // handed back stays handed back — that is a separate conversation.
      case 'undo_transfer': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)

        const { data, error } = await db.rpc('undo_booking_transfer', { p_booking_id: id })
        if (error) return json(named(error), 409)

        let bayLabel: string | null = null
        if (data) {
          const { data: bay } = await db
            .from('bay').select('label').eq('id', data).maybeSingle()
          bayLabel = bay?.label ?? null
        }
        return json({ ok: true, bay_label: bayLabel, unplaced: !data })
      }

      // ------------------------------------------------------- cancelling

      // The one action that takes a space away from somebody who paid for
      // it. Passphrase again, an explicit confirm, and a row in
      // booking_cancellation for every single one.
      case 'cancel_booking': {
        const id = String(body.booking_id ?? '')
        if (!id) return json({ error: 'booking_id is required' }, 400)

        if (!reauthorised()) {
          return json({
            error: 'Cancelling needs the passphrase again.',
            code: 'REAUTH_REQUIRED',
          }, 401)
        }

        const { data: booking, error: bErr } = await db
          .from('booking')
          .select('id, status, amount_cents, addons_cents, payment_method, stripe_payment_intent_id, vehicle_rego')
          .eq('id', id)
          .maybeSingle()
        if (bErr) throw bErr
        if (!booking) return json({ error: 'No such booking' }, 404)

        const paidCents = (booking.amount_cents ?? 0) + (booking.addons_cents ?? 0)
        const wantsRefund = body.refund === true
        const refundCents = wantsRefund
          ? Math.min(Number(body.refund_cents ?? paidCents), paidCents)
          : 0

        let refundId: string | null = null
        let refundMethod = 'none'

        if (refundCents > 0) {
          if (booking.payment_method === 'stripe' && booking.stripe_payment_intent_id) {
            try {
              refundId = await refundOnCard(
                booking.stripe_payment_intent_id,
                refundCents,
                `cancel:${id}:${refundCents}`,
              )
              refundMethod = 'stripe'
            } catch (err) {
              return json(named(err as Error), 409)
            }
          } else {
            // Cash and bank transfers are handed back by hand. Recording it
            // is the whole of what this can do.
            refundMethod = booking.payment_method === 'bank_transfer' ? 'bank_transfer' : 'cash'
          }
        }

        const { data, error } = await db.rpc('cancel_booking_admin', {
          p_booking_id: id,
          p_reason: body.reason ? String(body.reason) : null,
          p_refund_cents: refundCents,
          p_refund_method: refundMethod,
          p_stripe_refund_id: refundId,
          p_note: body.note ? String(body.note) : null,
        })
        if (error) {
          if (refundId) console.error('refund landed but cancel failed', id, refundId)
          return json({ ...named(error), refund_id: refundId }, 409)
        }

        return json({
          ok: true,
          status: data,
          refunded_cents: refundCents,
          refund_by_hand: refundCents > 0 && !refundId,
          refund_id: refundId,
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
