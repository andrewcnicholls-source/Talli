// gate-ops actions for sites and blocks: the bank details a warden's Site
// info tab shows, and the Sites tab, which is Andrew's alone.

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, named, pictureFrom, type Row } from '../shared.ts'

// The pictures of where to park at a site (plan A4). Public to read; only
// this function writes, with the service role.
const SITE_PICTURE_BUCKET = 'site-pictures'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const caption = (v: unknown) => {
  const t = String(v ?? '').trim()
  return t ? t.slice(0, 200) : null
}

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

  // Everything the Sites page draws (plan B3), in one round trip: every
  // driveway with its details, usual counts and the upcoming nights it
  // sells (with that night's counts and what has sold); the areas with
  // their anchor and price adjustments; the hosts to choose from; and the
  // upcoming nights, for the tick list and the night filter. Short lists.
  async sites_setup(_: Ctx) {
    // A night still in progress is still upcoming: its numbers can move.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const [propRes, defRes, blockRes, refRes, offRes, hostRes, nightRes, picRes] = await Promise.all([
      db.from('property')
        .select('id, name, address, lat, lng, active, block_id, host_id, walk_minutes, ' +
                'site_guide_url, fill_notes, slug, ' +
                'host:host_id(name), block:block_id(name, sort_order, anchor_property_id)')
        .order('name', { ascending: true }),
      db.from('property_tier_default').select('property_id, code, capacity, online'),
      db.from('block').select('id, name, slug, sort_order, anchor_property_id').eq('active', true)
        .order('sort_order', { ascending: true }),
      db.rpc('reference_property'),
      db.from('block_tier_offset').select('block_id, code, offset_cents'),
      db.from('host').select('id, name').order('name', { ascending: true }),
      db.from('event').select('id, name, starts_at, expected_end_at, status, is_live')
        .not('status', 'in', '(closed,cancelled)')
        .gt('starts_at', since)
        .order('starts_at', { ascending: true }),
      db.from('site_picture').select('id, property_id, path, caption, sort_order')
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
    ])
    for (const r of [propRes, defRes, blockRes, offRes, hostRes, nightRes, picRes]) {
      if (r.error) throw r.error
    }
    const now = Date.now()
    const nights = ((nightRes.data ?? []) as Row[])
      .filter((e) => new Date(e.expected_end_at ?? e.starts_at).getTime() > now)
      .map((e) => ({ id: e.id, name: e.name, starts_at: e.starts_at, status: e.status,
        is_live: e.is_live === true }))
    const nightIds = nights.map((n) => String(n.id))

    // Which of those nights each site sells, and its numbers on each.
    const offersBySite = new Map<string, Row[]>()
    if (nightIds.length) {
      const [eoRes, tierRes] = await Promise.all([
        db.from('event_offer').select('event_id, property_id, status').in('event_id', nightIds),
        db.from('v_tier_availability')
          .select('event_id, property_id, code, capacity, gate_reserve, sold')
          .in('event_id', nightIds),
      ])
      if (eoRes.error) throw eoRes.error
      if (tierRes.error) throw tierRes.error
      const tiers = new Map<string, Row[]>()
      for (const t of (tierRes.data ?? []) as Row[]) {
        const k = `${t.event_id}|${t.property_id}`
        const list = tiers.get(k) ?? []
        list.push({
          code: t.code,
          capacity: t.capacity ?? 0,
          online: Math.max(0, (t.capacity ?? 0) - (t.gate_reserve ?? 0)),
          sold: t.sold ?? 0,
        })
        tiers.set(k, list)
      }
      for (const o of (eoRes.data ?? []) as Row[]) {
        const list = offersBySite.get(String(o.property_id)) ?? []
        list.push({
          event_id: o.event_id,
          status: o.status,
          tiers: tiers.get(`${o.event_id}|${o.property_id}`) ?? [],
        })
        offersBySite.set(String(o.property_id), list)
      }
    }

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
    const pictures = new Map<string, Row[]>()
    for (const p of (picRes.data ?? []) as Row[]) {
      const list = pictures.get(String(p.property_id)) ?? []
      list.push({ id: p.id, path: p.path, caption: p.caption ?? null })
      pictures.set(String(p.property_id), list)
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
      host_id: p.host_id,
      host_name: p.host?.name ?? null,
      walk_minutes: p.walk_minutes ?? null,
      site_guide_url: p.site_guide_url ?? null,
      fill_notes: p.fill_notes ?? null,
      slug: p.slug,
      pictures: pictures.get(String(p.id)) ?? [],
      is_reference: String(p.id) === ref,
      defaults: defaults.get(String(p.id)) ?? [],
      nights: offersBySite.get(String(p.id)) ?? [],
    })).sort((a: Row, b: Row) => (a.block_sort - b.block_sort) ||
      String(a.name).localeCompare(String(b.name)))
    return json({ sites, blocks, hosts: hostRes.data ?? [], nights })
  },

  // A site's details (plan B3). Each field sent is written; one left out
  // is left alone. The database refuses, by name, a booked site leaving
  // its area or switching off (SITE_HAS_BOOKINGS), the reference site
  // doing either (REFERENCE_SITE), and an anchor leaving an area that
  // still has other sites (SITE_IS_ANCHOR).
  async save_site_details({ body }: Ctx) {
    const details = siteDetails(body)
    if (typeof details === 'string') return json({ error: details }, 400)
    const { data, error } = await db.rpc('save_site_details', {
      p_property_id: String(body.property_id ?? ''),
      p_details: details,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Row) })
  },

  // A new site from one set of details: the address and position the
  // Places picker filled in (or typed), its host and its area. It joins
  // no night until it is ticked onto one.
  async add_site({ body }: Ctx) {
    const details = siteDetails(body)
    if (typeof details === 'string') return json({ error: details }, 400)
    const { data, error } = await db.rpc('add_site', { p_details: details })
    if (error) return json(named(error), 409)
    return json({ ok: true, property_id: data })
  },

  // Which of an area's sites is its anchor: the address a customer is
  // told, "<anchor> or within 100m". Always one of its own active sites.
  async set_block_anchor({ body }: Ctx) {
    const { error } = await db.rpc('set_block_anchor', {
      p_block_id: String(body.block_id ?? ''),
      p_property_id: String(body.property_id ?? ''),
    })
    if (error) return json(named(error), 409)
    return json({ ok: true })
  },

  // The nights a site sells, as ticks. It joins a night pending, at its
  // usual numbers; going on sale online is set_offer_status, a separate
  // tap. Unticking a night anyone is booked on is refused.
  async set_site_nights({ body }: Ctx) {
    const ids = (v: unknown) => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []
    const { data, error } = await db.rpc('set_site_nights', {
      p_property_id: String(body.property_id ?? ''),
      p_add: ids(body.add),
      p_remove: ids(body.remove),
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Row) })
  },

  // One night's actual spaces per type at one site, overriding its usual
  // numbers for that night only. Never below what has sold (BELOW_SOLD).
  async save_site_night({ body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const tiers = Array.isArray(body.tiers) ? (body.tiers as Row[]).map((t) => ({
      code: String(t?.code ?? ''),
      capacity: Number(t?.capacity),
      online: Number(t?.online),
    })) : []
    if (!tiers.length) return json({ error: 'tiers is required' }, 400)
    if (tiers.some((t) => !Number.isInteger(t.capacity) || !Number.isInteger(t.online) ||
        t.capacity < 0 || t.online < 0)) {
      return json({ error: 'Counts are whole numbers, none below zero.' }, 400)
    }
    const { data, error } = await db.rpc('set_site_night', {
      p_event_id: eventId,
      p_property_id: String(body.property_id ?? ''),
      p_tiers: tiers,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Row) })
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

  // ------------------------------------- the Locate Us card (plan A4)

  // A site's or an area's address on the Talli site, /go/<slug>. The
  // database checks the shape and that no other site or area has it.
  // Printed cards carry the old one: the Sites page warns before this.
  async save_place_slug({ body }: Ctx) {
    const kind = String(body.kind ?? '')
    const id = String(body.id ?? '')
    if (!['site', 'block'].includes(kind) || !UUID.test(id)) {
      return json({ error: 'kind (site or block) and id are required' }, 400)
    }
    const { data, error } = await db.rpc('set_place_slug', {
      p_kind: kind, p_id: id, p_slug: String(body.slug ?? ''),
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, slug: data })
  },

  // A picture of where to park, added to the end of a site's list. Sent
  // as base64 on the same signed-in call as everything else, and checked
  // for type, size and the file's own first bytes (pictureFrom).
  async upload_site_picture({ body }: Ctx) {
    const id = String(body.property_id ?? '')
    if (!UUID.test(id)) return json({ error: 'property_id is required' }, 400)
    const { data: site, error: sErr } = await db.from('property').select('id').eq('id', id).maybeSingle()
    if (sErr) throw sErr
    if (!site) return json({ error: 'That site does not exist.', code: 'NOT_FOUND' }, 404)

    const pic = pictureFrom(body)
    if (pic instanceof Response) return pic

    const { data: last, error: lErr } = await db.from('site_picture').select('sort_order')
      .eq('property_id', id).order('sort_order', { ascending: false }).limit(1)
    if (lErr) throw lErr
    const path = `site/${id}/${crypto.randomUUID()}.${pic.ext}`
    const { error: upErr } = await db.storage.from(SITE_PICTURE_BUCKET)
      .upload(path, pic.bytes, { contentType: pic.type, upsert: false })
    if (upErr) throw upErr
    const { data, error } = await db.from('site_picture').insert({
      property_id: id, path, caption: caption(body.caption),
      sort_order: ((last ?? [])[0]?.sort_order ?? -1) + 1,
    }).select('id, property_id, path, caption, sort_order').single()
    if (error) {
      await db.storage.from(SITE_PICTURE_BUCKET).remove([path])
      throw error
    }
    return json({ ok: true, picture: data })
  },

  // A picture's caption, or its place in the list (move: -1 up, 1 down).
  async save_site_picture({ body }: Ctx) {
    const id = String(body.picture_id ?? '')
    if (!UUID.test(id)) return json({ error: 'picture_id is required' }, 400)
    const { data: pic, error: pErr } = await db.from('site_picture')
      .select('id, property_id').eq('id', id).maybeSingle()
    if (pErr) throw pErr
    if (!pic) return json({ error: 'That picture is gone.', code: 'NOT_FOUND' }, 404)

    if (body.caption !== undefined) {
      const { error } = await db.from('site_picture').update({ caption: caption(body.caption) }).eq('id', id)
      if (error) throw error
    }
    const move = Number(body.move ?? 0)
    if (move === -1 || move === 1) {
      const { data: all, error } = await db.from('site_picture').select('id')
        .eq('property_id', pic.property_id)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
      if (error) throw error
      const ids = ((all ?? []) as Row[]).map((r) => String(r.id))
      const at = ids.indexOf(id)
      const to = at + move
      if (at >= 0 && to >= 0 && to < ids.length) {
        const swap = ids[at]
        ids[at] = ids[to]
        ids[to] = swap
        for (let i = 0; i < ids.length; i++) {
          const { error: oErr } = await db.from('site_picture').update({ sort_order: i }).eq('id', ids[i])
          if (oErr) throw oErr
        }
      }
    }
    return json({ ok: true })
  },

  // A picture comes off the site, and out of the bucket.
  async remove_site_picture({ body }: Ctx) {
    const id = String(body.picture_id ?? '')
    if (!UUID.test(id)) return json({ error: 'picture_id is required' }, 400)
    const { data, error } = await db.from('site_picture').delete().eq('id', id).select('path')
    if (error) throw error
    if (!data?.length) return json({ error: 'That picture is gone.', code: 'NOT_FOUND' }, 404)
    const { error: rmErr } = await db.storage.from(SITE_PICTURE_BUCKET).remove([String(data[0].path)])
    if (rmErr) console.error('site picture left in the bucket', data[0].path, rmErr)
    return json({ ok: true })
  },
}

