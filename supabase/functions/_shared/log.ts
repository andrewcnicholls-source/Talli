// =====================================================================
//  Talli — how every edge function logs
//
//  One line of JSON per thing that happened, written to the function's
//  log in Supabase (Dashboard → Edge Functions → Logs, or the MCP
//  query_logs tool). Every line carries:
//
//    level   info | warn | error
//    fn      which function wrote it
//    event   what happened, in a few words that stay the same over time
//            so they can be searched for ("hold_booking failed")
//    ref     the request it belongs to — the same short code the caller
//            is shown when something goes wrong, so a screenshot of an
//            error on a phone leads straight to the line that explains it
//
//  and whatever fields were passed with it, scrubbed: anything that looks
//  like a key, token, password or signature is replaced, and email
//  addresses are cut to their first letter and domain. Logs are kept by
//  Supabase and read by people; customers' addresses do not belong there,
//  and a key in a log is a key anybody with dashboard access can copy.
//
//  serve() is the only way a function in this project starts. It gives
//  each request its ref, writes one summary line when the request ends
//  (status and milliseconds), and turns anything a handler throws into a
//  logged error and a plain 500 that carries the ref and nothing else — a
//  database message or a stack trace is never sent to a browser.
//
//  scripts/check.sh holds the rules that keep this true: no console.*
//  outside this file, no Deno.serve outside serve(), no error message
//  copied into a response, and no catch that swallows an error silently.
//  tests/units/edge-logging.test.js proves the scrubbing and the ref.
//
//  Plain, erasable TypeScript on purpose — no enums, no namespaces — so
//  Node can load this file directly for the unit tests.
// =====================================================================

import { AsyncLocalStorage } from 'node:async_hooks'

export type Fields = Record<string, unknown>
type Level = 'info' | 'warn' | 'error'

export interface Log {
  info(event: string, fields?: Fields): void
  warn(event: string, fields?: Fields): void
  error(event: string, fields?: Fields): void
}

interface Scope {
  ref: string
  notes: Fields
}

const scope = new AsyncLocalStorage<Scope>()

// Eight characters is short enough to read off a phone and say out loud,
// and at a few thousand requests a night will not repeat.
export function newRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
}

// The ref of the request this code is running inside, or null outside one
// (module start-up, a test).
export function currentRef(): string | null {
  return scope.getStore()?.ref ?? null
}

// Extra fields for the request's summary line, from anywhere inside it —
// gate-ops names the action this way, so "which action is slow" is a
// question the logs can answer.
export function annotate(fields: Fields): void {
  const s = scope.getStore()
  if (s) Object.assign(s.notes, fields)
}

// ------------------------------------------------------------- scrubbing

const SECRET_KEY = /pass(word)?|secret|token|authori[sz]ation|api_?key|cookie|signature|cvc|card_?number/i

const SECRET_VALUE = new RegExp([
  '\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}', // Stripe keys
  '\\bwhsec_[A-Za-z0-9]{6,}', // Stripe webhook signing secrets
  '\\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{6,}', // Supabase API keys
  '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+', // JWTs
  '\\bBearer\\s+[A-Za-z0-9._-]{8,}',
].join('|'), 'g')

const EMAIL = /([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g

const MAX_STRING = 2000
const MAX_ITEMS = 25
const MAX_DEPTH = 5

export function scrubText(s: string): string {
  const out = s.replace(SECRET_VALUE, '[redacted]').replace(EMAIL, '$1***@$2')
  return out.length > MAX_STRING ? out.slice(0, MAX_STRING) + '…' : out
}

// Errors are plain objects by the time they arrive from supabase-js
// (message, code, details, hint) and class instances from Stripe and from
// throw new Error. Either way the useful parts are named, and the stack is
// cut to where it starts being the runtime's rather than ours.
function errorFields(err: Record<string, unknown>, depth: number): Fields {
  const out: Fields = {}
  for (const k of ['name', 'message', 'code', 'details', 'hint', 'type', 'statusCode', 'requestId', 'status']) {
    if (err[k] !== undefined && err[k] !== null && err[k] !== '') out[k] = clean(err[k], depth + 1)
  }
  if (typeof err.stack === 'string') {
    out.stack = scrubText(err.stack.split('\n').slice(0, 6).join('\n'))
  }
  if (err.cause !== undefined) out.cause = clean(err.cause, depth + 1)
  return out
}

export function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (depth >= MAX_DEPTH) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => clean(v, depth + 1))
    if (value.length > MAX_ITEMS) items.push(`…${value.length - MAX_ITEMS} more`)
    return items
  }
  if (value instanceof Date) return value.toISOString()
  const obj = value as Record<string, unknown>
  if (value instanceof Error ||
      (typeof obj.message === 'string' && (typeof obj.stack === 'string' || obj.code !== undefined))) {
    return errorFields(obj, depth)
  }
  const out: Fields = {}
  let n = 0
  for (const [k, v] of Object.entries(obj)) {
    if (n++ >= MAX_ITEMS) { out['…'] = 'truncated'; break }
    out[k] = SECRET_KEY.test(k) && v ? '[redacted]' : clean(v, depth + 1)
  }
  return out
}

