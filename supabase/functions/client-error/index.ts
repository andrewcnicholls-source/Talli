// =====================================================================
//  Talli Parking — errors from people's browsers
//
//  A customer's phone that cannot finish a booking, or a warden's screen
//  that throws at the gate, used to leave no trace anywhere: the error
//  happened on a device nobody here could see. assets/talli-errors.js
//  catches what the page did not and sends it here, and this function
//  writes it to the log beside the server's own lines, with the ref of
//  any server request it was about.
//
//  It stores nothing and answers nothing useful, on purpose. Anyone with
//  the published anon key can call it, so everything it accepts is cut to
//  size, scrubbed by the logger like every other line, and never read back
//  by anything. The page sends at most a handful per load.
// =====================================================================

import { logger, serve } from '../_shared/log.ts'

const log = logger('client-error')

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const done = (status = 204) => new Response(null, { status, headers: cors })

// Bigger than any real report; a body past this is not one.
const MAX_BODY = 16 * 1024

const text = (v: unknown, max: number): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : String(v).slice(0, max)

// A page address without its query or fragment: booking-confirmed.html
// carries the Checkout Session id there, and that is nobody's business.
const pathOnly = (v: unknown): string | undefined => {
  const s = text(v, 500)
  if (!s) return undefined
  try {
    const u = new URL(s, 'https://talli.invalid')
    return u.host === 'talli.invalid' ? u.pathname : u.origin + u.pathname
  } catch {
    // not logged: a malformed page address is dropped, not worth a line
    return undefined
  }
}

serve('client-error', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return done(405)

  const raw = await req.text()
  if (raw.length > MAX_BODY) return done(413)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    // not logged: the 400 is the answer, and the request line records it
    return done(400)
  }
  if (!body || typeof body !== 'object') return done(400)

  log.warn('browser error', {
    kind: text(body.kind, 40),
    message: text(body.message, 500),
    page: pathOnly(body.page),
    source: pathOnly(body.source),
    line: Number(body.line) || undefined,
    col: Number(body.col) || undefined,
    stack: text(body.stack, 1500),
    // The ref of the server request this was about, when there was one.
    server_ref: text(body.ref, 16),
    status: Number(body.status) || undefined,
    context: text(body.context, 200),
    environment: text(body.environment, 20),
    user_agent: text(req.headers.get('user-agent'), 200),
  })
  return done()
}, { cors })
