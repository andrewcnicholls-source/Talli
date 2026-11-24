// =====================================================================
//  Talli Parking — rate us (docs/plans/reviews-and-contact.md, slice 1)
//
//  Two things the homepage form asks for:
//
//    { action: 'options' }   the sites a customer can say they parked at
//    { rating, ... }         a review
//
//  Runs under the service role because the review table has no public
//  policy at all: comments name people and contact details are personal.
//  Every rule about what a review may hold is the database's, in
//  submit_review(); this file only carries the form across.
//
//  A form field no person can see ('website') is the honeypot. A bot that
//  fills it is told thank you and nothing is stored, so it has no reason
//  to try again differently.
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

// The database names its refusals "CODE: what to tell the person".
const named = (err: { message?: string }) => {
  const message = err.message ?? ''
  const m = /^([A-Z_]+):\s*(.+)$/s.exec(message)
  return m ? { error: m[2], code: m[1] } : { error: 'That did not work', code: 'FAILED' }
}

const text = (v: unknown) => (typeof v === 'string' ? v : null)
const yesNo = (v: unknown) => (v === true ? true : v === false ? false : null)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  if (body.action === 'options') {
    const { data, error } = await db.rpc('review_options')
    if (error) {
      console.error('review options failed', error)
      return json({ error: 'Could not load the sites' }, 500)
    }
    return json({ sites: data })
  }

  if (text(body.website)) return json({ ok: true })

  const rating = Number(body.rating)
  if (!Number.isInteger(rating)) {
    return json({ error: 'Choose 1 to 5 stars.', code: 'BAD_RATING' }, 400)
  }

  const site = text(body.property_id)
  if (site && !/^[0-9a-f-]{36}$/i.test(site)) {
    return json({ error: 'That site is not one of ours.', code: 'NO_SITE' }, 400)
  }

  const { data, error } = await db.rpc('submit_review', {
    p_rating: rating,
    p_comment: text(body.comment),
    p_name: text(body.name),
    p_contact: text(body.contact),
    p_property_id: site || null,
    p_easy_to_find: yesNo(body.easy_to_find),
    p_easy_to_leave: yesNo(body.easy_to_leave),
    p_session_id: text(body.session_id),
  })

  if (error) {
    const out = named(error)
    if (out.code === 'FAILED') {
      console.error('review insert failed', error)
      return json({ error: 'Could not send that just then. Try again?' }, 500)
    }
    return json(out, 400)
  }

  return json(data)
})
