// gate-ops actions for working the gate: opening the screen, the list,
// check-in, extras, walk-up sales, fixing a booking, and card by QR.
// A warden may call these, for their own blocks.

import type Stripe from 'https://esm.sh/stripe@18?target=denonext'
import { type Ctx, type Handler } from '../auth.ts'
import { CARD_LINK_MINUTES, db, EVENT_FIELDS, isGateAddress, json, named, optText, PAY_METHODS, priceCents, type Row, SITE_URL, stripeOrNull, TAP_REFUSED } from '../shared.ts'
import { nightState } from '../night.ts'

// The nights a caller is shown. The operator sees every one; a warden
// sees the live night and nothing else (plan B2), because it is the only
// one they could work.
async function eventsFor({ caller, live }: Ctx) {
  if (!caller.all) return live ? [live] : []
  const { data, error } = await db
    .from('event')
    .select(EVENT_FIELDS)
    .order('starts_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

// Whether a caller holds every active block (plan B6), which is when the
// gate screen offers them "all sites". The operator always does. A warden
// with one block switched off does not — their "all" would be a block
// short, and a total that silently leaves a block out is worse than none.
async function holdsEveryBlock(caller: Ctx['caller']): Promise<boolean> {
  if (caller.all) return true
  const { data, error } = await db.from('block').select('id').eq('active', true)
  if (error) throw error
  const mine = new Set(caller.blocks)
  const every = ((data ?? []) as Row[]).map((b) => String(b.id))
  return every.length > 0 && every.every((id) => mine.has(id))
}

export const arrivals: Record<string, Handler> = {
  // What the screen needs to open: who it just let in, and the list to
  // pick from. One round trip, because the alternative is a screen that
  // can be signed in and empty at the same time.
  //
  // `events` is deliberately not filtered by host yet. There is one
  // real host, and a filter written against a second host who does not
  // exist is a filter nobody can prove is right. The identity is in the
  // request now, which is the part that had to come first — `who.hosts`
  // is what the filter will read when it is wanted.
  async session(ctx: Ctx) {
    const { caller, live } = ctx
    return json({
      who: {
        email: caller.email,
        hosts: caller.hosts,
        host_name: caller.hosts[0].host_name,
        role: caller.hosts[0].role,
        // false for a warden: the screen hides Tonight and Insights.
        operator: caller.all,
        blocks: caller.blocks,
        // Whether the selector may offer "all sites" (plan B6): Andrew,
        // or a warden who holds every block there is. Display only — what
        // each request may see is still decided from the grants.
        every_block: await holdsEveryBlock(caller),
      },
      events: await eventsFor(ctx),
      // The night Arrivals works (plan B2), or null.
      live_event_id: live ? String(live.id) : null,
    })
  },

  // Every event, not just the ones on sale — the gate needs drafts,
  // announced fixtures and closed ones too. A warden gets the live one.
  async events(ctx: Ctx) {
    return json({
      events: await eventsFor(ctx),
      live_event_id: ctx.live ? String(ctx.live.id) : null,
    })
  },

  // event_id in the answer is the night this list is for. For Arrivals
  // that is the live one, resolved in index.ts, so a phone that asked with
  // none learns here when Andrew has moved the gate on to another.
  async list({ eventId, allowed, live }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    return json({
      event_id: eventId,
      live_event_id: live ? String(live.id) : null,
      ...(await nightState(eventId, allowed)),
    })
  },

  // What is still sellable right now, for the walk-up form.
  async tiers({ eventId, allowed }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const [{ data, error }, { data: rate }] = await Promise.all([
      db.from('v_tier_availability')
        .select('code, label, price_cents, spots_left_gate, manually_sold_out, property_id, sort_order')
        .eq('event_id', eventId)
        .order('sort_order', { ascending: true }),
      db.from('payment_setting').select('card_surcharge_bps').maybeSingle(),
    ])
    if (error) throw error
    const mine = ((data ?? []) as Row[])
      .filter((t: Row) => allowed === null || allowed.has(String(t.property_id)))
    return json({ tiers: mine, card_surcharge_bps: rate?.card_surcharge_bps ?? 0 })
  },

  // Ticking a car in records that it turned up, and where it went.
  //
  // With several driveways in a block, the warden says which one they are
  // standing at, and the database places the car (plan B5): a Standard
  // space here, then elsewhere in the block, then a Priority space here,
  // then elsewhere. Never Valet. `placed` says where it went, and
  // `no_room` when there was nowhere and it stayed counted where it was.
  // That site is what the host is paid on.
  async check_in({ caller, body, allowed, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const id = String(body.booking_id)
    const site = body.property_id ? String(body.property_id) : null
    if (site && allowed !== null && !allowed.has(site)) {
      return json({ error: 'That site is not one of yours.', code: 'NOT_YOUR_SITE' }, 403)
    }
    if (!site) {
      const { error } = await db.rpc('check_in_booking_at', {
        p_booking_id: id, p_property_id: null, p_by: caller.me,
      })
      if (error) return json(named(error), 409)
      return json({ ok: true })
    }
    const { data, error } = await db.rpc('check_in_placed', {
      p_booking_id: id,
      p_property_id: site,
      p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, placed: data })
  },

  // The warden overriding where a car went: another site in the block, or
  // a Standard car into a Priority space. The database refuses a space
  // that is not free, so Priority is never past its count.
  async place({ caller, body, allowed, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const site = String(body.property_id ?? '')
    if (!site) return json({ error: 'Which site?' }, 400)
    if (allowed !== null && !allowed.has(site)) {
      return json({ error: 'That site is not one of yours.', code: 'NOT_YOUR_SITE' }, 403)
    }
    const { data, error } = await db.rpc('place_booking', {
      p_booking_id: String(body.booking_id),
      p_property_id: site,
      p_space_code: body.space_code ? String(body.space_code) : null,
      p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, placed: data })
  },

  // ---------------------------------------------------- lost spaces

  // A space that cannot be used tonight: a car across two, a blocked
  // driveway, the host's own car (plan B5). Not a booking and no money.
  // It comes off availability everywhere — the booking page included —
  // until it is undone. The live night only, and a warden's own sites.
  async lose_space({ caller, body, eventId, allowed }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const site = String(body.property_id ?? '')
    if (!site) return json({ error: 'Which site?' }, 400)
    if (allowed !== null && !allowed.has(site)) {
      return json({ error: 'That site is not one of yours.', code: 'NOT_YOUR_SITE' }, 403)
    }
    const { data, error } = await db.rpc('record_lost_space', {
      p_event_id: eventId,
      p_property_id: site,
      p_tier_code: String(body.tier_code ?? ''),
      p_reason: String(body.reason ?? ''),
      p_note: optText(body.note),
      p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, id: data })
  },

  async undo_lost_space({ caller, body, allowed, live }: Ctx) {
    const id = String(body.id ?? '')
    if (!id) return json({ error: 'id is required' }, 400)
    const { data: row, error: rErr } = await db.from('lost_space')
      .select('event_id, property_id').eq('id', id).maybeSingle()
    if (rErr) throw rErr
    // The same rule as a booking: a warden's own sites, on the live night.
    if (!row || (allowed !== null &&
        (!allowed.has(String(row.property_id)) || !live || String(live.id) !== String(row.event_id)))) {
      return json({ error: 'That is not at one of your sites tonight.', code: 'NOT_YOUR_SITE' }, 403)
    }
    const { error } = await db.rpc('undo_lost_space', { p_id: id, p_by: caller.me })
    if (error) return json(named(error), 409)
    return json({ ok: true })
  },

  // Mis-taps happen, and happen most when it is busy.
  async undo_check_in({ body, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const id = String(body.booking_id)
    const { error } = await db
      .from('booking')
      .update({ checked_in_at: null, checked_in_by: null })
      .eq('id', id)
    if (error) throw error
    return json({ ok: true })
  },

  // One tap covers the whole bag. Nobody hands over a poncho and an
  // earplug pair as two separate transactions.
  async hand_over({ body, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const id = String(body.booking_id)
    const { data, error } = await db.rpc('set_addons_handed_over', {
      p_booking_id: id,
      p_handed: body.handed !== false,
    })
    if (error) throw error
    return json({ ok: true, lines: data })
  },

  async sell({ caller, body, eventId, allowed }: Ctx) {
    // A price for this one car, when the deal at the window was not the
    // sign. Sent only when set, so an ordinary sale makes the same call
    // it always has.
    const price = priceCents(body.price_cents)
    if (price === false) {
      return json({ error: 'A price between $1 and $500, please.', code: 'BAD_PRICE' }, 400)
    }
    const sellAt = String(body.property_id ?? '')
    if (allowed !== null && !allowed.has(sellAt)) {
      return json({ error: 'That site is not one of yours.', code: 'NOT_YOUR_SITE' }, 403)
    }
    if (!String(body.vehicle_rego ?? '').trim()) {
      return json({ error: 'Number plate first, please.', code: 'PLATE_REQUIRED' }, 400)
    }
    if (!caller.all && body.payment_method === 'tap_to_pay') {
      return json(TAP_REFUSED, 403)
    }
    const { data, error } = await db.rpc('sell_at_gate', {
      ...(price !== null ? { p_price_cents: price } : {}),
      p_event_id: eventId,
      p_property_id: String(body.property_id ?? ''),
      p_tier_code: String(body.tier_code ?? ''),
      p_payment_method: String(body.payment_method ?? 'cash'),
      p_rego: body.vehicle_rego ? String(body.vehicle_rego).toUpperCase() : null,
      p_name: body.name ? String(body.name) : null,
      p_phone: body.phone ? String(body.phone) : null,
      p_email: body.email ? String(body.email) : null,
      // Always true at the gate. It no longer decides anything about the
      // sale — nothing is refused for want of consent any more — but it
      // is still the honest record: standing in the driveway telling
      // someone where to put their car IS the conversation.
      p_accepts_street: true,
      // Ticked on the walk-up form when the car in front of you is
      // obviously sitting low. Recorded so it survives the night.
      p_low_clearance: body.vehicle_low_clearance === true,
    })
    if (error) return json(named(error), 409)

    // Who waved it in, and who is holding the cash for it.
    const method = String(body.payment_method ?? 'cash')
    await db.from('booking').update({
      checked_in_by: caller.me,
      cash_collected_by: method === 'cash' ? caller.me : null,
    }).eq('id', data)

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
      .select('amount_cents, addons_cents, surcharge_cents, property_id, tier_code, space_code')
      .eq('id', data)
      .maybeSingle()

    return json({
      ok: true,
      booking_id: data,
      // Where it went: a Standard sale past its count is in a Priority
      // space, perhaps at another site in the block (plan B5).
      placed: sold
        ? { property_id: sold.property_id, tier_code: sold.tier_code,
            space_code: sold.space_code ?? sold.tier_code }
        : null,
      charge_cents: sold
        ? (sold.amount_cents ?? 0) + (sold.addons_cents ?? 0) + (sold.surcharge_cents ?? 0)
        : null,
    })
  },

  // ------------------------------------------------ fixing a booking

  // Tap a row, change what was wrong. Details, how they paid, and which
  // type of space they are counted against, in one transaction — so a
  // valet customer who ended up in Priority frees the valet space and
  // takes a Priority one, with what they paid left exactly as it was.
  async edit_booking({ caller, body, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const id = String(body.booking_id)
    const method = optText(body.payment_method)
    if (method !== null && !PAY_METHODS.includes(method)) {
      return json({ error: 'That is not a way to pay at the gate.' }, 400)
    }
    // A booking Andrew already took by tap to pay can still be fixed by a
    // warden (a plate, a phone number) without its method changing. What
    // a warden cannot do is move one onto tap to pay.
    if (!caller.all && method === 'tap_to_pay') {
      const { data: was } = await db.from('booking')
        .select('payment_method').eq('id', id).maybeSingle()
      if (was?.payment_method !== 'tap_to_pay') return json(TAP_REFUSED, 403)
    }
    const low = body.vehicle_low_clearance
    const { data, error } = await db.rpc('edit_booking_at_gate', {
      p_booking_id: id,
      p_name: optText(body.name),
      p_phone: optText(body.phone),
      p_email: optText(body.email),
      p_rego: optText(body.vehicle_rego),
      p_low_clearance: typeof low === 'boolean' ? low : null,
      p_notes: optText(body.notes),
      p_payment_method: method,
      p_tier_code: body.tier_code ? String(body.tier_code) : null,
    })
    if (error) return json(named(error), 409)

    // What they paid for the space, last — so it wins over the re-price
    // an unpaid booking gets when it moves type. Its own call: the
    // edits above are already saved if this one is refused.
    const price = priceCents(body.price_cents)
    if (price === false) {
      return json({ error: 'Saved, but the price was not: between $1 and $500, please.',
        code: 'BAD_PRICE' }, 400)
    }
    if (price !== null) {
      const { error: pErr } = await db.rpc('set_booking_price_at_gate', {
        p_booking_id: id,
        p_price_cents: price,
      })
      if (pErr) {
        const out = named(pErr)
        return json({ ...out, error: 'Saved, but the price was not: ' + out.error }, 409)
      }
      const { data: now } = await db.from('booking')
        .select('amount_cents, addons_cents, surcharge_cents')
        .eq('id', id).maybeSingle()
      return json({ ok: true, booking: { ...data, ...(now ?? {}) } })
    }
    return json({ ok: true, booking: data })
  },

  // A "pay later" walk-up who drove off, or was never really there.
  async cancel_unpaid({ body, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const id = String(body.booking_id)
    const { error } = await db.rpc('cancel_unpaid_gate_booking', { p_booking_id: id })
    if (error) return json(named(error), 409)
    return json({ ok: true })
  },

  // A Stripe link for a walk-up who owes, shown on the screen as a QR.
  // Owing means the pay-later state: held, no hold clock. The amount is
  // the booking's own space and extras plus the card surcharge, worked
  // out here from the database; nothing from the request is an amount.
  // An open link for the same amount is handed back again rather than
  // made twice. One for a different amount is expired first, so the
  // driver can never pay an old figure as well as the new one.
  async card_link({ body, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const id = String(body.booking_id)
    const stripe = stripeOrNull()
    if (!stripe) {
      return json({ error: 'Card payments are not set up on this project.',
        code: 'NO_STRIPE' }, 503)
    }
    const { data: bk, error: bErr } = await db.from('booking')
      .select('id, status, channel, payment_method, hold_expires_at, amount_cents, ' +
              'addons_cents, currency, customer_email, vehicle_rego, tier_code, ' +
              'event_id, property_id, stripe_checkout_session_id')
      .eq('id', id).maybeSingle()
    if (bErr) throw bErr
    const b = bk as Row | null
    if (!b || b.channel !== 'gate' || b.status !== 'held' ||
        b.payment_method !== 'unpaid' || b.hold_expires_at) {
      return json({ error: 'Only a walk-up who still owes can pay by QR.',
        code: 'NOT_OWING' }, 409)
    }

    const base = (b.amount_cents ?? 0) + (b.addons_cents ?? 0)
    const { data: sur, error: sErr } = await db.rpc('card_surcharge_cents', {
      p_base_cents: base, p_payment_method: 'stripe',
    })
    if (sErr) throw sErr
    const surcharge = Number(sur ?? 0)
    const total = base + surcharge
    if (total <= 0) {
      return json({ error: 'Nothing to pay on that booking.', code: 'NOTHING_OWED' }, 409)
    }

    const old = String(b.stripe_checkout_session_id ?? '')
    if (old.startsWith('cs_')) {
      try {
        const was = await stripe.checkout.sessions.retrieve(old)
        if (was.status === 'open' && was.amount_total === total && was.url) {
          return json({ ok: true, url: was.url, amount_cents: total,
            expires_at: was.expires_at, reused: true })
        }
        if (was.status === 'open') await stripe.checkout.sessions.expire(old)
      } catch (err) {
        // A session Stripe no longer knows is no risk of paying twice.
        console.error('card_link: old session', old, err)
      }
    }

    const [{ data: ev }, { data: tier }, { data: lines }] = await Promise.all([
      db.from('event').select('name').eq('id', b.event_id).maybeSingle(),
      db.from('offer_tier').select('label').eq('code', b.tier_code).limit(1).maybeSingle(),
      db.from('booking_addon').select('name, qty, amount_cents').eq('booking_id', id).order('code'),
    ])
    const currency = String(b.currency ?? 'nzd').toLowerCase()
    const spot = String(tier?.label ?? b.tier_code).split(/\s+—\s+/)[0]
    const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: b.amount_cents ?? 0,
        product_data: {
          name: `${spot} parking — ${ev?.name ?? 'Talli Parking'}`,
          description: b.vehicle_rego ? `Vehicle ${b.vehicle_rego}` : undefined,
        },
      },
    }]
    for (const line of (lines ?? []) as Row[]) {
      if (!line.amount_cents) continue
      items.push({ quantity: 1, price_data: { currency, unit_amount: line.amount_cents,
        product_data: { name: line.qty > 1 ? `${line.name} × ${line.qty}` : line.name } } })
    }
    if (surcharge > 0) {
      items.push({ quantity: 1, price_data: { currency, unit_amount: surcharge,
        product_data: { name: 'Card payment surcharge',
          description: 'What it costs us to accept a card. Cash does not attract it.' } } })
    }

    const email = b.customer_email && !isGateAddress(String(b.customer_email))
      ? String(b.customer_email) : undefined
    const expiresAt = Math.floor(Date.now() / 1000) + CARD_LINK_MINUTES * 60
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      expires_at: expiresAt,
      line_items: items,
      metadata: { booking_id: id, source: 'gate_qr' },
      payment_intent_data: { metadata: { booking_id: id, source: 'gate_qr' } },
      success_url: `${SITE_URL}/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/`,
    })
    if (session.amount_total !== total) {
      await stripe.checkout.sessions.expire(session.id)
      console.error('card_link: Stripe total', session.amount_total, 'expected', total)
      return json({ error: 'The card amount did not add up. Take cash or a transfer.',
        code: 'AMOUNT_MISMATCH' }, 502)
    }
    const { error: uErr } = await db.from('booking')
      .update({ stripe_checkout_session_id: session.id }).eq('id', id)
    if (uErr) {
      await stripe.checkout.sessions.expire(session.id)
      throw uErr
    }
    return json({ ok: true, url: session.url, amount_cents: total,
      expires_at: session.expires_at })
  },

  // Has the QR been paid yet? Polled by the screen while it shows one.
  async card_status({ body, bookingGuard }: Ctx) {
    const blocked = await bookingGuard()
    if (blocked) return blocked
    const { data: st, error: stErr } = await db.from('booking')
      .select('status, payment_method').eq('id', String(body.booking_id)).maybeSingle()
    if (stErr) throw stErr
    return json({
      paid: st?.status === 'paid',
      status: st?.status ?? null,
      payment_method: st?.payment_method ?? null,
    })
  },
}
