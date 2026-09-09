// =====================================================================
//  Talli Parking — configuration check
//
//  Answers "did I set the secrets up right?" without anyone having to spend
//  money to find out. It reports what is present, asks Stripe whether the
//  key actually works, and checks that a webhook endpoint pointing at this
//  project exists in the SAME mode as the key.
//
//  That last check is the one worth having. A live key paired with a
//  test-mode webhook secret is the failure that looks like success:
//  customers are charged and bookings never confirm.
//
//  Never returns a secret value. Presence, mode and validity only.
//  Passphrase-protected because it describes your payment configuration.
// =====================================================================

import Stripe from 'https://esm.sh/stripe@18?target=denonext'

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

// ---------------------------------------------------------------------
//  TEST-PROJECT FALLBACKS
//
//  The test Supabase project has no secrets of its own, so this block
//  supplies workable defaults there and ONLY there. IS_TEST compares the
//  project's own SUPABASE_URL — injected by Supabase, not settable by a
//  caller — against the test project's ref. On production it is false and
//  every fallback below is unreachable. A real secret always wins: these
//  are fallbacks, never overrides.
// ---------------------------------------------------------------------
const TEST_PROJECT_REF = 'uhdoverwvlxvyyctskle'
const IS_TEST = (Deno.env.get('SUPABASE_URL') ?? '').includes(TEST_PROJECT_REF)

// The hosts assets/talli-config.js hands the PRODUCTION backend. Every other
// host there loads the TEST config. The same list lives in create-checkout,
// which is the function that acts on it; scripts/check.sh keeps them in step.
const PRODUCTION_HOSTS = ['talli.co.nz', 'www.talli.co.nz']

const DEFAULT_SITE_URL = IS_TEST
  ? 'https://staging.talli.pages.dev'
  : 'https://talli.co.nz'

// Same rule as create-checkout's, and it has to stay the same rule: a return
// address is safe only when the site there talks to THIS project. Returns the
// normalised origin, or null when the address does not belong to this project.
function returnBase(candidate: string): string | null {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const isProductionHost = PRODUCTION_HOSTS.includes(host)

  if (!IS_TEST) {
    return url.protocol === 'https:' && isProductionHost ? url.origin : null
  }

  if (isProductionHost) return null
  if (host === 'localhost' || host === '127.0.0.1') return url.origin
  return url.protocol === 'https:' &&
      (host === 'talli.pages.dev' || host.endsWith('.talli.pages.dev'))
    ? url.origin
    : null
}

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

