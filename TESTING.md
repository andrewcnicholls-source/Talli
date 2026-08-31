# Talli — test environment

There are now two of everything. This file is the map of what is *in*
each environment. `DEPLOYMENT.md` is the map of how code *moves*
between them.

|                | **Production**                      | **Test**                                 |
| -------------- | ----------------------------------- | ---------------------------------------- |
| Site           | https://talli.co.nz                 | https://staging.talli.pages.dev          |
| Cloudflare Pages| production branch                  | preview branch                           |
| Git branch     | `main`                              | `staging`                                |
| Supabase       | `oxzwfemyavznykqixhvk`              | `uhdoverwvlxvyyctskle`                   |
| Stripe         | live keys                           | test-mode keys — real Stripe, fake money |
| Fixtures       | real                                | five, all named `TEST — …`               |
| Customer data  | real people                         | none, ever                               |

They share nothing. Different database, different keys, different money.
Breaking the test site cannot touch a real booking.

---

## Hosting

Both environments are one Cloudflare Pages project, `talli`. `main` is
its production branch and `staging` is its only enabled preview branch,
which gets the stable alias `staging.talli.pages.dev`.

Feature branches are deliberately not built. Every branch build costs
against the monthly quota — the constraint that moved this project off
Netlify in the first place — and each one would publish another
un-gated copy of the booking page.

Cloudflare records the commit for every deployment, so "which code am I
looking at?" is always answerable — see `DEPLOYMENT.md`, question 4. A
deployment uploaded from a working copy rather than built from git has
no commit attached, and `/release-production` refuses to promote one, on
purpose.

## How you work now

```
       agents work here                 you merge here            you promote here
             │                                │                          │
   feature/x ─PR─CI──────────────────────► staging ──────────────────► main
                                              │                          │
                                  staging.talli.pages.dev        talli.co.nz
                                   (fake fixtures, fake money)    (real customers)
                                              │                          ▲
                                              └──── device testing ──────┘
```

`DEPLOYMENT.md` is the full account. The four skills:

```
/new-agent booking-cancellation   isolated worktree + feature branch
/finish-agent                     validate, commit, push, draft the PR
/cleanup-agent                    remove the worktree when it's merged
/release-production               promote the tested commit to talli.co.nz
```

By hand, without agents, it is the same three moves:

```bash
git switch -c feature/price-ladder origin/staging
# ...make your change...
bash scripts/check.sh
git commit -am "Try a new price ladder"
git push -u origin feature/price-ladder
# open a PR against staging, let CI run, merge
# test site rebuilds in ~30s
```

Look at it. Poke it on a phone. When you're happy, `/release-production`
— or by hand, the same fast-forward it would do:

```bash
git push origin origin/staging:refs/heads/main    # now it's live
```

If you hate it, close the PR. Nothing you did was ever visible to a
customer.

**Two things not to do.** Don't commit straight to `staging` while an
agent has a branch in flight, and don't push a feature branch to
`staging` to have a look — that overwrites whatever is being tested on
a phone at that moment.

## Which environment am I looking at?

You will not have to wonder.

- Every test page carries a **red bar** across the top: *TEST SITE — fake
  fixtures, not the live booking page*.
- The **gate screen goes red** in test. Blue chrome means you are on the
  live site taking real money; red chrome means you are not. That colour
  is the thing to trust at 9pm in the rain with one hand free.
- Every test fixture is named `TEST — something`.

The switch is by hostname, in `assets/talli-config.js`. Only `talli.co.nz`,
and `www.talli.co.nz` count as production. Anything
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

If you ever want real protection there, Cloudflare Access does it at the
edge, before a byte of HTML is served, and it is free at this scale —
which the Netlify equivalent was not. Zero Trust → Access → Applications,
pointed at the staging hostname, then delete `assets/talli-testgate.js`.

The gate screen passphrase on the test project is a fallback baked into the
function, used only because the test project has no secrets set. Set
`GATE_PASSPHRASE` in the test project's Edge Function secrets and it wins
immediately.

### If the gate screen rejects a passphrase you know is right

This happened on the first attempt, and it will happen again on a matchday if
you do not know the trick. The field is an ordinary password input, so the
browser will autofill a saved password into it — and every value looks like
dots, so a wrong one looks exactly like the right one. You get
`Wrong passphrase.` with nothing to suggest what went in.

Open a private window and type it by hand. That clears autofill, a cached
`admin.js`, and any stale `sessionStorage` in one go. If it works there, the
passphrase was never wrong — delete the saved password for the site and it
will stop.

