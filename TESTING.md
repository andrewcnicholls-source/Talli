# Talli — test environment

There are now two of everything. This file is the map.

|                | **Production**                      | **Test**                                 |
| -------------- | ----------------------------------- | ---------------------------------------- |
| Site           | https://talli.co.nz                 | https://talli-test.netlify.app           |
| Netlify project| `talliconz`                         | `talli-test`                             |
| Git branch     | `main`                              | `staging`                                |
| Supabase       | `oxzwfemyavznykqixhvk`              | `uhdoverwvlxvyyctskle`                   |
| Stripe         | live keys                           | none yet — payments are faked            |
| Fixtures       | real                                | five, all named `TEST — …`               |
| Customer data  | real people                         | none, ever                               |

They share nothing. Different database, different keys, different money.
Breaking the test site cannot touch a real booking.

---

## Before anything works: one thing only you can do

I could not link a GitHub repository to a Netlify project through the API,
so this last step is yours. It takes about two minutes.

All of this work is on the branch `claude/test-environment-setup-kaaudq`.
The test site is meant to deploy from `staging`, so create that first:

```bash
git fetch origin
git checkout -b staging origin/claude/test-environment-setup-kaaudq
git push -u origin staging
```

(If you would rather look at it before creating another branch, just put
`claude/test-environment-setup-kaaudq` in step 4 instead and rename later.)

Then, in Netlify:

1. Open https://app.netlify.com/projects/talli-test
2. **Project configuration → Build & deploy → Link repository**
3. Choose `andrewcnicholls-source/Talli`
4. Set **Branch to deploy** to `staging`
5. Leave build command and publish directory blank — `netlify.toml` sets them
6. **Deploy**

That is it. Everything else below is already built and tested.

---

## How you work now

```
       you edit here                    you merge here
            │                                 │
         staging  ──────────────────────────► main
            │                                 │
   talli-test.netlify.app              talli.co.nz
   (fake fixtures, fake money)         (real customers)
```

Day to day:

```bash
git checkout staging
# ...make your change...
git commit -am "Try a new price ladder"
git push origin staging          # test site rebuilds in ~30s
```

Look at it. Poke it. When you're happy:

```bash
git checkout main
git merge staging
git push origin main             # now it's live
```

If you hate it, `git checkout staging && git reset --hard main` and start
again. Nothing you did was ever visible to a customer.

---

## Which environment am I looking at?

You will not have to wonder.

- Every test page carries a **red bar** across the top: *TEST SITE — fake
  fixtures, not the live booking page*.
- The **gate screen goes red** in test. Blue chrome means you are on the
  live site taking real money; red chrome means you are not. That colour
  is the thing to trust at 9pm in the rain with one hand free.
- Every test fixture is named `TEST — something`.

The switch is by hostname, in `assets/talli-config.js`. Only `talli.co.nz`,
`www.talli.co.nz` and `talliconz.netlify.app` count as production. Anything
else — previews, `localhost`, a URL nobody anticipated — falls to **test**.
The default points away from real customer data on purpose.

---

## Passphrases

| Where | Passphrase | Enforced |
| --- | --- | --- |
| Test site front door | `talli-test` | in the browser |
| Test gate screen (`/admin.html`) | `talli-test` | server-side |
| Live gate screen | unchanged | server-side |

**Be honest with yourself about the first one.** It is in `assets/talli-testgate.js`,
which anyone can read. It exists to keep the test site out of Google and to
stop a confused customer booking a fixture that does not exist — not to keep
a determined person out. That is fine, because the test database holds no
customer data and every write is still guarded server-side.

If you ever want real protection there, Netlify's own password feature does
it at the edge. I tried to enable it and their API refused (`422`) — it needs
a paid plan. If you upgrade, turn it on under *Access & security* and delete
`assets/talli-testgate.js`.

The gate screen passphrase on the test project is a fallback baked into the
function, used only because the test project has no secrets set. Set
`GATE_PASSPHRASE` in the test project's Edge Function secrets and it wins
immediately.

---

## Payments on the test site

Right now the test site **fakes the payment**. Book a bay and you go straight
to the confirmation page with a real booking, a real bay allocation and a
reference — no card, no Stripe. Fake sessions are recognisable: they start
`cs_test_stub_`.

That means the whole booking flow is testable tonight, without you doing
anything.

### When you want to rehearse the real Stripe checkout

