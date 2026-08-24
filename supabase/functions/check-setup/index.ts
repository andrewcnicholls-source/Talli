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
//
//  A note on what this screen is FOR. It exists to catch a project that is
//  wired up wrong, so every check here must describe the deployed code as it
//  actually behaves. An earlier version reported an unset SITE_URL on the
//  test project as "correct here — it falls back to talli-test.netlify.app",
//  which was a fallback no function ever had; create-checkout defaulted to
//  production instead and sent paying test customers there. A check that
//  reassures you about the exact fault it exists to find is worse than no
//  check. Assert nothing here that the other functions do not really do.
// =====================================================================

import Stripe from 'https://esm.sh/stripe@18?target=denonext'

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

  // Same rule as gate-ops: no secret, no entry, no quiet default-open state.
  // These two must agree — this screen sits behind the gate screen's unlock,
  // so a passphrase this function accepted but gate-ops did not would leave
  // the configuration screen permanently unreachable.
  const expected = Deno.env.get('GATE_PASSPHRASE')
  if (!expected) {
    console.error('GATE_PASSPHRASE is not set')
    return json({ error: 'The gate screen is not configured yet.' }, 503)
  }

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
      const projectUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/^https?:\/\//, '')
      const list = await stripe.webhookEndpoints.list({ limit: 100 })
      const mine = list.data.filter((e) => (e.url ?? '').includes(WEBHOOK_PATH))
      const ours = projectUrl
        ? mine.filter((e) => (e.url ?? '').includes(projectUrl))
        : []

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
        // Prefer endpoints pointing at THIS project. With a test project and a
        // production project sharing one Stripe account, both appear in this
        // list, and only ours says anything about our configuration.
        const target = ours.length ? ours : mine

        // Duplicates are their own failure. Stripe signs each endpoint's
        // deliveries with that endpoint's own secret, so a second endpoint on
        // the same URL delivers every event twice and only one of the two can
        // ever verify. The other shows up as a run of 400s that looks exactly
        // like a wrong secret.
        if (target.length > 1) {
          checks.push({
            name: 'Only one endpoint for this project',
            ok: false,
            detail:
              `${target.length} endpoints point at this project's webhook. Each has ` +
              `its own signing secret, so every event arrives more than once and all ` +
              `but one delivery fails signature verification. Delete the extras in ` +
              `the Stripe Dashboard, then re-copy the survivor's signing secret.`,
          })
        }

        const ep = target[0]
        const enabled = ep.status === 'enabled'
        const events: string[] = ep.enabled_events ?? []
        const all = events.includes('*')
        const missing = all ? [] : NEEDED_EVENTS.filter((e) => !events.includes(e))

        checks.push({
          name: 'Webhook endpoint in this mode',
          ok: enabled,
          detail: enabled
            ? `Found and enabled, in ${keyMode} mode.` +
              (ours.length ? '' : ' Note: it points at a different Supabase project.')
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
  // create-checkout refuses to run without this — it will not guess a return
  // address, because guessing is what sent test customers to production. So
  // unset is a hard failure on every project, test ones included.
  const siteUrl = (Deno.env.get('SITE_URL') ?? '').trim()
  const extraOrigins = (Deno.env.get('RETURN_ORIGINS') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)

  checks.push({
    name: 'Return address after payment',
    ok: Boolean(siteUrl) && siteUrl.startsWith('https://') && !siteUrl.endsWith('/'),
    detail: !siteUrl
      ? 'Not set. Checkout is switched off until it is: SITE_URL is where Stripe ' +
        'sends the customer after paying, and sending them to the wrong site means ' +
        'their booking cannot be found.'
      : !siteUrl.startsWith('https://')
      ? `Set to ${siteUrl} — must start with https://`
      : siteUrl.endsWith('/')
      ? `Set to ${siteUrl} — remove the trailing slash.`
      : `Set to ${siteUrl}` +
        (extraOrigins.length ? `, also accepting ${extraOrigins.join(', ')}` : ''),
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
