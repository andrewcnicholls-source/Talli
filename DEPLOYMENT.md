# Talli — deployment

How code gets from an agent's worktree to talli.co.nz, and how to
undo it.

`TESTING.md` describes what the test environment *contains* — fixtures,
passphrases, Stripe test mode. This file describes how things *move*.

---

## The three environments

|                    | **Local** | **Test / staging** | **Production** |
| --- | --- | --- | --- |
| Where | a git worktree on your machine | https://staging.talli.pages.dev | https://talli.co.nz |
| Cloudflare Pages | none | preview branch | production branch |
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

The names come from Cloudflare Pages, which is configured this way.
One Pages project serves both: `main` is its production branch and
`staging` is its only enabled preview branch. Feature branches are
deliberately not built — every build costs against the monthly quota
and would publish another un-gated copy of the booking page.
Everything in `scripts/talli-env.sh` derives from those facts, and that
file is the only place they are written down.

### How an environment is chosen

Not at deploy time. There is no build step and nothing is substituted.
`assets/talli-config.js` runs in the browser and switches on the
hostname:

```
talli.co.nz, www.talli.co.nz  ->  PRODUCTION
everything else               ->  TEST
```

The default points at test on purpose. A preview URL, a `file://`
page, `localhost`, a hostname nobody anticipated — all of them land on
the test database. Getting it wrong costs a wasted test, not a real
booking.

This is why `talli.pages.dev` — the Pages project's own hostname for
the production branch — is **not** in that list. It serves the same
commit as production, and leaving it out means it talks to the test
database behind a red banner rather than standing up a second,
unwatched copy of the live booking page.

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
feature/x ──PR──> staging ──> staging.talli.pages.dev ──devices──> main ──> talli.co.nz
```

## 4. How do I know which commit staging is running?

Cloudflare records it. Do not infer it from the branch tip — the
branch can have moved since the last successful build.

- **Dashboard:** Workers & Pages → `talli` → Deployments. Each entry
  shows its commit, its branch and its time.
- **In a session:** the Cloudflare MCP server reports a deployment's
  `latest_stage.status` and its
  `deployment_trigger.metadata.commit_hash`.
- Every deployment also has an immutable preview URL,
  `https://<deployment-id>.talli.pages.dev`, which keeps serving that
  exact build forever. Useful for comparing before and after.

The same applies to production, on the same project's production
branch.

> **A session running on Claude Code for web cannot reach `talli.co.nz`
> or `staging.talli.pages.dev`** — the environment's network policy
> refuses the connection (`CONNECT tunnel failed, response 403`). The
> Cloudflare API *is* reachable, so deploy state and commits can always
> be verified; a live HTTP smoke test cannot. `/release-production`
> reports that as "not checked" rather than as a pass. Run it from a
> local Claude Code session if you want the smoke tests to actually
> execute.

If a deployment has no commit hash, it was uploaded from a working copy
rather than built from git, and there is no way to know what code it
is. `release-production` stops when it sees that.

## 5. How do I test staging on physical devices?

Open https://staging.talli.pages.dev on the actual hardware.

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

It asks Cloudflare which commit staging is actually serving, refuses to
proceed if the staging branch has moved past it, lists the commits,
migrations and payment-touching changes in the release, asks you to
confirm the device testing, shows a summary, and asks once more.

Then it fast-forwards `main` to that exact commit:

```bash
git push origin <staging-commit>:refs/heads/main
```

A fast-forward. No force, no rewrite. Cloudflare builds that commit
and publishes it. The skill then polls until Cloudflare reports the
deployment `success` **at that commit**, and smoke-tests the live site.

A preview deployment is not promoted to production — Pages rebuilds on
the production branch — so the tested *commit* carries across rather
than the tested *build*. Since there is no build step, those amount to
the same files.

### The backend is not in that deploy

Cloudflare Pages publishes static files. It does not apply migrations
and does not deploy edge functions. Both are separate, deliberate steps
against Supabase, done **before** the front end goes out:

1. `apply_migration` against `oxzwfemyavznykqixhvk`, one file at a
   time, verified between each.
2. `deploy_edge_function` for anything changed under
   `supabase/functions/`.
3. Then the fast-forward push.

A green Pages deployment proves nothing about either.

## 7. How do I roll back production?

**Application rollback and database rollback are different operations.
One does not do the other.**

### Application — fast, safe