Worth knowing before you are standing on the driveway with cars queuing.
The same trap exists on the live gate screen.

---

## Payments on the test site

**Stripe test mode is connected and working.** A booking on the test site
goes through the real Stripe checkout, Stripe calls the webhook back, and the
booking confirms — verified end to end on 21 Aug. Card `4242 4242 4242 4242`,
any future expiry, any CVC. No real money moves.

If `STRIPE_SECRET_KEY` is ever removed from the test project, the code falls
back to **faking** the payment rather than breaking: you go straight to the
confirmation page with a real booking and a real bay allocation, no card
involved. Fake sessions are recognisable — they start `cs_test_stub_`, where
real test ones are just `cs_test_`.

### How the Stripe keys got there, if it ever needs redoing

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

### The card surcharge

The price on the sign is the **cash** price. Paying by card adds a percentage
on top, itemised rather than folded in. One row holds the rate:

```sql
-- read it
select card_surcharge_bps from payment_setting;   -- 200 = 2.00%

-- change it (test project only; production is a deliberate step)
update payment_setting set card_surcharge_bps = 250, updated_at = now();
```

`stripe` and `tap_to_pay` attract it. `cash`, `bank_transfer`, `free` and
`other` do not, so a cash walk-up still hands over exactly what the sign says.
Set it to `0` and every surcharge line disappears from both the booking page
and the gate screen.

What to check on the test site:

- **Website** — the summary at *Your details* itemises the surcharge and shows
  a total above the sign price, and the Stripe page shows the same three
  lines. The amount Stripe charges is the total on the page.
- **Gate, cash** — the walk-up sheet reads *Charge them $X*, where X is the
  sign price plus any extras and no surcharge.
- **Gate, card** — switch *Paid by* to **Card (tap to pay)** without touching
  anything else; the surcharge line appears and the figure goes up.
- **Tonight** — each price card shows `cash $x · card $y`, and *Money* has an
  *Of that, card surcharge* line.

A booking never re-prices. Change the rate mid-night and the sales already
taken keep the surcharge they were charged.

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

Tiers are per-offer, and there are three of them — Standard, Priority
exit, Valet. Copy them from an event that already sells rather than from
`20260814125456_talli_exit_axis_functions_and_tiers.sql`, which seeds the
six-tier menu that `20260831100000_talli_three_tiers_everywhere.sql`
retired:

```sql
insert into offer_tier
  (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
   guarantees_clear_exit, arrival_from, arrival_until, departure_by,
   sort_order, active)
select neo.id, t.code, t.label, t.price_cents, t.zone_codes, t.bay_kind,
       t.guarantees_clear_exit,
       ne.starts_at + (t.arrival_from  - oe.starts_at),
       ne.starts_at + (t.arrival_until - oe.starts_at),
       null, t.sort_order, true
from offer_tier  t
join event_offer oo  on oo.id = t.event_offer_id
join event       oe  on oe.id = oo.event_id
join event       ne  on ne.name  = 'TEST — Blues v Crusaders'
join event_offer neo on neo.event_id = ne.id
where oe.name = 'TEST — Tomorrow Night (on sale)' and t.active;
```

Anything else you add is a fourth option on the gate screen, which is
the thing the three-tier change was for.

---

## The one build step, and why it cannot touch production

`scripts/build.sh` runs on **every** Pages build, production included.

It is written to do nothing on production. It reads `CF_PAGES_BRANCH`
and exits immediately on the production branch; every other branch gets
a `robots.txt` and a `noindex` header. Production publishes byte-for-byte
what is in the repo.

That guard is the whole safety property, so `scripts/check.sh` tests it
by *running* the script both ways and asserting what it wrote — not by
grepping the source, which would keep passing on a script that had
stopped working.

---

## What still needs a human

- **Set Supabase secrets** — the tooling has no secrets API. Handled with
  test-project-only fallbacks in the functions, keyed on the project ref, so
  they are unreachable on production. Setting a real secret always wins.
  The test project wants `SITE_URL` = `https://staging.talli.pages.dev`,
  and an `ALLOWED_ORIGIN` that matches it.
- **DNS for `talli.co.nz`** — the zone lives at Crazy Domains and moves to
  Cloudflare as part of this migration. Nameserver changes and record
  verification are yours; a dropped MX record bounces mail silently, so the
  record set gets exported and checked before the nameservers change.
- **Point `test.talli.co.nz` at the test site** — once the zone is on
  Cloudflare this is a custom domain on the Pages project plus one record.
  Say the word and I'll do the Cloudflare side.
