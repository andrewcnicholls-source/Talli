# Talli — deployment

How code gets from an agent's worktree to talli.co.nz, and how to
undo it.

`TESTING.md` describes what the test environment *contains* — fixtures,
passphrases, Stripe test mode. This file describes how things *move*.

---

## The three environments

|                    | **Local** | **Test / staging** | **Production** |
| --- | --- | --- | --- |
| Where | a git worktree on your machine | https://talli-test.netlify.app | https://talli.co.nz |
| Netlify project | none | `talli-test` | `talliconz` |
| Netlify site id | — | `ec2dd376-9da5-428b-bdd7-3a496a796841` | `a290ff77-40ca-4238-9ac1-e91736b3fd7d` |
| Deploys from | nothing | branch `staging` | branch `main` |
| Supabase project | test | test `uhdoverwvlxvyyctskle` | prod `oxzwfemyavznykqixhvk` |
| Stripe | test mode | test mode | **live** |
| Customer data | none | none, ever | real |
| Fixtures | the test five | the test five | real |
| Indexed by Google | n/a | no (`robots.txt` + `X-Robots-Tag`) | yes |

**Read the branch names carefully. They are not the conventional
ones.** `staging` is the integration branch — feature branches merge
into it and it deploys to the test site. `main` is the *release*
branch — a commit reaches it only by being promoted after device
testing, and arriving there is a production deployment.

The names come from Netlify, which is already configured this way.
Everything in `scripts/talli-env.sh` derives from those two facts, and
that file is the only place they are written down.

### How an environment is chosen

Not at deploy time. There is no build step and nothing is substituted.
`assets/talli-config.js` runs in the browser and switches on the
hostname:

```
talli.co.nz, www.talli.co.nz, talliconz.netlify.app  ->  PRODUCTION
everything else                                       ->  TEST
```

The default points at test on purpose. A preview URL, a `file://`
page, `localhost`, a hostname nobody anticipated — all of them land on
the test database. Getting it wrong costs a wasted test, not a real
booking.

This is also why promoting a commit is safe: the identical bytes are
test on one hostname and production on another. Nothing is rebuilt
differently for production.

---

## 1. How does code get from a Claude worktree to git?

```
/new-agent booking-cancellation
```

Creates `feature/booking-cancellation` and a worktree at
`../Talli-booking-cancellation`, branched from `origin/staging`. Each
agent gets its own directory, so two agents cannot fight over one
index.

Work in it. Then:

```
/finish-agent
```

Runs `bash scripts/check.sh`, commits, pushes the branch, and hands
back a PR title and body. It does **not** deploy — a feature branch
never goes near the test site, because that site is shared and pushing
to it would overwrite whatever someone is testing on a phone.

## 2. How does a PR get merged?

Open it **against `staging`**, not `main`.

> GitHub's default base branch is currently `main`. A PR merged there
> deploys straight to the live booking site with no device testing in
> between. Until the default is changed, set the base by hand every
> time. `finish-agent` prints a compare URL that spells it out.

`.github/workflows/ci.yml` runs `scripts/check.sh` on the PR — the same
script you ran locally, so green means the same thing in both places.
Merge when it passes and the change has been read.

## 3. How does `main` reach staging?

It doesn't, and that is the point. **Merging to `staging` deploys to
staging**, in about 30 seconds. `main` is downstream of staging, not
upstream of it.

```
feature/x ──PR──> staging ──> talli-test.netlify.app ──devices──> main ──> talli.co.nz
```

## 4. How do I know which commit staging is running?

Netlify records it. Do not infer it from the branch tip — the branch
can have moved since the last successful build.

- **Netlify UI:** app.netlify.com/projects/talli-test → Deploys. Each
  entry shows its commit, its branch and its time.
- **In a session:** `netlify-project-services-reader / get-project`
  gives the current deploy id; `netlify-deploy-services-reader /
  get-deploy-for-site` gives its `commit_ref`, `branch`, `state` and
  `published_at`.
- Every deploy also has an immutable permalink,
  `https://<deploy-id>--talli-test.netlify.app`, which keeps serving
  that exact build forever. Useful for comparing before and after.

The same applies to production against `talliconz`.

> **A session running on Claude Code for web cannot reach `talli.co.nz`
> or `talli-test.netlify.app`** — the environment's network policy
> refuses the connection (`CONNECT tunnel failed, response 403`). The
> Netlify API *is* reachable, so deploy state and commits can always be
> verified; a live HTTP smoke test cannot. `/release-production`
> reports that as "not checked" rather than as a pass. Run it from a
> local Claude Code session if you want the smoke tests to actually
> execute.

If a deploy has no `commit_ref`, it was uploaded from a working copy
rather than built from git, and there is no way to know what code it
is. `release-production` stops when it sees that.

## 5. How do I test staging on physical devices?

Open https://talli-test.netlify.app on the actual hardware.

- Front-door passphrase: `talli-test` (see `TESTING.md` — it is a
  signpost, not security).
- Every page carries a red *TEST SITE* bar; the gate screen turns red.
  Blue chrome means you are on the live site taking real money.
- Test payments: card `4242 4242 4242 4242`, any future expiry, any
  CVC. Real Stripe, test mode, no money moves.
- Worth covering: iPhone and iPad Safari, Android Chrome, a desktop
  browser, narrow and wide, touch on the booking picker, the booking
  flow end to end, the confirmation page, and the gate screen at
  `/admin.html`.

An automated check passing is not this. `scripts/check.sh` never opens
a browser.

## 6. How is a staging-tested version promoted to production?

```
/release-production
```

It asks Netlify which commit staging is actually serving, refuses to
proceed if the staging branch has moved past it, lists the commits,
migrations and payment-touching changes in the release, asks you to
confirm the device testing, shows a summary, and asks once more.

