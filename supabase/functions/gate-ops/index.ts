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


// The code is split by area, one file per part of the gate screen, so
// that work on one does not collide with work on another:
//
//   auth.ts             who is asking — the three checks, and OPERATOR_ONLY
//   shared.ts           the client, Stripe, json() and shared helpers
//   night.ts            the whole night in one read
//   handlers/arrivals   working the gate (wardens too)
//   handlers/events     making and running an event (Andrew)
//   handlers/sites      sites, blocks and the bank details
//
// Every action goes through the one Deno.serve below. A handler is only
// ever called from it, after the caller has been resolved and checked.

import { allowedProperties, type Caller, callerFrom, type Denied, denied, type Handler, LIVE_SCOPED, mayTouchBooking, OPERATOR_ONLY } from './auth.ts'
import { cors, json, liveEvent } from './shared.ts'
import { arrivals } from './handlers/arrivals.ts'
import { events } from './handlers/events.ts'
import { sites } from './handlers/sites.ts'

const handlers: Record<string, Handler> = { ...arrivals, ...events, ...sites }

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
  let eventId = String(body.event_id ?? '')

  if (!caller.all && OPERATOR_ONLY.has(action)) {
    return json({ error: 'Only Andrew can change that.', code: 'OPERATOR_ONLY' }, 403)
  }

  try {
    const allowed = await allowedProperties(caller)
    const live = await liveEvent()
    const liveId = live ? String(live.id) : null

    // One night at the gate (plan B2). An Arrivals action works on the
    // live event, resolved here, never on one the request names: a warden
    // who sends another is refused, and one who sends none is given the
    // live one. The operator may name any night (Tonight, Insights); the
    // operator's Arrivals names none and gets the live one too.
    if (LIVE_SCOPED.has(action) && (!caller.all || !eventId)) {
      if (!liveId) {
        return json({ error: 'No event is live at the gate.', code: 'NO_LIVE_EVENT' }, 409)
      }
      if (eventId && eventId !== liveId) {
        return json({ error: 'That is not the live event any more. Refresh.',
          code: 'NOT_LIVE_EVENT' }, 409)
      }
      eventId = liveId
    }

    const bookingGuard = async () => {
      const id = String(body.booking_id ?? '')
      if (!id) return json({ error: 'booking_id is required' }, 400)
      if (!(await mayTouchBooking(allowed, id, liveId))) {
        return json({ error: 'That booking is not at one of your sites tonight.',
          code: 'NOT_YOUR_SITE' }, 403)
      }
      return null
    }

    // Own keys only: an action named after something every object inherits
    // ('constructor', 'toString') is unknown, exactly as the switch it
    // replaced treated it.
    const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined
    if (!handler) return json({ error: 'Unknown action' }, 400)
    // Awaited here, inside the try, so a handler that throws is answered
    // by the catch below rather than escaping it.
    return await handler({ caller, body, eventId, allowed, bookingGuard, live })
  } catch (err) {
    console.error(action, err)
    return json({ error: (err as Error).message ?? 'Something went wrong' }, 500)
  }
})