1. Stripe Dashboard → toggle **Test mode** → *Developers → API keys*
2. Copy the **Secret key** (`sk_test_…`)
3. Supabase → `talli-test` project → *Edge Functions → Secrets*
4. Add `STRIPE_SECRET_KEY` = the `sk_test_…` key

The moment that key exists, the stub switches itself off and the test site
uses the real Stripe checkout in test mode. Card `4242 4242 4242 4242`, any
future expiry, any CVC.

For webhooks to confirm bookings, also add a **test-mode** webhook endpoint
in Stripe pointing at:

```
https://uhdoverwvlxvyyctskle.supabase.co/functions/v1/stripe-webhook
```

listening for `checkout.session.completed`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`charge.refunded`, `charge.dispute.created` — then put its signing secret in
`STRIPE_WEBHOOK_SIGNING_SECRET`.

Then open the test gate screen and tap **Check payment setup**. It will tell
you in plain words whether the key and the webhook are in the same mode. A
live key with a test webhook is the failure that looks like success, and that
button exists to catch it.

---

## The test fixtures

Five, chosen to cover the states worth rehearsing:

| Fixture | Why it's there |
| --- | --- |
| `TEST — Tomorrow Night (on sale)` | the ordinary happy path |
| `TEST — Next Week (on sale)` | so the picker has a real choice |
| `TEST — Online Sales Closed (gate only)` | proves online shuts off and the gate takes over |
| `TEST — Announced, No Prices Yet` | the register-interest capture |
| `TEST — Draft, Hidden From Public` | must be invisible to the public key |

Property, zones, all 36 bays and the pricing ladder are copied exactly from
production. Only the fixtures are invented.

### Resetting the test data

Dates go stale and test bookings pile up. To wipe the bookings and re-anchor
every fixture to today, run `supabase/test-only/reset-test-data.sql` against
the **test** project (Supabase → SQL Editor). It is re-runnable and safe to
run as often as you like.

It lives outside `supabase/migrations/` deliberately, so `supabase db push`
can never carry it to the live site.

---

## Your backend is now in git

It wasn't before. This was the real find while building the test
environment: **all 18 database migrations and all 6 edge functions existed
only inside Supabase.** There was no copy anywhere. If that project had been
lost, the site was not rebuildable.

They are now in:

```
supabase/migrations/      18 files, the full schema history
supabase/functions/       create-checkout, stripe-webhook, gate-ops,
                          get-booking, register-interest, check-setup
supabase/test-only/       the test-data reset script (never runs on prod)
```

Verified, not assumed: the test database was rebuilt from those files alone,
and every one of columns, function bodies, RLS policies, indexes,
constraints, view definitions and grants hashes **identical** to production.
Three of the six functions deployed to a byte-identical bundle hash.

---

## Adding a real fixture to the test site

Nothing stops you. Use the `TEST — ` prefix so it stays obvious:

```sql
insert into event (name, starts_at, demand_tier, status)
values ('TEST — Blues v Crusaders', '2026-09-19 19:05:00+12', 'high', 'on_sale');

insert into event_offer (event_id, property_id)
select id, '22222222-2222-2222-2222-222222222222'
from event where name = 'TEST — Blues v Crusaders';
```

Tiers are per-offer; copy the pattern in
`supabase/migrations/20260814125456_talli_exit_axis_functions_and_tiers.sql`.

---

## One change that touches production

`netlify.toml` is new, and Netlify reads it from **whichever branch it
builds** — so the live site sees it too.

It is written to do nothing on production. The build command checks
`SITE_NAME` and exits immediately unless it is the test project; only the
test site gets a `robots.txt` and a `noindex` header. Production publishes
byte-for-byte what is in the repo, exactly as before.

I verified both paths locally, but I could not test a real production deploy
without deploying to production, which I wasn't going to do while you slept.
**On your next merge to `main`, just confirm talli.co.nz still loads.** If
anything looks wrong, deleting `netlify.toml` restores the previous
behaviour completely.

---

## What I could not do

- **Link the Netlify project to the repo** — no API for it. See the top.
- **Set Supabase secrets** — the tooling has no secrets API. Handled with
  test-project-only fallbacks in the functions, keyed on the project ref, so
  they are unreachable on production. Setting a real secret always wins.
- **Enable Netlify password protection** — their API returned `422`; it needs
  a paid plan.
- **Point `test.talli.co.nz` at the test site** — needs a DNS record only you
  can add. Say the word and I'll do the Netlify side.
