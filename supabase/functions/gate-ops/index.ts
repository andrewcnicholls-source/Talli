// =====================================================================
//  Talli Parking — gate operations
//
//  Everything the person on the driveway needs: the arrivals list, ticking
//  cars off as they turn in, handing over pre-purchased extras, selling a
//  space to someone who just rolled up, keeping the night's counts and
//  prices honest as they move, and making the event itself: a template to
//  start from, the details edited on the phone, and the status moved from
//  draft to on sale without a dashboard.
//
//  All of it writes, so all of it runs under the service role here rather
//  than being exposed through RLS.
//
//  Access is an identity, not a secret. The caller sends the access token
//  Supabase Auth issued them after signing in with Google; this function
//  asks the auth server who that is, and then asks the database whether
//  that verified email belongs to a host. Both questions have to come back
//  yes, every request, before anything below runs.
//
//  The shared GATE_PASSPHRASE it replaced is gone rather than kept as a
//  fallback. A secret anyone can pass on cannot say who took the money,
//  cannot be withdrawn from one person, and cannot become the basis for
//  showing one host their nights and not another host's — which is where
//  Talli is going. Leaving it in as a second door would have kept every
//  one of those problems.
// =====================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

// This function has no TEST-PROJECT FALLBACKS block any more, and should
// never grow one back. The only thing it used to fall back to was a known
// gate passphrase on test; access is now a signed-in host on both projects,
// which is the same code path in both places and therefore the one actually
// exercised by device testing.

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

// ---------------------------------------------------------------------
//  WHO IS ASKING
//
//  Three steps, and the order is the whole point:
//
//    1. Ask Supabase Auth to resolve the bearer token. Not decode it —
//       resolve it. The project's own anon key is a perfectly well-formed
//       JWT signed by the same secret, so anything that merely parsed the
//       token would hand the gate screen to the entire internet. The /user
//       endpoint answers "no user" for an anon key, an expired token and a
//       signed-out one alike.
//
//    2. Insist on a confirmed email. Google confirms one, so this only
//       ever excludes an identity that arrived some other way.
//
//    3. Ask the database whether that email is a host, via
//       host_access_for(). The email handed to it came out of step 1 and
//       never out of the request body — that is the security boundary, and
//       it is why the function is service-role only.
// ---------------------------------------------------------------------
type Caller = {
  user_id: string
  email: string
  hosts: Array<{ host_id: string; host_name: string; role: string }>
  // The host_user row actions are recorded against (checked_in_by,
  // cash_collected_by). The operator's row when there is one.
  me: string
  // Andrew sees everything. A warden (scope 'blocks') sees only the blocks
  // switched on for them in staff_block_access — and an empty list means
  // nothing, never everything.
  all: boolean
  blocks: string[]
}

type Denied = { status: number; error: string; code: string }

