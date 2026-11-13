// gate-ops: the whole night in one read, for the gate screen.

import { db, isGateAddress, type Row } from './shared.ts'

// Everything the gate screen draws, from one round trip. On a phone at the
// end of a driveway, one request that sometimes carries a little too much
// beats four that each might not arrive.
export async function nightState(eventId: string, allowed: Set<string> | null = null) {
  const [listRes, tierRes, rateRes, chargeRes, siteRes, refRes, lostRes] = await Promise.all([
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
              'property_id, booked_property_id, checked_in_by, cash_collected_by, space_code')
      .eq('event_id', eventId),
    // The driveways selling this night, with their block, so the screen can
    // offer "I'm at …" and say which site each car is at.
    db.from('event_offer')
      .select('property_id, status, property:property_id(name, address, lat, lng, site_guide_url, ' +
              'fill_notes, block_id, block:block_id(name, sort_order, anchor_property_id))')
      .eq('event_id', eventId),
    // The one site a price is set on (plan B1); every other follows it.
    db.rpc('reference_property'),
    // Spaces lost tonight and not undone (plan B5), each with its Undo.
    db.from('lost_space')
      .select('id, property_id, tier_code, reason, note, recorded_at')
      .eq('event_id', eventId).is('undone_at', null)
      .order('recorded_at', { ascending: true }),
  ])
  if (listRes.error) throw listRes.error
  const ref = refRes.data ? String(refRes.data) : null
  if (siteRes.error) throw siteRes.error
  if (tierRes.error) throw tierRes.error
  if (chargeRes.error) throw chargeRes.error
  if (lostRes.error) throw lostRes.error

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
      // The type of space the car is in, when not the type it was sold
      // as: a Standard car in a Priority space (plan B5).
      space_code: b.space_code ?? null,
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

  // A walk-up form whose Standard is full is not a closed one (plan B5):
  // the sale goes where the database would put it — Standard elsewhere in
  // the block, then a Priority space here, then elsewhere. Asked for each
  // full Standard so the form can say where before the warden sells.
  await Promise.all(tiers
    .filter((t: Row) => t.code === 'standard' && !t.manually_sold_out && (t.spots_left_gate ?? 0) <= 0)
    .map(async (t: Row) => {
      const { data, error } = await db.rpc('propose_space', {
        p_event_id: eventId, p_property_id: t.property_id, p_tier_code: 'standard',
        p_booking_id: null, p_selling: true,
      })
      if (error) throw error
      const to = ((data ?? []) as Row[])[0]
      t.spill = to ? { property_id: to.property_id, space_code: to.space_code } : null
    }))

  const lost = ((lostRes.data ?? []) as Row[])
    .filter((l: Row) => allowed === null || allowed.has(String(l.property_id)))
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
      is_reference: ref !== null && String(o.property_id) === ref,
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
  // A lost space is not free and not filled: its own line (plan B5).
  const lostCount = tiers.reduce((n: number, t: Row) => n + (t.lost ?? 0), 0)

  return {
    rows,
    tiers,
    sites,
    lost,
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
      lost: lostCount,
      free: Math.max(0, capacity - filled - lostCount),
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