Then it fast-forwards `main` to that exact commit:

```bash
git push origin <staging-commit>:refs/heads/main
```

A fast-forward. No force, no rewrite. Netlify builds that commit and
publishes it. The skill then polls until Netlify reports `ready` **at
that commit**, and smoke-tests the live site.

Netlify has no cross-project deploy promotion — `talli-test` and
`talliconz` are separate projects — so the tested *commit* carries
across rather than the tested *build*. Since there is no build step,
those amount to the same files.

### The backend is not in that deploy

Netlify publishes static files. It does not apply migrations and does
not deploy edge functions. Both are separate, deliberate steps against
Supabase, done **before** the front end goes out:

1. `apply_migration` against `oxzwfemyavznykqixhvk`, one file at a
   time, verified between each.
2. `deploy_edge_function` for anything changed under
   `supabase/functions/`.
3. Then the fast-forward push.

A green Netlify deploy proves nothing about either.

## 7. How do I roll back production?

**Application rollback and database rollback are different operations.
One does not do the other.**

### Application — fast, safe

Netlify deploys are immutable and every previous one is still there.

app.netlify.com/projects/talliconz → **Deploys** → the last known-good
deploy → **Publish deploy**. Instant, no rebuild, no git change.

Then bring git back in line with `git revert` and an ordinary push.
**Never force-push `main` backwards.** Netlify and everyone's checkout
both read that branch.

### Database — slow, sometimes impossible

Publishing an older deploy does not un-apply a migration.

- **Additive** migrations (nullable column, new table, new index) need
  no rollback — the older front end ignores them. This is why
  backwards-compatible migrations are worth the extra effort: they keep
  the instant rollback path open.
- **Destructive** migrations cannot be undone this way. Restoring from
  a Supabase backup is a separate, slower operation with its own data
  loss window.

If a release contains a migration that would make rollback impossible,
that has to be said before the release, not discovered after.

## 8. How are the databases separated?

Two entirely separate Supabase projects. Different URLs, different
keys, different data. Nothing is shared, and there is no connection
between them.

- **Production** `oxzwfemyavznykqixhvk` — real bookings, real people.
- **Test** `uhdoverwvlxvyyctskle` — five fixtures, all named
  `TEST — …`. No customer data, ever.

Migrations are version-controlled in `supabase/migrations/`, applied in
filename order. `scripts/check.sh` enforces the naming and rejects
duplicate timestamps.

**Never copy production data into test.** There is no masking process
here, and building one is a bigger job than it sounds. The test
fixtures are invented on purpose. To refresh them, run
`supabase/test-only/reset-test-data.sql` against the test project — it
lives outside `migrations/` deliberately, so `supabase db push` can
never carry it to the live site.

Agents develop against test. Production is touched only when a change
has been through staging. The `PreToolUse` hook at
`.claude/hooks/supabase-permissions.py` enforces the boundary:
everything against test runs unprompted, destructive production SQL
stops for confirmation, and edge-function deploys to production always
ask. See `CLAUDE.md`.

Two known gaps, documented in `supabase/README.md`: the test project's
migration ledger under-reports what has actually been applied there,
and test carries schema production has never seen. Check the object
itself before concluding a migration is missing.

## 9. How are the payment credentials separated?

Stripe keys are **not in this repository and not on Netlify.** Neither
Netlify project has a single environment variable set — verified.

They live in Supabase Edge Function secrets, per project:

| | Supabase project | `STRIPE_SECRET_KEY` | Webhook endpoint |
| --- | --- | --- | --- |
| Local | test | `sk_test_…` | test-mode endpoint |
| Staging | `uhdoverwvlxvyyctskle` | `sk_test_…` | test-mode endpoint |
| Production | `oxzwfemyavznykqixhvk` | `sk_live_…` | live-mode endpoint |

Separate Stripe environments, separate endpoints, separate signing
secrets. A test transaction cannot reach a real customer.

Local development has no Stripe credentials of its own at all — it
calls the test project's edge functions, which hold the test key. There
is nothing to leak.

**Never put a live key anywhere but the production Supabase project.**
A live key paired with a test webhook secret is the failure that looks
like success: checkout works, the webhook never verifies, and bookings
silently never confirm. The gate screen's **Check payment setup**
button exists to catch exactly that — it reports key mode and webhook
mode without revealing either. Use it on both sites.

`scripts/check.sh` fails the build if anything resembling a Stripe key
or a Supabase service-role JWT is committed.

---

## Feature flags

There are none, and nothing here needs one yet.

What the project has instead is a per-fixture `status` column
(`draft`, `announced`, `on_sale`, …) which already does the job for the
one thing that matters: a fixture in `draft` is invisible to the public
key, so new inventory can exist in production before anyone can book
it. `TEST — Draft, Hidden From Public` exercises that path.

If a change ever is too large to ship in one go, the shape that fits
this architecture — no build step, config in one browser-side file — is
a flag in `assets/talli-config.js` alongside `headlineTiers`, defaulted
off, with the test branch of the switch reachable on the test site
first. Ship it dark, enable it on staging, device-test, promote, then
enable in production as a second small commit. Don't add a framework.

---

## The other deploy nobody asked for

GitHub Pages also builds this repository on every push to `main`
(workflow `pages-build-deployment`, 36 runs). It publishes a third
public copy of the site at the `github.io` URL.

That hostname is not in `PRODUCTION_HOSTS`, so the copy talks to the
**test** database — no customer data is at risk. But it is an
unmanaged, un-gated, indexable copy of the booking site that nobody is
watching. Turn it off in Settings → Pages unless it is wanted.