async function callerFrom(req: Request): Promise<Caller | Denied> {
  const token = (req.headers.get('Authorization') ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  if (!token) {
    return { status: 401, error: 'Sign in to use the gate screen.', code: 'NO_SESSION' }
  }

  const { data, error } = await db.auth.getUser(token)
  const user = data?.user
  if (error || !user) {
    return { status: 401, error: 'Your session has expired. Sign in again.', code: 'NO_SESSION' }
  }

  const email = (user.email ?? '').trim()
  if (!email || !user.email_confirmed_at) {
    return {
      status: 403,
      error: 'That account has no confirmed email address.',
      code: 'EMAIL_UNCONFIRMED',
    }
  }

  const { data: rows, error: accessError } = await db.rpc('host_access_for', {
    p_user_id: user.id,
    p_email: email,
  })
  if (accessError) throw accessError

  const hosts = (rows ?? []) as Array<Row>
  if (!hosts.length) {
    return {
      status: 403,
      error: `${email} is not set up as a Talli host.`,
      code: 'NOT_A_HOST',
    }
  }

  // What this person may see. Read from the table, never from the request.
  const ids = hosts.map((r) => String(r.host_user_id))
  const { data: scopeRows, error: scopeErr } = await db
    .from('host_user')
    .select('id, scope, host:host_id(is_operator)')
    .in('id', ids)
  if (scopeErr) throw scopeErr
  const rowsScoped = (scopeRows ?? []) as Row[]
  const operatorRows = rowsScoped.filter((r) => r.host?.is_operator === true)
  const all = operatorRows.some((r) => r.scope === 'all')

  let blocks: string[] = []
  if (!all) {
    const wardenIds = rowsScoped.filter((r) => r.scope === 'blocks').map((r) => String(r.id))
    if (wardenIds.length) {
      const { data: grants, error: gErr } = await db
        .from('staff_block_access')
        .select('block_id')
        .in('host_user_id', wardenIds)
        .eq('active', true)
      if (gErr) throw gErr
      blocks = [...new Set(((grants ?? []) as Row[]).map((g) => String(g.block_id)))]
    }
    // A host of their own driveway, or a warden with every block switched
    // off, has no gate screen yet. Say so rather than show an empty one.
    if (!blocks.length) {
      return {
        status: 403,
        error: `${email} has no blocks to work on the gate screen right now.`,
        code: 'NO_BLOCKS',
      }
    }
  }

  return {
    user_id: user.id,
    email,
    hosts: hosts.map((r) => ({
      host_id: String(r.host_id),
      host_name: String(r.host_name),
      role: String(r.role),
    })),
    me: String((operatorRows[0] ?? rowsScoped[0] ?? hosts[0]).id ?? hosts[0].host_user_id),
    all,
    blocks,
  }
}

// The properties a caller may work on, or null for "every one".
async function allowedProperties(c: Caller): Promise<Set<string> | null> {
  if (c.all) return null
  const { data, error } = await db.from('property').select('id').in('block_id', c.blocks)
  if (error) throw error
  return new Set(((data ?? []) as Row[]).map((r) => String(r.id)))
}

// A warden may touch a booking that is, or was booked, at one of their sites.
async function mayTouchBooking(allowed: Set<string> | null, bookingId: string) {
  if (allowed === null) return true
  const { data, error } = await db.from('booking')
    .select('property_id, booked_property_id').eq('id', bookingId).maybeSingle()
  if (error) throw error
  if (!data) return false
  return allowed.has(String(data.property_id)) ||
    (data.booked_property_id !== null && allowed.has(String(data.booked_property_id)))
}

// The night's prices, capacity, templates and event set-up are Andrew's.
// A warden works the gate: check-in, walk-ups, fixing a booking.
const OPERATOR_ONLY = new Set([
  'event_form', 'create_event', 'save_template', 'set_event_status',
  'set_capacity', 'set_price', 'apply_price_template', 'set_reserve',
  'set_offer_status', 'site_options', 'add_offer',
  'sites_setup', 'save_site', 'create_site',
])

const denied = (c: Caller | Denied): c is Denied =>
  typeof (c as Denied).status === 'number'

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

// A price for one car, in cents. null when none was sent; false when one
// was sent and it is not a price. The database checks the same bounds.
function priceCents(v: unknown): number | null | false {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 100 || n > 50000) return false
  return n
}

type Row = Record<string, any>

// sell_at_gate's stand-in for a walk-up who gave no email.
const isGateAddress = (email: string) => /^gate\+[0-9a-f]+@talli\.co\.nz$/i.test(email)

const PAY_METHODS = ['cash', 'tap_to_pay', 'bank_transfer', 'free', 'other', 'unpaid']

// Tap to pay goes through Andrew's terminal and his Stripe account. A warden
// has neither, so a warden cannot record a sale as taken that way. The screen
// does not offer it to them; this is the check that decides.
const TAP_REFUSED = {
  error: 'Tap to pay is Andrew\'s. Take cash or a bank transfer.',
  code: 'OPERATOR_ONLY',
}

// Absent means "leave it"; a string, even an empty one, means "set it".
const optText = (v: unknown): string | null =>
  v === undefined || v === null ? null : String(v)

