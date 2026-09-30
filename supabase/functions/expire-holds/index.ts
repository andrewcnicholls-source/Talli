// =====================================================================
//  Talli Parking — shut off checkouts whose pay window has closed
//
//  Inside the last few hours before kickoff a bay is held for only ten
//  minutes. Stripe will not create a Checkout Session that expires sooner
//  than thirty, so there the session outlives the hold and has to be
//  killed by hand. That is this function's whole job.
//
//  It is therefore idle most of the time, and deliberately so. A booking
//  made further out carries no checkout_expires_at at all: its session is
//  allowed to die of old age inside a longer hold, exactly as it always
//  has. Only the crunch rows are this function's business, and the query
//  below sees nothing else.
//
//  It runs every minute and, for every held booking past its
//  checkout_expires_at, calls sessions.expire(). It does NOT touch the
//  booking row. Stripe answers the expiry with a checkout.session.expired
//  webhook, and stripe-webhook already knows what to do with one —
//  release_booking(expired), bay back on sale. One path in, one path out;
//  a sweep that wrote booking rows directly would be a second way for a
//  bay to change hands, racing the first.
//
//  Missing a run is survivable and deliberately so. The bay still comes
//  back on sale by the clock at hold_expires_at, and confirm_booking
//  refuses a hold that has run out, so a late payment is refused and
//  flagged rather than quietly sold on top of somebody else. Late is a
//  refund. Absent would have been two cars and one space.
//
//  Scheduling lives outside this file — pg_cron on each project, per
//  DEPLOYMENT.md. Nothing here assumes it is called on time.
// =====================================================================

import Stripe from 'https://esm.sh/stripe@18?target=denonext'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  SERVICE_KEY,
  { auth: { persistSession: false } },
)

// No CORS block and no origin header. Nothing in a browser calls this.

// How many to shut off in one pass. A minute's worth of abandoned
// checkouts is single digits; the cap is here so a backlog after an
// outage drains over several runs instead of timing out on the first.
const BATCH = 200

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// Length-independent compare. The secret being checked is the service-role
// key, so a timing oracle here would leak the keys to everything.
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

Deno.serve(async (req) => {
  // ---- Who is allowed to call this.
  //
  // verify_jwt is not enough on its own: the anon key satisfies it and the
  // anon key is published in assets/talli-config.js for every browser to
  // read. The caller has to present the service-role key, which only the
  // scheduler holds.
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!SERVICE_KEY || !bearer || !sameSecret(bearer, SERVICE_KEY)) {
    return json({ error: 'Not for you' }, 401)
  }

  // ---- Stripe. Without a key there is nothing to expire; the test
  // project's stubbed payments never create a session in the first place,
  // so an empty sweep there is the correct answer, not a fault.
  const key = Deno.env.get('STRIPE_SECRET_KEY')
  if (!key) return json({ expired: 0, note: 'no Stripe key on this project' })
  const stripe = new Stripe(key)

  const { data: stale, error } = await db.from('booking')
    .select('id, stripe_checkout_session_id')
    .eq('status', 'held')
    .not('stripe_checkout_session_id', 'is', null)
    .lt('checkout_expires_at', new Date().toISOString())
    .limit(BATCH)

  if (error) {
    console.error('could not read stale holds', error)
    return json({ error: 'could not read stale holds' }, 500)
  }
  if (!stale?.length) return json({ expired: 0 })

  let expired = 0
  let alreadyDone = 0
  const failures: string[] = []

  for (const row of stale) {
    const sessionId = String(row.stripe_checkout_session_id)

    // Stubbed test sessions were never Stripe's. Asking Stripe about one
    // is a guaranteed 404, so don't.
    if (sessionId.startsWith('cs_test_stub_')) continue

    try {
      await stripe.checkout.sessions.expire(sessionId)
      expired++
    } catch (err) {
      // Stripe refuses to expire a session that is not open. Two ways to
      // get here and they mean opposite things:
      //
      //   complete  — the customer paid inside the window and the webhook
      //               is mid-flight or already done. Leave it alone.
      //   expired   — a previous run already got it, and the webhook that
      //               should have cleared the row has not landed yet.
      //
      // Neither is this function's problem, and neither is worth waking
      // anyone for. The row is left exactly as it is; confirm_booking and
      // the hold's own clock decide what it becomes.
      const msg = (err as { message?: string })?.message ?? String(err)
      if (/only expire a session .* open|No such checkout.session/i.test(msg)) {
        alreadyDone++
        continue
      }
      console.error('could not expire session', sessionId, msg)
      failures.push(sessionId)
    }
  }

  // Logged every run, because silence from a sweep is indistinguishable
  // from a sweep that is not running at all.
  console.log(
    `expire-holds: ${stale.length} stale, ${expired} expired, ` +
    `${alreadyDone} already closed, ${failures.length} failed`,
  )

  return json({ examined: stale.length, expired, alreadyDone, failed: failures.length })
})