Pages deployments are immutable and every previous one is still there.

Workers & Pages → `talli` → **Deployments** → the last known-good
deployment → **Rollback to this deployment**. Instant, no rebuild, no
git change.

Then bring git back in line with `git revert` and an ordinary push.
**Never force-push `main` backwards.** Cloudflare and everyone's
checkout both read that branch.

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
- **Test** `uhdoverwvlxvyyctskle` — the known Eden Park calendar and
  nothing else, every name prefixed `TEST — …`. No customer data, ever.

Migrations are version-controlled in `supabase/migrations/`, applied in
filename order. `scripts/check.sh` enforces the naming and rejects
duplicate timestamps.

**Never copy production data into test.** There is no masking process
here, and building one is a bigger job than it sounds. Real event names
and dates are public; bookings and people are not, and none of theirs
are ever in test. `supabase/test-only/reset-test-data.sql` holds the
event list and is the only thing that decides what exists there —
anything not on its list is deleted when it runs. It lives outside
`migrations/` deliberately, so `supabase db push` can never carry it to
the live site.

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

### What may never be deleted, on either project

Test data is disposable and wiping it needs nobody's permission. The one
rule that is not about the environment:

> **An event is taken off sale. It is not deleted.**
>
> An `event` with paid bookings, unpaid holds, or registered interest
> cannot be deleted at all — the database refuses it with
> `EVENT_NOT_EMPTY` and names the counts. Set its status instead:
> `cancelled` for a game that is off, `closed` for one that is over.
> Both are reversible in a tap from the gate screen's Tonight tab; a
> delete is reversible from nothing.
>
> An event nobody has touched still deletes cleanly, on either project.

The reason it is a data rule rather than a production rule is that the
guard then behaves identically in both places, so nothing about it is a
surprise the first time it matters. The test reset still works because it
clears bookings and interest before it clears events.

Three files hold that line, and `scripts/check.sh` asserts all three are
still there, because each is one careless edit from being gone:

| Where | What it does |
| --- | --- |
| `supabase/migrations/20260902090000_…_event_deletion_guard.sql` | refuses the `DELETE` in the database, and pins `event_interest` to `ON DELETE RESTRICT` so the mailing list cannot be cascaded away |
| `.claude/hooks/supabase-permissions.py` | makes an agent stop and ask before attempting one of these deletes on production, `WHERE` clause or not |
| `supabase/test-only/reset-test-data.sql` | clears dependents before events, which is what keeps the same rule safe to apply on test |

Registered interest is the half that was actually broken. It was
`ON DELETE CASCADE` until 2 Sep 2026, so deleting a fixture silently
deleted the list of people who had asked to be told when it went on sale
— no error, no trace, nothing to restore from.

## 9. How are the payment credentials separated?

Stripe keys are **not in this repository and not on Cloudflare.** The
Pages project has no environment variables set at all, and does not
need any.

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

## 10. Where does the domain point?

The registrar is **Crazy Domains**; the zone moves to Cloudflare so the
apex can reach Pages at all. `talli.co.nz` cannot be a CNAME — the DNS
spec forbids it at a zone apex — and Pages publishes no stable A record
to point at, so hosting the zone on Cloudflare is not a preference here,
it is the requirement.

The whole zone is two records, and **no mail runs on this domain** — no
MX, no SPF, no DKIM, no DMARC. That is the fact that makes the
nameserver change cheap. Confirm it is still true before moving; the
usual way this goes wrong is a record nobody remembered.

Before the migration:

| Record | Value | Actually served by |
| --- | --- | --- |
| `talli.co.nz` A | `104.198.14.52` | Netlify (legacy apex load balancer) |
| `www.talli.co.nz` CNAME | `andrewcnicholls-source.github.io` | GitHub Pages |

After: both are custom domains on the `talli` Pages project, managed by
Cloudflare, and GitHub Pages is off. See "Turn off GitHub Pages" below
for why the second row was a live problem and not just untidy.

### Moving it

1. Export the full record set from Crazy Domains first. It is the
   rollback artifact.
2. Add `talli.co.nz` to Cloudflare on the Free plan; let it scan-import,
   then check the imported zone against the export record by record.
3. Attach `talli.co.nz` and `www.talli.co.nz` as custom domains on the
   Pages project. SSL/TLS → **Full (strict)**.
