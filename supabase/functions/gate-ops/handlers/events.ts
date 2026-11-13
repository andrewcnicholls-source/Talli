// gate-ops actions for making and running an event: the new-event form,
// templates, status, capacity, prices and the walk-up reserve. Andrew's
// alone (OPERATOR_ONLY in auth.ts).

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, minutes, named, type Row } from '../shared.ts'

// Pictures for series pages and nights (plan A1). The bucket is public to
// read and has no storage policy for browsers: only this function writes
// to it, with the service role, for Andrew.
const PICTURE_BUCKET = 'event-pictures'
const PICTURE_MAX_BYTES = 5 * 1024 * 1024
const PICTURE_TYPES: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': {
    ext: 'webp',
    magic: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  },
}
const SERIES_FIELDS = 'id, slug, name, kind, venue, summary, picture_path, sort_order, active'

export const events: Record<string, Handler> = {
  // --------------------------------------------- making a new event

  // Everything the "new event" modal needs to open, in one round trip:
  // the templates to choose from, and the properties an event can be
  // sold at. Neither list is long enough to be worth paging.
  async event_form(_: Ctx) {
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
  },

  // The date arrives as the wall clock someone typed plus the zone the
  // phone is in, never as an instant. A staging session run from another
  // timezone must not quietly book a 7:05pm kickoff for 7:05pm elsewhere.
  async create_event({ body }: Ctx) {
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
  },

  // The shape of a night, kept so it never has to be retyped. Saving
  // under a name that already exists replaces it rather than making a
  // second template nobody can tell apart.
  async save_template({ body }: Ctx) {
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
  },

  // Draft, announced, on sale, closed, cancelled. This is the lever that
  // decides whether the public site sells the night at all, so it belongs
  // on the phone next to everything else that moves during an event.
  async set_event_status({ body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const { data, error } = await db.rpc('set_event_status', {
      p_event_id: eventId,
      p_status: String(body.status ?? ''),
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, status: data })
  },

  // ------------------------------------------------ the night's levers

  // A space lost to a bad park, or found because a hatchback fitted where
  // an SUV would not. Always ±1 from the screen, against the type rather
  // than the corner of the yard: Andrew knows which bays are which, so
  // losing one in the back yard is one fewer Standard.
  //
  // A delta, never "set it to this". The number on the glass is thirty
  // seconds old at worst and another phone's work at best.
  async set_capacity({ body, eventId }: Ctx) {
    const delta = Number(body.delta ?? 0)
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10) {
      return json({ error: 'delta must be a whole number between -10 and 10' }, 400)
    }
    const { data, error } = await db.rpc('adjust_tier_capacity', {
      p_event_id: eventId,
      p_property_id: String(body.property_id ?? ''),
      p_tier_code: String(body.tier_code ?? ''),
      p_delta: delta,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, capacity: data })
  },

  // The signage is a rack of swappable cards and it gets swapped. This is
  // how the database follows.
  async set_price({ body, eventId }: Ctx) {
    const { data, error } = await db.rpc('set_tier_price', {
      p_event_id: eventId,
      p_property_id: String(body.property_id ?? ''),
      p_tier_code: String(body.tier_code ?? ''),
      p_price_cents: Number(body.price_cents ?? 0),
    })
    if (error) return json(named(error), 409)
    // Only the reference site (Andrew's house) takes a price, and the
    // database moves every block with it in the same transaction, each at
    // its adjustment. Any other site is refused as REFERENCE_PRICE_ONLY.
    return json({ ok: true, price_cents: data })
  },

  // The whole sign at once. What actually moves a Talli price is what
  // the council has done to the roads, and that is one decision for the
  // night, not three — so the templates are named for the road state and
  // this sets every tier from the one that was picked.
  async apply_price_template({ body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const { data, error } = await db.rpc('apply_price_template', {
      p_event_id: eventId,
      p_template_id: String(body.template_id ?? ''),
      // Every property selling this night. The gate screen never
      // mentions properties, so it must not have to name one here.
      p_property_id: body.property_id ? String(body.property_id) : null,
    })
    if (error) return json(named(error), 409)
    // The database has already put every block back at its adjustment.
    return json({ ok: true, applied: data })
  },

  // How many of this tier online may not sell down into, tonight only.
  // Lowering it is releasing spaces to the website; raising it is taking
  // them back for the people who will drive up with cash.
  //
  // The screen sends a delta — one more, one fewer — and the database
  // applies it to whatever the row actually holds. A phone showing a
  // stale reserve then still moves it the way the operator meant, rather
  // than writing back the number it happened to be displaying. An
  // explicit `reserve` still sets an exact figure, for a typed-in number.
  async set_reserve({ body, eventId }: Ctx) {
    const delta = body.delta === undefined ? null : Number(body.delta)
    if (delta !== null) {
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10) {
        return json({ error: 'delta must be a whole number between -10 and 10' }, 400)
      }
      const { data, error } = await db.rpc('adjust_tier_reserve', {
        p_event_id: eventId,
        p_property_id: String(body.property_id ?? ''),
        p_tier_code: String(body.tier_code ?? ''),
        p_delta: delta,
      })
      if (error) return json(named(error), 409)
      return json({ ok: true, reserve: data })
    }

    const { data, error } = await db.rpc('set_tier_reserve', {
      p_event_id: eventId,
      p_property_id: String(body.property_id ?? ''),
      p_tier_code: String(body.tier_code ?? ''),
      p_reserve: Number(body.reserve ?? 0),
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, reserve: data })
  },

  // ------------------------------------------------ series (plan A1)

  // Every series, on sale or not, with its nights: the event manager's
  // picture of how the calendar is grouped.
  async series_list(_: Ctx) {
    const [seriesRes, nightRes] = await Promise.all([
      db.from('event_series').select(SERIES_FIELDS)
        .order('sort_order', { ascending: true }).order('name', { ascending: true }),
      db.from('event').select('id, name, starts_at, status, series_id, night_label, picture_path')
        .order('starts_at', { ascending: true }),
    ])
    if (seriesRes.error) throw seriesRes.error
    if (nightRes.error) throw nightRes.error
    const nights = new Map<string, Row[]>()
    for (const e of (nightRes.data ?? []) as Row[]) {
      const list = nights.get(String(e.series_id)) ?? []
      list.push(e)
      nights.set(String(e.series_id), list)
    }
    return json({
      series: ((seriesRes.data ?? []) as Row[]).map((s) => ({
        ...s, nights: nights.get(String(s.id)) ?? [],
      })),
    })
  },

  // Make a series, or change one. The address (slug) survives a rename;
  // it changes only when one is sent.
  async save_series({ body }: Ctx) {
    const sort = body.sort_order === undefined || body.sort_order === '' ? null : Number(body.sort_order)
    if (sort !== null && !Number.isInteger(sort)) {
      return json({ error: 'The order must be a whole number.', code: 'BAD_ORDER' }, 400)
    }
    const { data, error } = await db.rpc('save_event_series', {
      p_id: body.series_id ? String(body.series_id) : null,
      p_name: String(body.name ?? ''),
      p_kind: body.kind ? String(body.kind) : null,
      p_venue: body.venue ? String(body.venue) : null,
      p_summary: body.summary === undefined || body.summary === null ? null : String(body.summary),
      p_sort_order: sort,
      p_active: typeof body.active === 'boolean' ? body.active : null,
      p_slug: body.slug ? String(body.slug) : null,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, series: data })
  },

  // Put a night in a series, and say which night it is.
  async set_event_series({ body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const seriesId = String(body.series_id ?? '')
    const { data: series, error: sErr } = await db.from('event_series')
      .select('id').eq('id', seriesId).maybeSingle()
    if (sErr) throw sErr
    if (!series) return json({ error: 'That series does not exist.', code: 'NO_SUCH_SERIES' }, 404)
    const label = String(body.night_label ?? '').trim()
    if (label.length > 80) {
      return json({ error: 'Keep the night\'s name under 80 characters.', code: 'BAD_LABEL' }, 400)
    }
    const { data, error } = await db.from('event')
      .update({ series_id: seriesId, night_label: label || null })
      .eq('id', eventId)
      .select('id, series_id, night_label')
    if (error) throw error
    if (!data?.length) return json({ error: 'No such event' }, 404)
    return json({ ok: true, event: data[0] })
  },

  // A picture for a series, or for one night. Sent as base64 so it rides
  // the same signed-in call as everything else; checked here for type,
  // size and the file's own first bytes, whatever the browser claimed.
  // { remove: true } takes the picture off without uploading anything.
  async upload_picture({ body }: Ctx) {
    const target = String(body.target ?? '')
    const id = String(body.id ?? '')
    if (!['series', 'event'].includes(target) || !id) {
      return json({ error: 'target (series or event) and id are required' }, 400)
    }
    const table = target === 'series' ? 'event_series' : 'event'
    const { data: row, error: rErr } = await db.from(table).select('id').eq('id', id).maybeSingle()
    if (rErr) throw rErr
    if (!row) return json({ error: 'Nothing to put that picture on.', code: 'NOT_FOUND' }, 404)

    if (body.remove === true) {
      const { error } = await db.from(table).update({ picture_path: null }).eq('id', id)
      if (error) throw error
      return json({ ok: true, picture_path: null })
    }

    const type = PICTURE_TYPES[String(body.content_type ?? '')]
    if (!type) {
      return json({ error: 'A JPEG, PNG or WebP picture, please.', code: 'BAD_PICTURE' }, 400)
    }
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(String(body.data ?? '')), (c) => c.charCodeAt(0))
    } catch {
      return json({ error: 'That picture did not arrive whole. Try again.', code: 'BAD_PICTURE' }, 400)
    }
    if (!bytes.length || bytes.length > PICTURE_MAX_BYTES) {
      return json({ error: 'Pictures up to 5 MB, please.', code: 'PICTURE_TOO_BIG' }, 400)
    }
    if (!type.magic(bytes)) {
      return json({ error: 'That file is not the picture it says it is.', code: 'BAD_PICTURE' }, 400)
    }

    const path = `${target}/${id}/${crypto.randomUUID()}.${type.ext}`
    const { error: upErr } = await db.storage.from(PICTURE_BUCKET)
      .upload(path, bytes, { contentType: String(body.content_type), upsert: false })
    if (upErr) throw upErr
    // The path within the bucket, not a full address: the host differs
    // between projects, and a page builds the address from its own.
    const { error } = await db.from(table).update({ picture_path: path }).eq('id', id)
    if (error) throw error
    return json({ ok: true, picture_path: path })
  },
}
