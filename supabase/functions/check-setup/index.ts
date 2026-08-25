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
      const mine = list.data.filter((e) => (e.url ?? '').includes(WEBHOOK_PATH))

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
  // Unset is a genuine problem on production, where the return address should
  // never be left to a default. On the test project it is the intended state:
  // the fallback sits beside every other test fallback and is correct. Failing
  // it there leaves this screen permanently showing one red line, which is the
  // quickest way to teach someone to stop reading red lines — and the one
  // thing this screen must catch is a live key on the test site.
  const siteUrl = Deno.env.get('SITE_URL') ?? ''
  checks.push({
    name: 'Return address after payment',
    ok: siteUrl
      ? siteUrl.startsWith('https://') && !siteUrl.endsWith('/')
      : IS_TEST,
    detail: !siteUrl
      ? (IS_TEST
        ? 'Not set, which is correct here — the test project falls back to https://talli-test.netlify.app.'
        : 'Not set. Defaults to https://talli.co.nz, which happens to be right — but set it explicitly.')
      : siteUrl.endsWith('/')
      ? `Set to ${siteUrl} — remove the trailing slash.`
      : `Set to ${siteUrl}`,
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