4. Change the nameservers at Crazy Domains to the pair Cloudflare
   assigns. `ns1`/`ns2.crazydomains.com` happen to run on Cloudflare's
   network themselves — that is Crazy Domains' own arrangement and
   changes nothing about this step.
5. Verify with the smoke tests in `/release-production` §9.

Rollback once the zone is on Cloudflare is a record edit, not a
nameserver change: point the apex back at Netlify's IP. Much faster, and
the reason step 4 comes last.

## Feature flags

There are none, and nothing here needs one yet.

What the project has instead is a per-fixture `status` column
(`draft`, `announced`, `on_sale`, …) which already does the job for the
one thing that matters: a fixture in `draft` is invisible to the public
key, so new inventory can exist in production before anyone can book
it. Test carries the real Eden Park calendar, so nothing sits in `draft`
permanently any more; the one-line statement that puts a fixture there
to exercise the path is at the bottom of
`supabase/test-only/reset-test-data.sql`.

If a change ever is too large to ship in one go, the shape that fits
this architecture — no build step, config in one browser-side file — is
a flag in `assets/talli-config.js` alongside `headlineTiers`, defaulted
off, with the test branch of the switch reachable on the test site
first. Ship it dark, enable it on staging, device-test, promote, then
enable in production as a second small commit. Don't add a framework.

---

## Settings only you can change

Claude's GitHub access is deliberately scoped to code, issues and pull
requests. Repository *administration* — default branch, branch
protection, Pages — is blocked at the proxy, and the Cloudflare
dashboard is outside it entirely. So these are yours. Each takes
under a minute, and the two Cloudflare ones come first because their
failure modes are the worst.

### 0a. Create a **Pages** project, not a Worker

**Workers & Pages → Create → the _Pages_ tab → Connect to Git.**

Cloudflare's default "Connect to Git" flow creates a **Worker**. That
happened here, and the tell is a build that fails at a *deploy command*
with `wrangler` logs — a Pages project has no deploy command at all, so
if you see one you are on the wrong product.

Workers was investigated properly rather than dismissed. It has real
advantages: `.assetsignore` (which would fix the published-surface
problem below), stable per-branch preview URLs, and it is where
Cloudflare is steering new projects. It was rejected for one decisive
reason:

> **Workers Builds injects `WORKERS_CI_BRANCH`, not `CF_PAGES_BRANCH`.**

`scripts/build.sh` keys off `CF_PAGES_BRANCH`. On a Worker that is
always empty, so `"" = "main"` is false, every build — production
included — counts as non-production, and `noindex` gets written onto
`talli.co.nz`. The live booking site would quietly leave Google. The
build would go green while doing it.

If the project ever does move to Workers, that guard has to change in
the same commit. It is the load-bearing line.

### 0b. Set the Pages production branch to `main`

**Workers & Pages → `talli` → Settings → Build → Production branch.**

This is the one Pages setting that cannot be inferred from the
repository, and getting it wrong fails quietly. It was set to `staging`
when the project was first created.

Nothing in the repo defends against it, because nothing in the repo can
see it. Two guards *look* like they would, and neither does:

- `scripts/build.sh` compares `CF_PAGES_BRANCH` against
  `TALLI_PRODUCTION_BRANCH` from `scripts/talli-env.sh` — the repo's
  idea of production, not Cloudflare's. So a `staging` build still
  correctly gets `robots.txt` and `noindex`, whatever Cloudflare has
  labelled it.
- `talli.pages.dev` is not in `PRODUCTION_HOSTS`, so that hostname
  resolves to the test database regardless.

Both of those hold right up until a **custom domain** is attached. Then
`talli.co.nz` serves whatever the production branch is — and because
the environment switch reads the hostname, staging code would be
running against the **production** database with live Stripe keys. The
site would look fine. That is the whole problem with it.

So: fix the setting before attaching a domain, not after. Changing it
does not relabel existing deployments — retrigger a build, or push.

### 1. Make `staging` the default branch

The single highest-value change here. GitHub currently defaults every
new PR's base to `main`, which is production. One absent-minded merge
deploys untested code to the live booking site — which is exactly what
happened while this document was being written.

**Settings → General → Default branch → switch to `staging`.**

After this, PRs default to the integration branch and only a deliberate
`staging → main` PR (or `/release-production`) reaches production.

### 2. Protect `main` and `staging`

Two rulesets, and `staging` matters as much as `main`. Staging is the
device-test site and the only thing production is ever promoted from,
so an unprotected `staging` means a red change can land in the very
commit you are about to test and ship.

