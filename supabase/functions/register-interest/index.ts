// =====================================================================
//  Talli Parking — register interest in an event that is not on sale yet
//
//  Some fixtures are known about long before a price exists. Rather than
//  losing those people, take an email against the event so there is a list
//  to mail the day it opens.
//
//  Runs under the service role because event_interest has no public policy:
//  it is a list of customer email addresses and must never be readable from
//  a browser. Asking twice is not an error — it is the same person being
//  keen, and it answers the same way.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  const eventId = String(body.event_id ?? '').trim()
  const email = String(body.email ?? '').trim()
  const name = body.name ? String(body.name).trim().slice(0, 120) : null

  if (!eventId) return json({ error: 'event_id is required' }, 400)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'That email address does not look right' }, 400)
  }
  if (email.length > 254) return json({ error: 'That email address is too long' }, 400)

  // Only take interest in a fixture that is actually listed and still ahead of
  // us. Anything else is either a typo or someone poking at the endpoint.
  const { data: ev, error: evErr } = await db
    .from('event')
    .select('id, name, status, starts_at')
    .eq('id', eventId)
    .maybeSingle()

  if (evErr) return json({ error: 'Could not load that event' }, 500)
  if (!ev) return json({ error: 'No such event' }, 404)
  if (ev.status !== 'announced') {
    return json({ error: 'That event is not taking registrations', code: 'NOT_ANNOUNCED' }, 409)
  }

  const { error } = await db
    .from('event_interest')
    .insert({ event_id: eventId, email, name })

  // 23505 is the one-per-person index doing its job. Already on the list is
  // the outcome they wanted, so say so rather than showing them an error.
  if (error && error.code !== '23505') {
    console.error('interest insert failed', error)
    return json({ error: 'Could not add you to the list just then' }, 500)
  }

  return json({
    ok: true,
    already: error?.code === '23505',
    event_name: ev.name,
  })
})
