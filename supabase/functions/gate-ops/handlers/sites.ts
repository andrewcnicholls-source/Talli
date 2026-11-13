// gate-ops actions for sites and blocks: the bank details a warden's Site
// info tab shows, and the Sites tab, which is Andrew's alone.

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, named, type Row } from '../shared.ts'

export const sites: Record<string, Handler> = {
  // The account a walk-up pays into by bank transfer, for the Site info
  // tab. Any signed-in host or warden may read it: it is what they read
  // out at the window. It is the one thing here the anon key cannot
  // reach (bank_transfer_setting has no grant), so it comes only through
  // this call, after the three checks every caller passes.
  async bank_details(_: Ctx) {
    const { data, error } = await db.from('bank_transfer_setting')
      .select('account_name, account_number').maybeSingle()
    if (error) throw error
    return json({
      account_name: data?.account_name ?? null,
      account_number: data?.account_number ?? null,
    })
  },

  // A host's driveway goes on sale online for this event once Andrew
  // has heard back from them: pending → confirmed. Paused stops online
  // sales and leaves the gate working.
  async set_offer_status({ body, eventId }: Ctx) {
    const status = String(body.status ?? '')
    if (!['pending', 'confirmed', 'paused'].includes(status)) {
      return json({ error: 'status must be pending, confirmed or paused' }, 400)
    }
    const { data, error } = await db.from('event_offer')
      .update({ status })
      .eq('event_id', eventId)
      .eq('property_id', String(body.property_id ?? ''))
      .select('status')
    if (error) throw error
    if (!data?.length) return json({ error: 'That site is not offered at this event' }, 404)
    return json({ ok: true, status })
  },

  // The driveways that could join this event: every active property not
  // already selling it, with its block, for the "Add a site" picker.
  async site_options({ eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const [propRes, offerRes] = await Promise.all([
      db.from('property')
        .select('id, name, address, block:block_id(name, sort_order)')
        .eq('active', true),
      db.from('event_offer').select('property_id').eq('event_id', eventId),
    ])
    if (propRes.error) throw propRes.error
    if (offerRes.error) throw offerRes.error
    const taken = new Set(((offerRes.data ?? []) as Row[]).map((o) => String(o.property_id)))
    const options = ((propRes.data ?? []) as Row[])
      .filter((p) => !taken.has(String(p.id)))
      .map((p) => ({
        property_id: p.id,
        name: p.name,
        address: p.address,
        block_name: p.block?.name ?? null,
        block_sort: p.block?.sort_order ?? 0,
      }))
      .sort((a: Row, b: Row) => (a.block_sort - b.block_sort) ||
        String(a.name).localeCompare(String(b.name)))
    return json({ sites: options })
  },

  // A host's driveway joins the event as pending, with the event's types
  // of space and no spaces yet. Counts are then set on Tonight, and it
  // goes on sale with set_offer_status once the host has said yes.
  async add_offer({ body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const { data, error } = await db.rpc('add_event_offer', {
      p_event_id: eventId,
      p_property_id: String(body.property_id ?? ''),
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, event_offer_id: data })
  },

  // ---------------------------------------------- setting up sites

  // Every driveway with its area, host, offset and usual counts, for the
  // Sites tab. Short lists; one round trip.
  async sites_setup(_: Ctx) {
    const [propRes, defRes, blockRes, refRes, offRes] = await Promise.all([
      db.from('property')
        .select('id, name, address, lat, lng, active, block_id, ' +
                'host:host_id(name), block:block_id(name, sort_order, anchor_property_id)')
        .order('name', { ascending: true }),
      db.from('property_tier_default').select('property_id, code, capacity, online'),
      db.from('block').select('id, name, sort_order').eq('active', true)
        .order('sort_order', { ascending: true }),
      db.rpc('reference_property'),
      db.from('block_tier_offset').select('block_id, code, offset_cents'),
    ])
    if (propRes.error) throw propRes.error
    if (defRes.error) throw defRes.error
    if (blockRes.error) throw blockRes.error
    if (offRes.error) throw offRes.error
    const ref = refRes.data ? String(refRes.data) : null
    const refBlock = ref
      ? ((propRes.data ?? []) as Row[]).find((p) => String(p.id) === ref)?.block_id ?? null
      : null
    // A block's price per type, as a difference from the reference site.
    // A type with no row is zero.
    const offsets = new Map<string, Record<string, number>>()
    for (const o of (offRes.data ?? []) as Row[]) {
      const m = offsets.get(String(o.block_id)) ?? {}
      m[String(o.code)] = Number(o.offset_cents ?? 0)
      offsets.set(String(o.block_id), m)
    }
    const blocks = ((blockRes.data ?? []) as Row[]).map((b) => ({
      ...b,
      is_reference: refBlock !== null && String(b.id) === String(refBlock),
      offsets: offsets.get(String(b.id)) ?? {},
    }))
    const defaults = new Map<string, Row[]>()
    for (const d of (defRes.data ?? []) as Row[]) {
      const list = defaults.get(String(d.property_id)) ?? []
      list.push({ code: d.code, capacity: d.capacity, online: d.online })
      defaults.set(String(d.property_id), list)
    }
    const sites = ((propRes.data ?? []) as Row[]).map((p) => ({
      property_id: p.id,
      name: p.name,
      address: p.address,
      lat: p.lat,
      lng: p.lng,
      active: p.active,
      block_id: p.block_id,
      block_name: p.block?.name ?? null,
      block_sort: p.block?.sort_order ?? 0,
      is_anchor: p.block?.anchor_property_id === p.id,
      host_name: p.host?.name ?? null,
      is_reference: String(p.id) === ref,
      defaults: defaults.get(String(p.id)) ?? [],
    })).sort((a: Row, b: Row) => (a.block_sort - b.block_sort) ||
      String(a.name).localeCompare(String(b.name)))
    return json({ sites, blocks })
  },

  // A site's usual counts per type; optionally pushed to the upcoming
  // events it is already in. Its price is its block's (save_block_pricing).
  async save_site({ body }: Ctx) {
    const { data, error } = await db.rpc('save_site_setup', {
      p_property_id: String(body.property_id ?? ''),
      // Retired column (plan B1): written as zero, read by nothing.
      p_offset_cents: 0,
      p_tiers: Array.isArray(body.tiers) ? body.tiers : [],
      p_apply_upcoming: body.apply_upcoming === true,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Row) })
  },

  // A block's price per type of park, as a difference from the reference
  // site. Every site in the block charges the same, and every upcoming
  // night the block sells is re-priced before this returns.
  async save_block_pricing({ body }: Ctx) {
    const raw = Array.isArray(body.offsets) ? body.offsets as Row[] : []
    const offsets = raw.map((o) => ({ code: String(o?.code ?? ''), offset_cents: Number(o?.offset_cents) }))
    if (!offsets.length) return json({ error: 'offsets is required' }, 400)
    if (offsets.some((o) => !Number.isInteger(o.offset_cents))) {
      return json({ error: 'An adjustment must be whole cents.' }, 400)
    }
    const { data, error } = await db.rpc('set_block_offsets', {
      p_block_id: String(body.block_id ?? ''),
      p_offsets: offsets,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, events_updated: data })
  },

  // A new driveway: its host by name, and its area, new or existing.
  async create_site({ body }: Ctx) {
    const lat = body.lat === null || body.lat === undefined || body.lat === '' ? null : Number(body.lat)
    const lng = body.lng === null || body.lng === undefined || body.lng === '' ? null : Number(body.lng)
    if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) {
      return json({ error: 'That map position does not look right.' }, 400)
    }
    const { data, error } = await db.rpc('create_site', {
      p_name: String(body.name ?? ''),
      p_address: String(body.address ?? ''),
      p_host_name: String(body.host_name ?? ''),
      p_block_id: body.block_id ? String(body.block_id) : null,
      p_new_block_name: body.new_block_name ? String(body.new_block_name) : null,
      p_lat: lat,
      p_lng: lng,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, property_id: data })
  },
}