// ----------------------------------------------------------------- write

// Where the lines go. console, in production — the edge runtime ships
// stdout and stderr to the Logs tab, and error/warn keep their level
// there. Swappable so the unit tests can read what was written.
type Sink = (level: Level, line: string) => void

let sink: Sink = (level, line) => {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export function setSink(next: Sink): Sink {
  const prev = sink
  sink = next
  return prev
}

function write(fn: string, level: Level, event: string, fields?: Fields) {
  const line: Fields = { level, fn, event }
  const ref = currentRef()
  if (ref) line.ref = ref
  if (fields) {
    // Field by field: the fields are never themselves an error, even when
    // they happen to have a message and a stack (a browser's report does).
    for (const [k, v] of Object.entries(fields)) {
      if (k in line) continue
      line[k] = SECRET_KEY.test(k) && v ? '[redacted]' : clean(v, 1)
    }
  }
  let text: string
  try {
    text = JSON.stringify(line)
  } catch {
    // Circular, or something JSON cannot hold. The event and the ref are
    // still worth having on their own.
    text = JSON.stringify({ level, fn, event, ref, note: 'fields could not be serialised' })
  }
  sink(level, text)
}

export function logger(fn: string): Log {
  return {
    info: (event, fields) => write(fn, 'info', event, fields),
    warn: (event, fields) => write(fn, 'warn', event, fields),
    error: (event, fields) => write(fn, 'error', event, fields),
  }
}

// ------------------------------------------------- what the caller sees

// The answer to anything that was not expected: no message from the
// database, Stripe or the runtime, just the ref to quote.
export function unexpected(): { error: string; code: 'UNEXPECTED'; ref: string | null } {
  const ref = currentRef()
  return {
    error: ref
      ? `Something went wrong. If it keeps happening, quote reference ${ref}.`
      : 'Something went wrong.',
    code: 'UNEXPECTED',
    ref,
  }
}

// The database raises the errors it means for people to read in one
// shape — 'SOLD_OUT: that tier has gone' — and those are passed through
// so the screen can say what happened. Anything else (a constraint name,
// a type error, a timeout) is logged in full and answered with unexpected().
const NAMED = /^([A-Z][A-Z0-9_]{2,}):/

export function named(
  log: Log,
  err: { message?: string } | null | undefined,
  fields?: Fields,
): { error: string; code: string; ref?: string | null } {
  const message = err?.message ?? ''
  const m = NAMED.exec(message)
  if (m) return { error: message, code: m[1] }
  log.error('unexpected database error', { ...fields, err })
  return unexpected()
}

// ----------------------------------------------------------------- serve

export interface ServeOptions {
  // CORS headers for the 500 that serve() writes itself, so a browser can
  // read it. Functions nothing in a browser calls leave this out.
  cors?: Record<string, string>
}

export type Handler = (req: Request) => Response | Promise<Response>

export function serve(fn: string, handler: Handler, opts: ServeOptions = {}): void {
  const log = logger(fn)
  Deno.serve((req: Request) => handle(fn, log, handler, opts, req))
}

// Separate from serve() so the unit tests can drive it without Deno.
export function handle(
  fn: string,
  log: Log,
  handler: Handler,
  opts: ServeOptions,
  req: Request,
): Promise<Response> {
  // A preflight is the browser asking permission, not a request. Logging
  // each one would double every line and say nothing.
  if (req.method === 'OPTIONS') return Promise.resolve(handler(req))

  const s: Scope = { ref: newRef(), notes: {} }
  const started = Date.now()
  return scope.run(s, async () => {
    let res: Response
    try {
      res = await handler(req)
    } catch (err) {
      log.error('unhandled', { err })
      res = new Response(JSON.stringify(unexpected()), {
        status: 500,
        headers: { ...(opts.cors ?? {}), 'Content-Type': 'application/json' },
      })
    }
    try {
      res.headers.set('x-talli-ref', s.ref)
    } catch {
      // Some responses (a redirect, a fetch passed straight through) have
      // read-only headers. The summary line below still has the ref.
    }
    const level: Level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info'
    write(fn, level, 'request', {
      method: req.method,
      status: res.status,
      ms: Date.now() - started,
      ...s.notes,
    })
    return res
  })
}
