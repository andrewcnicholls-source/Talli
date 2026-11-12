// gate-ops: the whole night in one read, for the gate screen.

import { db, isGateAddress, type Row } from './shared.ts'

// Everything the gate screen draws, from one round trip. On a phone at the
// end of a driveway, one request that sometimes carries a little too much
// beats four that each might not arrive.
export async function nightState(eventId: string, allowed: Set<string> | null = null) {
  const [listRes, tierRes, rateRes, chargeRes, siteRes] = await Promise.all([
    db.from('v_gate_list').select('*').eq('event_id', eventId),
    db.from('v_tier_availability').select('*').eq('event_id', eventId)
      .order('sort_order', { ascending: true }),
    // The gate screen has to be able to say "charge them $46" before the sale
    // exists, so it needs the rate, not just the figure on a finished booking.
    db.from('payment_setting').select('card_surcharge_bps').maybeSingle(),
    // The per-booking fields v_gate_list does not carry, taken straight from
    // booking. Adding a column to that view means restating all of it, and a
    // restatement written against one branch drops whatever another branch
    // added. This join costs one small query and cannot go stale.
    db.from('booking')
      .select('id, surcharge_cents, vehicle_low_clearance, customer_email, hold_expires_at, ' +
              'property_id, booked_property_id, checked_in_by, cash_collected_by')
      .eq('event_id', eventId),
    // The driveways selling this night, with their block, so the screen can
    // offer "I'm at …" and say which site each car is at.
    db.from('event_offer')
      .select('property_id, status, property:property_id(name, address, lat, lng, site_guide_url, ' +
              'fill_notes, block_id, block:block_id(name, sort_order, anchor_property_id))')
      .eq('event_id', eventId),
  ])
  if (listRes.error) throw listRes.error
  if (siteRes.error) throw siteRes.error
  if (tierRes.error) throw tierRes.error
  if (chargeRes.error) throw chargeRes.error

  const surcharges = new Map<string, number>()
  const lowCars = new Set<string>()
  const emails = new Map<string, string>()
  const onTheClock = new Set<string>()
  const where = new Map<string, Row>()
  for (const b of (chargeRes.data ?? []) as Row[]) {
    where.set(String(b.id), {
      property_id: b.property_id,
      booked_property_id: b.booked_property_id,
      checked_in_by: b.checked_in_by,
      cash_collected_by: b.cash_collected_by,
    })
    surcharges.set(String(b.id), b.surcharge_cents ?? 0)
    if (b.vehicle_low_clearance) lowCars.add(String(b.id))
    // A walk-up with no email is given a made-up one so the column can stay
    // not-null. That is not an address anyone should be shown, or edit.
    if (b.customer_email && !isGateAddress(b.customer_email)) {
      emails.set(String(b.id), b.customer_email)
    }
    if (b.hold_expires_at) onTheClock.add(String(b.id))
  }

  // Not yet arrived first — that is the working list. Within each group,
  // earliest arrival window first.
  const rows = ((listRes.data ?? []) as Row[])
    .map((r: Row): Row => ({
      ...r,
      surcharge_cents: surcharges.get(r.booking_id) ?? 0,
      vehicle_low_clearance: lowCars.has(String(r.booking_id)),
      customer_email: emails.get(String(r.booking_id)) ?? null,
      // Two kinds of unpaid, and they mean different things. A hold with a
      // clock on it is somebody mid-checkout on the website; a walk-up saved
      // as "pay later" is a car in the yard that still owes money.
      ...(where.get(String(r.booking_id)) ?? {}),
      // The short code in the confirmation email, for searching at the gate.
      reference: String(r.booking_id).slice(0, 8).toUpperCase(),
      owes: r.status === 'held' && r.payment_method === 'unpaid',
      in_checkout: r.status === 'held' && onTheClock.has(String(r.booking_id)),
    }))
    // A warden sees the cars booked at, or parked at, their own sites.
    .filter((r: Row) => allowed === null ||
      allowed.has(String(r.property_id)) ||
      (r.booked_property_id && allowed.has(String(r.booked_property_id))))
    .sort((a, b) => {
      if (a.arrived !== b.arrived) return a.arrived ? 1 : -1
      return String(a.arrival_from ?? '').localeCompare(String(b.arrival_from ?? ''))
    })

  const tiers = ((tierRes.data ?? []) as Row[])
    .filter((t: Row) => allowed === null || allowed.has(String(t.property_id)))
  const sites = ((siteRes.data ?? []) as Row[])
    .filter((o: Row) => allowed === null || allowed.has(String(o.property_id)))
    .map((o: Row) => ({
      property_id: o.property_id,
      status: o.status,
      name: o.property?.name ?? null,
      address: o.property?.address ?? null,
      lat: o.property?.lat ?? null,
      lng: o.property?.lng ?? null,
      site_guide_url: o.property?.site_guide_url ?? null,
      fill_notes: o.property?.fill_notes ?? null,
      block_id: o.property?.block_id ?? null,
      block_name: o.property?.block?.name ?? null,
      is_anchor: o.property?.block?.anchor_property_id === o.property_id,
      block_sort: o.property?.block?.sort_order ?? 0,
    }))
    .sort((a: Row, b: Row) =>
      (a.block_sort - b.block_sort) ||
      String(a.block_name ?? '').localeCompare(String(b.block_name ?? '')) ||
      (Number(b.is_anchor) - Number(a.is_anchor)) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')))
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

  // The night's total is the three tier counts added up. It used to be the
  // bays in the yard; it is now the number Andrew set for each type, which
  // is the same figure he is looking at on the card above it.
  const capacity = tiers.reduce((n: number, t: Row) => n + (t.capacity ?? 0), 0)
  const filled = tiers.reduce((n: number, t: Row) => n + (t.sold ?? 0), 0)

  return {
    rows,
    tiers,
    sites,
    card_surcharge_bps: rateRes.data?.card_surcharge_bps ?? 0,
    extras: [...extras.values()].sort((a, b) => a.name.localeCompare(b.name)),
    summary: {
      total: rows.length,
      arrived: rows.filter((r: Row) => r.arrived).length,
      unpaid_holds: rows.filter((r: Row) => r.in_checkout).length,
      owing: rows.filter((r: Row) => r.owes).length,
      owing_cents: rows.filter((r: Row) => r.owes)
        .reduce((sum: number, r: Row) => sum + value(r), 0),
      // Spaces, not bookings. A valet car and a standard car both take one.
      capacity,
      filled,
      free: capacity - filled,
      cash_due_cents: rows
        .filter((r: Row) => r.payment_method !== 'stripe' && r.payment_method !== 'unpaid' &&
          !r.arrived)
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