**Settings → Rules → Rulesets → New branch ruleset**, targeting `main`:

- ✅ Require status checks to pass → add **`check`** and **`typecheck`**
- ✅ Block force pushes
- ✅ Restrict deletions
- ❌ Require a pull request — leave this **off**. `/release-production`
  fast-forwards `main` directly, and as the only committer you would
  otherwise have to bypass the rule on every release, which is how
  protection ends up switched off altogether.

Then the same again targeting `staging`, with the force-push rule left
off — a feature branch that needs re-basing is normal there.

Both required checks are jobs in `.github/workflows/ci.yml` and both
are named by their job id, which is what GitHub matches on:

| Required check | What it runs |
| --- | --- |
| `check` | `bash scripts/check.sh` — the same script you run locally |
| `typecheck` | `deno check supabase/functions/*/index.ts` |

`typecheck` ran `continue-on-error` from the day it was added until it
had been green once, because gating on a check nobody had ever seen the
output of would have blocked every PR on a guess. It went green on
2 Sep 2026 and the flag came off, so it belongs in the required list
now.

A required check only satisfies a ruleset if it actually ran on the
commit. The workflow triggers on **push** to `staging` and `main` as
well as on pull requests, so any commit that reached staging already
carries both runs — which is what lets `/release-production`
fast-forward `main` to it without a PR.

### 3. Turn off GitHub Pages

GitHub Pages builds this repository on every push to `main` (workflow
`pages-build-deployment`) and publishes another public copy of the site
at the `github.io` URL.

**This is worse than it first looks, and an earlier version of this file
got it wrong.** The reasoning used to be that `github.io` is not in
`PRODUCTION_HOSTS`, so the copy talks to the test database and no
customer data is at risk. That is true of the `github.io` hostname
itself — but `www.talli.co.nz` is a CNAME to it, and `www.talli.co.nz`
*is* in `PRODUCTION_HOSTS`. The environment switch runs in the browser
against the hostname in the address bar, so anyone arriving on
`www.talli.co.nz` gets the GitHub Pages copy wired to the **production**
database and **live** Stripe keys.

So there are two production surfaces on two platforms, only one of which
goes through the staging gate. Both halves of the fix matter:

- **Settings → Pages → Source → None.**
- Attach `www.talli.co.nz` to the Pages project as a custom domain, so
  it serves the same deployment as the apex.

### 4. Disconnect Netlify

Netlify still builds this repository. It is the host the site left, and
nothing in the repo points at it any more — there is no `netlify.toml`,
no `_redirects`, and `scripts/talli-env.sh` names Cloudflare Pages as
the only deploy target. What is left is the connection in the other
direction: a Netlify site called `talli-test` is still linked to this
GitHub repo, so every pull request gets a Deploy Preview build that
fails, plus three check runs that fail with it:

```
netlify/talli-test/deploy-preview   Deploy Preview failed
Header rules - talli-test
Pages changed - talli-test
Redirect rules - talli-test
```

None of them are required, so they do not block a merge — the PR sits
at `unstable` rather than `blocked`. They are noise, and the cost of
noise on a checks list is that a real failure stops standing out.

Two ways to stop it, either is enough:

- **In Netlify** — Site configuration → Build & deploy → Continuous
  deployment → **Unlink repository**, or delete the `talli-test` site
  if nothing else uses it.
- **In GitHub** — Settings → Integrations → Applications → Netlify →
  Configure, and remove this repository from its access list.

Prefer the Netlify side. Removing the app's repository access stops the
checks but leaves a site in the account still expecting to build, which
is the same untidiness one layer down.

The DNS record at §10 is a separate thing: `talli.co.nz`'s legacy apex A
record still points at Netlify's load balancer, and that one is a
deliberate rollback path until the zone move is done. Do not remove it
while cleaning this up.

### 5. Let web sessions reach the sites (optional)

A Claude Code session running on the web cannot fetch `talli.co.nz` or
`staging.talli.pages.dev` — the environment's network policy refuses
the connection, so `/release-production`'s smoke tests report "not
checked" rather than passing. Cloudflare's API is reachable either way,
so deploy state and commits can always be verified.

To close it, add both hostnames to the environment's allowed hosts at
https://claude.com/settings/code-environments, or just run releases
from Claude Code on your own machine, where the checks execute normally.
