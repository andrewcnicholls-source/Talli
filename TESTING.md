# Talli — test environment

There are now two of everything. This file is the map.

|                | **Production**                      | **Test**                                 |
| -------------- | ----------------------------------- | ---------------------------------------- |
| Site           | https://talli.co.nz                 | https://talli-test.netlify.app           |
| Netlify project| `talliconz`                         | `talli-test`                             |
| Git branch     | `main`                              | any branch you push                      |
| Supabase       | `oxzwfemyavznykqixhvk`              | `uhdoverwvlxvyyctskle`                   |
| Stripe         | live keys                           | test-mode keys — real Stripe, fake money |
| Fixtures       | real                                | five, all named `TEST — …`               |
| Customer data  | real people                         | none, ever                               |

They share nothing. Different database, different keys, different money.
Breaking the test site cannot touch a real booking.

---

## Before anything works: one thing only you can do

A Netlify project cannot be linked to a GitHub repository through the API,
and the token this tooling holds can read projects but not push deploys
either — Netlify answers `403 Forbidden`. Re-confirmed on 25 Aug. So this
step is yours, and until it is done the test site stays dark.

It takes about two minutes, once, forever.

1. Open https://app.netlify.com/projects/talli-test
2. **Project configuration → Build & deploy → Link repository**
3. Choose `andrewcnicholls-source/Talli`
4. Set **Branch to deploy** to whichever branch you want at
   `talli-test.netlify.app` — right now that is
   `claude/parking-checkout-admin-rghtee`
5. Set **Branch deploys** to **All**
6. Leave build command and publish directory blank — `netlify.toml` sets them
7. **Deploy**

Step 5 is the one that matters. With branch deploys on *All*, every branch
you push gets its own test URL automatically:

```
claude-parking-checkout-admin-rghtee--talli-test.netlify.app
```

No branch is special, and you never open this screen again.

### Why there is no `staging` branch

An earlier version of this file asked you to create one. It was never
load-bearing. Which backend a page talks to is decided by **hostname**, in
`assets/talli-config.js` — not by branch, not at build time:

```js
var PRODUCTION_HOSTS = [
  'talli.co.nz',
  'www.talli.co.nz',
  'talliconz.netlify.app',
];

var host = (window.location.hostname || '').toLowerCase();
var env = PRODUCTION_HOSTS.indexOf(host) !== -1 ? PRODUCTION : TEST;
```

Anything that is not one of those three hostnames gets the test database.
`talli-test.netlify.app` does. So does every `…--talli-test.netlify.app`
branch URL. A dedicated `staging` branch would have bought a fixed address
for "what's next" at the cost of an extra merge on every change — worth it
for a team who need one place to look, not for one person.

## How you work now

```
     you work on a branch              you merge when happy
              │                                 │
   any branch ──────────────────────────────► main
              │                                 │
  <branch>--talli-test.netlify.app        talli.co.nz
  (fake fixtures, fake money)             (real customers)
```

Day to day:

```bash
git checkout -b try-a-price-ladder
# ...make your change...
git commit -am "Try a new price ladder"
git push -u origin try-a-price-ladder   # test URL builds in ~30s
```

Netlify prints the URL, and it is predictable: the branch name with `/` and
other punctuation turned into `-`, then `--talli-test.netlify.app`.

Look at it. Poke it. When you're happy:

```bash
git checkout main
git merge try-a-price-ladder
git push origin main                    # now it's live
```

If you hate it, delete the branch. Nothing you did was ever visible to a
customer, and nothing needed unwinding.

The branch set as **Branch to deploy** is the one that also answers at the
bare `talli-test.netlify.app`. Point it at whatever you are living in.

## What to exercise first

The branch waiting on the test site adds pre-purchased extras and a set of
controls for running the night. Worth walking once before an event rather
than discovering it on a driveway:

**On `/book.html`** — pick a night and a spot, and step 03 offers ponchos,
earplugs and lolly bags. Check the running total honours the multi-buy: three
pairs of earplugs should read **$8**, not $9. There is no longer a box asking
the customer to agree to the overflow verge.

**On `/admin.html`** — the *Tonight* tab is new.

| Try | Expect |
| --- | --- |
| Tap `−` on a zone | a space is written off; the count and the online availability both drop |
| Tap `+` past what you wrote off | a spare opens — the neighbour's berm lives here |
| `−$5` / `+$5`, or tap a price | the sign in the driveway and the database agree again |
| **Sold out** on Standard | walk-up jumps to Priority at the right price; online shows none left |
| **Hand over** on a row with extras | the chips grey out and the "to hand over" count falls |

A booking made with extras shows them on the arrivals row, so the person at
the gate knows what to fetch.

You do not need a Stripe key for any of this — see *Payments on the test
site* below. The gate passphrase on test is `talli-test`.

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
supabase/migrations/      26 files, the full schema history
supabase/functions/       create-checkout, stripe-webhook, gate-ops,
                          get-booking, register-interest, check-setup
supabase/test-only/       the test-data reset script (never runs on prod)
```

Verified, not assumed: the test database was rebuilt from those files alone,
and every one of columns, function bodies, RLS policies, indexes,
constraints, view definitions and grants hashes **identical** to production.
Three of the six functions deployed to a byte-identical bundle hash.

**As of 25 Aug** there are 26 migrations — the extras, the night-capacity
levers and the gate pricing controls were added on top — and all of them are
applied to both projects. Five of the six functions now match byte for byte
across test and production. The exception is `check-setup`: the test project
runs a newer build than production, carrying the unset-`SITE_URL` fix. Worth
deploying to production next time you are in there.

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
- **Deploy the test site directly instead** — tried that as a way around the
  above, uploading the folder rather than linking the repo. Netlify answered
  `403 Forbidden`: the token this tooling holds can read projects but not
  push deploys. Tried again on 25 Aug with the same answer, and confirmed the
  403 came from Netlify rather than any network in between. So the steps at
  the top really are the unlock, and the test site stays dark until you do
  them.
- **Set Supabase secrets** — the tooling has no secrets API. Handled with
  test-project-only fallbacks in the functions, keyed on the project ref, so
  they are unreachable on production. Setting a real secret always wins.
- **Enable Netlify password protection** — their API returned `422`; it needs
  a paid plan.
- **Point `test.talli.co.nz` at the test site** — needs a DNS record only you
  can add. Say the word and I'll do the Netlify side.
