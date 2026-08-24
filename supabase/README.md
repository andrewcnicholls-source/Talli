# Talli Parking — edge functions

These functions used to live only in the Supabase dashboard. They are checked in
here so a change can be reviewed and so the two projects can be compared.

## The two projects

| | Supabase ref | Site |
|---|---|---|
| Production | `oxzwfemyavznykqixhvk` | https://talli.co.nz |
| Test | `uhdoverwvlxvyyctskle` | https://talli-test.netlify.app |

They share one Stripe account, which is the thing to keep in mind whenever
something looks wrong: both projects' webhook endpoints receive every test-mode
event, so an event failing on one project may simply belong to the other.

## Secrets

Set per project with `supabase secrets set NAME=value --project-ref <ref>`.

| Secret | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | `sk_test_…` on the test project, `sk_live_…` on production. |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | yes | `whsec_…`, copied from **this project's own** endpoint. Each endpoint has a different one. |
| `SITE_URL` | yes | Where Stripe returns the customer. No trailing slash. **Checkout refuses to run without it** — see below. |
| `RETURN_ORIGINS` | no | Extra comma-separated origins to accept, for branch deploys. |
| `GATE_PASSPHRASE` | yes | Unlocks the gate screen. `gate-ops` and `check-setup` both require it. |
| `ALLOWED_ORIGIN` | no | CORS origin. Defaults to `*`. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.

### Why `SITE_URL` has no default

It used to default to `https://talli.co.nz`. The test project never set it, so
test checkouts sent paying customers to production, where their booking does not
exist and the confirmation page shows an error. Nothing looked broken until
after the money moved.

`create-checkout` now refuses to start a checkout rather than guess a return
address, and it fails *before* holding a bay so a misconfigured project cannot
strand holds. The browser already handles that response — `booking.js` treats
`NOT_CONFIGURED` / 503 as "card payment isn't switched on yet" and points the
customer at email.

**Consequence: set `SITE_URL` on a project before deploying `create-checkout` to
it, or online booking stops.**

## Deploying

```bash
supabase functions deploy create-checkout --project-ref uhdoverwvlxvyyctskle
```

Deploy to the test project and exercise a real checkout there before touching
production.

## Checking configuration

The gate screen's setup panel (`admin.html`, behind the passphrase) calls
`check-setup`, which reports what is set, asks Stripe whether the key works, and
looks for duplicate webhook endpoints. It reports only presence, mode and
validity — never a secret's value.

It is deliberately literal about what the deployed code does. An earlier version
claimed the test project "falls back to talli-test.netlify.app" when `SITE_URL`
was unset — a fallback no function ever had — and so showed a green tick on
exactly the misconfiguration it exists to catch.