// The details a site may be given, from the request body, keeping only the
// keys that were sent: absent means "leave it". Returns a message when a
// field is the wrong shape; the database checks the rest.
const TEXT_FIELDS = ['name', 'address', 'site_guide_url', 'fill_notes', 'new_host_name',
  'new_block_name', 'host_id', 'block_id']
function siteDetails(body: Record<string, unknown>): Row | string {
  const out: Row = {}
  for (const k of TEXT_FIELDS) {
    if (body[k] !== undefined && body[k] !== null) out[k] = String(body[k])
  }
  const blank = (v: unknown) => v === null || v === undefined || v === ''
  if (body.lat !== undefined || body.lng !== undefined) {
    if (blank(body.lat) && blank(body.lng)) {
      out.lat = null
      out.lng = null
    } else {
      const lat = Number(body.lat)
      const lng = Number(body.lng)
      if (blank(body.lat) || blank(body.lng) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return 'That map position does not look right.'
      }
      out.lat = lat
      out.lng = lng
    }
  }
  if (body.walk_minutes !== undefined) {
    if (blank(body.walk_minutes)) {
      out.walk_minutes = null
    } else {
      const n = Number(body.walk_minutes)
      if (!Number.isInteger(n) || n < 0 || n > 999) return 'Walking time is whole minutes.'
      out.walk_minutes = n
    }
  }
  if (body.active !== undefined) out.active = body.active === true
  return out
}
