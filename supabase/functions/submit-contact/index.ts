// =====================================================================
//  Talli Parking — contact us (docs/plans/reviews-and-contact.md, slice 2)
//
//  The homepage "Get in touch" form. The message is stored first, by
//  submit_contact(), which holds every rule about what a message may
//  be. Then it is emailed to bookings@ with Reply-To set to the sender,
//  so answering is just replying.
//
//  Stored first on purpose: if the email fails, the message is still on
//  the gate screen's Insights tab, and the person is still told it
//  arrived, because it did. With no RESEND_API_KEY (the test project)
//  the email step is skipped and the message waits on Insights.
//
//  A form field no person can see ('website') is the honeypot. A bot
//  that fills it is told thank you and nothing is stored or sent.
// =====================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2.119.0'
import { logger, serve } from '../_shared/log.ts'

const log = logger('submit-contact')

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'
const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const FROM_EMAIL = Deno.env.get('TALLI_FROM_EMAIL') ??
  'Talli Parking <bookings@talli.co.nz>'
// Where messages go: the same inbox the site tells people to write to.
const INBOX = Deno.env.get('TALLI_REPLY_TO') ?? 'bookings@talli.co.nz'

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
  const m = /^([A-Z_]+):\s*(.+)$/s.exec(err.message ?? '')
  return m ? { error: m[2], code: m[1] } : null
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

type Message = { id: string; name: string; email: string; phone: string; message: string }

async function emailIt(m: Message): Promise<void> {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) {
    log.info('no RESEND_API_KEY on this project; message waits on Insights', { id: m.id })
    return
  }
  const who = m.name || m.email || m.phone
  const body = [
    m.message,
    '',
    '—',
    `From: ${m.name || '(no name)'}`,
    `Email: ${m.email || '(none)'}`,
    `Phone: ${m.phone || '(none)'}`,
    '',
    'Sent from the contact form on talli.co.nz. Also on the gate screen, Insights tab.',
  ].join('\n')

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [INBOX],
      // No email given: replying would go to ourselves, so leave it out
      // and the phone number in the body is how to answer.
      ...(m.email ? { reply_to: m.email } : {}),
      subject: `Website message from ${who}`,
      text: body,
    }),
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    log.error('contact email failed', { id: m.id, status: res.status, detail })
    return
  }
  const { error } = await db.rpc('contact_emailed', { p_id: m.id })
  if (error) log.warn('could not record contact email as sent', { id: m.id, err: error })
}

serve('submit-contact', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    // not logged: the 400 is the answer, and the request line records it
    return json({ error: 'Body must be JSON' }, 400)
  }

  if (text(body.website)) return json({ ok: true })

  const m = {
    name: text(body.name),
    email: text(body.email),
    phone: text(body.phone),
    message: text(body.message),
  }

  const { data, error } = await db.rpc('submit_contact', {
    p_message: m.message,
    p_name: m.name || null,
    p_email: m.email || null,
    p_phone: m.phone || null,
  })
  if (error) {
    const out = named(error)
    if (out) return json(out, 400)
    log.error('contact insert failed', { err: error })
    return json({ error: 'Could not send that just then. Try again, or email bookings@talli.co.nz.' }, 500)
  }

  const id = String((data as Record<string, unknown>).id)
  try {
    await emailIt({ id, ...m })
  } catch (err) {
    // The message is stored and shows on Insights; the sender is told it
    // arrived, because it did. The failed email is for us to see.
    log.error('contact email threw', { id, err })
  }

  return json({ ok: true })
}, { cors })
