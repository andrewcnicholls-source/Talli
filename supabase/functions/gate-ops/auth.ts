// gate-ops: who is asking. index.ts runs callerFrom and the checks after
// it on every request, before any handler; nothing in handlers/ repeats
// or skips them.

import { db, type Row } from './shared.ts'

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
export type Caller = {
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

export type Denied = { status: number; error: string; code: string }

export async function callerFrom(req: Request): Promise<Caller | Denied> {
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
export async function allowedProperties(c: Caller): Promise<Set<string> | null> {
  if (c.all) return null
  const { data, error } = await db.from('property').select('id').in('block_id', c.blocks)
  if (error) throw error
  return new Set(((data ?? []) as Row[]).map((r) => String(r.id)))
}

// A warden may touch a booking that is, or was booked, at one of their
// sites, on the live night (plan B2). With no night live a warden touches
// nothing. The operator (allowed === null) may touch any booking.
export async function mayTouchBooking(
  allowed: Set<string> | null, bookingId: string, liveId: string | null,
) {
  if (allowed === null) return true
  if (liveId === null) return false
  const { data, error } = await db.from('booking')
    .select('event_id, property_id, booked_property_id').eq('id', bookingId).maybeSingle()
  if (error) throw error
  if (!data) return false
  if (String(data.event_id) !== liveId) return false
  return allowed.has(String(data.property_id)) ||
    (data.booked_property_id !== null && allowed.has(String(data.booked_property_id)))
}

// Arrivals actions that work on a night (plan B2). index.ts resolves the
// live event for each: a warden cannot name another, and the operator's
// Arrivals names none. The operator may still name any night, which is
// how Tonight and Insights read the rest.
export const LIVE_SCOPED = new Set(['list', 'tiers', 'sell', 'lose_space'])

// The night's prices, capacity, templates and event set-up are Andrew's.
// A warden works the gate: check-in, walk-ups, fixing a booking.
export const OPERATOR_ONLY = new Set([
  'event_form', 'create_event', 'save_template', 'set_event_status',
  'set_capacity', 'set_price', 'apply_price_template', 'set_reserve',
  'set_offer_status', 'site_options', 'add_offer',
  'sites_setup', 'save_site', 'create_site', 'save_ring_pricing', 'set_block_ring',
  'save_site_details', 'add_site', 'set_block_anchor', 'set_site_nights', 'save_site_night',
  'series_list', 'save_series', 'set_event_series', 'upload_picture',
  'set_live_event',
  'save_place_slug', 'upload_site_picture', 'save_site_picture', 'remove_site_picture',
  // Settlement (plan B7): money owed to hosts and wardens is Andrew's.
  'settlement', 'save_warden_allocation', 'settle_night', 'reopen_settlement',
  'save_settlement_setting', 'save_host_details',
  // Who may work the gate (plan B8). A warden changing wardens, their own
  // areas included, would undo the whole scope check.
  'staff_list', 'invite_warden', 'set_warden_block', 'set_warden_active',
])

export const denied = (c: Caller | Denied): c is Denied =>
  typeof (c as Denied).status === 'number'


// What every handler is given. Built in index.ts, after the three sign-in
// checks have passed, and only there: a handler never sees the request, so
// it cannot reach the body before the caller has been resolved.
export type Ctx = {
  caller: Caller
  body: Record<string, unknown>
  eventId: string
  allowed: Set<string> | null
  bookingGuard: () => Promise<Response | null>
  // The night the gate is working, or null (plan B2).
  live: Row | null
}

export type Handler = (ctx: Ctx) => Promise<Response>