function sameSecret(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

const WEBHOOK_PATH = '/functions/v1/stripe-webhook'

const NEEDED_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const expected = Deno.env.get('GATE_PASSPHRASE') ??
    (IS_TEST ? 'talli-test' : null)
  if (!expected) return json({ error: 'GATE_PASSPHRASE is not set.' }, 503)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }
  if (!sameSecret(String(body.passphrase ?? ''), expected)) {
    return json({ error: 'Wrong passphrase.' }, 401)
  }

  const checks: Array<{ name: string; ok: boolean | null; detail: string }> = []

  // ---------------------------------------------------------- the key
  const key = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const keyMode = key.startsWith('sk_live_')
    ? 'live'
    : key.startsWith('sk_test_')
    ? 'test'
    : key
    ? 'unrecognised'
    : 'missing'

  checks.push({
    name: 'Stripe secret key',
    ok: keyMode === 'live' || keyMode === 'test',
    detail: keyMode === 'missing'
      ? 'Not set. Add STRIPE_SECRET_KEY.'
      : keyMode === 'unrecognised'
      ? 'Set, but does not start with sk_live_ or sk_test_. Check you copied the Secret key, not the Publishable key.'
      : `Set, ${keyMode} mode.`,
  })

  let stripe: Stripe | null = null
  let liveMode: boolean | null = null

  if (keyMode === 'live' || keyMode === 'test') {
    stripe = new Stripe(key)
    try {
      // Cheapest call that proves the key is real and not revoked.
      const balance = await stripe.balance.retrieve()
      liveMode = balance.livemode
      checks.push({
        name: 'Stripe accepts the key',
        ok: true,
        detail: `Yes. Stripe answered in ${balance.livemode ? 'live' : 'test'} mode.`,
      })
    } catch (err) {
      checks.push({
        name: 'Stripe accepts the key',
        ok: false,
        detail: `No. ${(err as Error).message}`,
      })
      stripe = null
    }
  }

  // ------------------------------------------------- the webhook secret
  const whsec = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET') ?? ''
  checks.push({
    name: 'Webhook signing secret',
    ok: whsec.startsWith('whsec_'),
    detail: !whsec
      ? 'Not set. Payments would succeed and bookings would never confirm.'
      : whsec.startsWith('whsec_')
      ? 'Set.'
      : 'Set, but does not start with whsec_. That is probably the wrong value.',
  })

  // --------------------------- is there an endpoint, in this same mode?
  if (stripe) {
    try {
      const list = await stripe.webhookEndpoints.list({ limit: 100 })
      // Annotated because the Stripe types come over the wire from a CDN and
      // the list's element type does not survive the trip. The url is all
      // this reads.
      const mine = list.data.filter((e: { url?: string | null }) =>
        (e.url ?? '').includes(WEBHOOK_PATH))

      if (!mine.length) {
        checks.push({
          name: 'Webhook endpoint in this mode',
          ok: false,
          detail:
            `No endpoint pointing at ${WEBHOOK_PATH} exists in ${keyMode} mode. ` +
            `Your key is ${keyMode} mode, so the endpoint must be too — they are ` +
            `separate worlds. This is the mismatch that charges customers and ` +
            `never confirms their booking.`,
        })
      } else {
        const ep = mine[0]
        const enabled = ep.status === 'enabled'
        const events: string[] = ep.enabled_events ?? []
        const all = events.includes('*')
        const missing = all ? [] : NEEDED_EVENTS.filter((e) => !events.includes(e))

        checks.push({
          name: 'Webhook endpoint in this mode',
          ok: enabled,
          detail: enabled
            ? `Found and enabled, in ${keyMode} mode.`
            : `Found, but its status is "${ep.status}".`,
        })

        checks.push({
          name: 'Webhook is listening for the right events',
          ok: missing.length === 0,
          detail: all
            ? 'Listening to all events, which covers everything needed.'
            : missing.length
            ? `Missing: ${missing.join(', ')}`
            : `All six present.`,
        })
      }
    } catch (err) {
      checks.push({
        name: 'Webhook endpoint in this mode',
        ok: null,
        detail: `Could not check: ${(err as Error).message}`,
      })
    }
  }

  // ------------------------------------------------------------ site url
  // What this check used to do was report the SHAPE of the value — https,
  // no trailing slash — and say nothing about where it pointed. On 8
  // September 2026 production had SITE_URL set to the staging address, and
  // this screen showed a green tick reading "Set to
  // https://staging.talli.pages.dev" while the first real customer was
  // being returned to the test site with an error. A check that passes
  // during the exact failure it exists to catch is worse than no check, so
  // it now judges the host rather than the punctuation.
  //
  // create-checkout now prefers the browser's own Origin over this value,
  // so a wrong SITE_URL can no longer misroute anyone by itself. It is
  // still the fallback for a request that arrives without an Origin, and a
  // fallback pointing at the wrong site is still worth naming.
  const siteUrl = Deno.env.get('SITE_URL') ?? ''
  const resolved = returnBase(siteUrl)
  const where = IS_TEST ? 'test' : 'production'

  checks.push({
    name: 'Return address after payment',
    ok: siteUrl ? resolved !== null : true,
    detail: !siteUrl
      ? `Not set. Customers are returned to the address they started from, ` +
        `falling back to ${DEFAULT_SITE_URL}. That is correct here.`
      : resolved
      ? `Set to ${resolved} — a ${where} address, correct for this project. ` +
        `Used only when a request arrives without an Origin.`
      : `Set to "${siteUrl}", which is NOT a ${where} address. A customer ` +
        `returned there lands on a site wired to the other database, which ` +
        `cannot find the booking they just paid for. Set it to ` +
        `${DEFAULT_SITE_URL} or remove it.`,
  })

  const failures = checks.filter((c) => c.ok === false).length
  const unknown = checks.filter((c) => c.ok === null).length

  return json({
    mode: keyMode,
    live: liveMode,
    checks,
    ready: failures === 0,
    summary: failures === 0 && unknown === 0
      ? `Everything checks out. You are in ${keyMode} mode.`
      : failures === 0
      ? `No problems found, but ${unknown} check could not run.`
      : `${failures} problem${failures === 1 ? '' : 's'} to fix.`,
  })
})