// Everything the gate screen draws, from one round trip. On a phone at the
// end of a driveway, one request that sometimes carries a little too much
// beats four that each might not arrive.
async function nightState(eventId: string, allowed: Set<string> | null = null) {
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  // Identity first, before the body is even read. Nothing below this line
  // runs for anyone who is not a signed-in host, and there is no branch —
  // no test fallback, no configured-secret check — that can skip it. The
  // test project is not a special case here: it has its own Supabase Auth
  // and its own host_user rows.
  let caller: Caller | Denied
  try {
    caller = await callerFrom(req)
  } catch (err) {
    console.error('host lookup failed', err)
    return json({ error: 'Could not check who you are. Try again.' }, 503)
  }
  if (denied(caller)) {
    return json({ error: caller.error, code: caller.code }, caller.status)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  const action = String(body.action ?? '')
  const eventId = String(body.event_id ?? '')

  if (!caller.all && OPERATOR_ONLY.has(action)) {
    return json({ error: 'Only Andrew can change that.', code: 'OPERATOR_ONLY' }, 403)
  }

  try {
    const allowed = await allowedProperties(caller)
    const bookingGuard = async () => {
      const id = String(body.booking_id ?? '')
      if (!id) return json({ error: 'booking_id is required' }, 400)
      if (!(await mayTouchBooking(allowed, id))) {
        return json({ error: 'That booking is not at one of your sites.', code: 'NOT_YOUR_SITE' }, 403)
      }
      return null
    }

    switch (action) {
      // What the screen needs to open: who it just let in, and the list to
      // pick from. One round trip, because the alternative is a screen that
      // can be signed in and empty at the same time.
      //
      // `events` is deliberately not filtered by host yet. There is one
      // real host, and a filter written against a second host who does not
      // exist is a filter nobody can prove is right. The identity is in the
      // request now, which is the part that had to come first — `who.hosts`
      // is what the filter will read when it is wanted.
      case 'session': {
        const { data, error } = await db
          .from('event')
          .select('id, name, venue, starts_at, status')
          .order('starts_at', { ascending: true })
        if (error) throw error
        return json({
          who: {
            email: caller.email,
            hosts: caller.hosts,
            host_name: caller.hosts[0].host_name,
            role: caller.hosts[0].role,
            // false for a warden: the screen hides Tonight and Insights.
            operator: caller.all,
            blocks: caller.blocks,
          },
          events: data,
        })
      }

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
        return json(await nightState(eventId, allowed))
      }

      // The account a walk-up pays into by bank transfer, for the Site info
      // tab. Any signed-in host or warden may read it: it is what they read
      // out at the window. It is the one thing here the anon key cannot
      // reach (bank_transfer_setting has no grant), so it comes only through
      // this call, after the three checks every caller passes.
      case 'bank_details': {
        const { data, error } = await db.from('bank_transfer_setting')
          .select('account_name, account_number').maybeSingle()
        if (error) throw error
        return json({
          account_name: data?.account_name ?? null,
          account_number: data?.account_number ?? null,
        })
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
        const mine = ((data ?? []) as Row[])
          .filter((t: Row) => allowed === null || allowed.has(String(t.property_id)))
        return json({ tiers: mine, card_surcharge_bps: rate?.card_surcharge_bps ?? 0 })
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

      // Ticking a car in records that it turned up, and nothing else. Where
      // it actually goes is the marshal's call standing in the driveway —
      // the database has no bays to have an opinion about.
      //
      // With several driveways in a block, the one place it does record is
      // which driveway: the site the warden says they are standing at. That
      // is what the host is paid on.
      case 'check_in': {
        const blocked = await bookingGuard()
        if (blocked) return blocked
        const id = String(body.booking_id)
        const site = body.property_id ? String(body.property_id) : null
        if (site && allowed !== null && !allowed.has(site)) {
          return json({ error: 'That site is not one of yours.', code: 'NOT_YOUR_SITE' }, 403)
        }
        const { error } = await db.rpc('check_in_booking_at', {
          p_booking_id: id,
          p_property_id: site,
          p_by: caller.me,
        })
        if (error) return json(named(error), 409)
        return json({ ok: true })
      }

      // Mis-taps happen, and happen most when it is busy.
      case 'undo_check_in': {
        const blocked = await bookingGuard()
        if (blocked) return blocked
        const id = String(body.booking_id)
        const { error } = await db
          .from('booking')
          .update({ checked_in_at: null, checked_in_by: null })
          .eq('id', id)
        if (error) throw error
        return json({ ok: true })
      }

      // One tap covers the whole bag. Nobody hands over a poncho and an
      // earplug pair as two separate transactions.
      case 'hand_over': {
        const blocked = await bookingGuard()
        if (blocked) return blocked
        const id = String(body.booking_id)
        const { data, error } = await db.rpc('set_addons_handed_over', {
          p_booking_id: id,
          p_handed: body.handed !== false,
        })
        if (error) throw error
        return json({ ok: true, lines: data })
      }

      case 'sell': {
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

      // ------------------------------------------------ fixing a booking

      // Tap a row, change what was wrong. Details, how they paid, and which
      // type of space they are counted against, in one transaction — so a
      // valet customer who ended up in Priority frees the valet space and
      // takes a Priority one, with what they paid left exactly as it was.
      case 'edit_booking': {
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
      }

      // A "pay later" walk-up who drove off, or was never really there.
      case 'cancel_unpaid': {
        const blocked = await bookingGuard()
        if (blocked) return blocked
        const id = String(body.booking_id)
        const { error } = await db.rpc('cancel_unpaid_gate_booking', { p_booking_id: id })
        if (error) return json(named(error), 409)
        return json({ ok: true })
      }

      // ------------------------------------------------ the night's levers

      // A space lost to a bad park, or found because a hatchback fitted where
      // an SUV would not. Always ±1 from the screen, against the type rather
      // than the corner of the yard: Andrew knows which bays are which, so
      // losing one in the back yard is one fewer Standard.
      //
      // A delta, never "set it to this". The number on the glass is thirty
      // seconds old at worst and another phone's work at best.
      case 'set_capacity': {
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
        // A price on the reference site (Andrew's house) moves every other
        // site in the event with it, each at its own offset.
        const { data: ref } = await db.rpc('reference_property')
        if (ref && String(ref) === String(body.property_id ?? '')) {
          await db.rpc('apply_price_offsets', { p_event_id: eventId })
        }
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
        // A template sets one price for everyone; put each site's offset back.
        await db.rpc('apply_price_offsets', { p_event_id: eventId })
        return json({ ok: true, applied: data })
      }

      // How many of this tier online may not sell down into, tonight only.
      // Lowering it is releasing spaces to the website; raising it is taking
      // them back for the people who will drive up with cash.
      //
      // The screen sends a delta — one more, one fewer — and the database
      // applies it to whatever the row actually holds. A phone showing a
      // stale reserve then still moves it the way the operator meant, rather
      // than writing back the number it happened to be displaying. An
      // explicit `reserve` still sets an exact figure, for a typed-in number.
      case 'set_reserve': {
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
      }

      // A host's driveway goes on sale online for this event once Andrew
      // has heard back from them: pending → confirmed. Paused stops online
      // sales and leaves the gate working.
      case 'set_offer_status': {
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
      }

      // The driveways that could join this event: every active property not
      // already selling it, with its block, for the "Add a site" picker.
      case 'site_options': {
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
      }

      // A host's driveway joins the event as pending, with the event's types
      // of space and no spaces yet. Counts are then set on Tonight, and it
      // goes on sale with set_offer_status once the host has said yes.
      case 'add_offer': {
        if (!eventId) return json({ error: 'event_id is required' }, 400)
        const { data, error } = await db.rpc('add_event_offer', {
          p_event_id: eventId,
          p_property_id: String(body.property_id ?? ''),
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, event_offer_id: data })
      }

      // ---------------------------------------------- setting up sites

      // Every driveway with its area, host, offset and usual counts, for the
      // Sites tab. Short lists; one round trip.
      case 'sites_setup': {
        const [propRes, defRes, blockRes, refRes] = await Promise.all([
          db.from('property')
            .select('id, name, address, lat, lng, active, block_id, price_offset_cents, ' +
                    'host:host_id(name), block:block_id(name, sort_order, anchor_property_id)')
            .order('name', { ascending: true }),
          db.from('property_tier_default').select('property_id, code, capacity, online'),
          db.from('block').select('id, name, sort_order').eq('active', true)
            .order('sort_order', { ascending: true }),
          db.rpc('reference_property'),
        ])
        if (propRes.error) throw propRes.error
        if (defRes.error) throw defRes.error
        if (blockRes.error) throw blockRes.error
        const ref = refRes.data ? String(refRes.data) : null
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
          price_offset_cents: p.price_offset_cents ?? 0,
          is_reference: String(p.id) === ref,
          defaults: defaults.get(String(p.id)) ?? [],
        })).sort((a: Row, b: Row) => (a.block_sort - b.block_sort) ||
          String(a.name).localeCompare(String(b.name)))
        return json({ sites, blocks: blockRes.data ?? [] })
      }

      // A site's usual counts per type and its price offset; optionally
      // pushed to the upcoming events it is already in.
      case 'save_site': {
        const offset = Number(body.price_offset_cents ?? 0)
        if (!Number.isInteger(offset)) {
          return json({ error: 'The price difference must be whole cents.' }, 400)
        }
        const { data, error } = await db.rpc('save_site_setup', {
          p_property_id: String(body.property_id ?? ''),
          p_offset_cents: offset,
          p_tiers: Array.isArray(body.tiers) ? body.tiers : [],
          p_apply_upcoming: body.apply_upcoming === true,
        })
        if (error) return json(named(error), 409)
        return json({ ok: true, ...(data as Row) })
      }

      // A new driveway: its host by name, and its area, new or existing.
      case 'create_site': {
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
      }

      default:
        return json({ error: 'Unknown action' }, 400)
    }
  } catch (err) {
    console.error(action, err)
    return json({ error: (err as Error).message ?? 'Something went wrong' }, 500)
  }
})
