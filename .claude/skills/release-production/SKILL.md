---
name: release-production
description: Promote the exact commit currently running on the Talli staging site to production at talli.co.nz. Use when Talli staging has been device-tested and the user wants it live, or when the user types /release-production. Specific to the Talli booking site and refuses to run in any other repository — it handles bookings and real payments, verifies the staging deployment, identifies migrations and payment changes, requires explicit confirmation, and verifies the result.
---

# release-production

Promote the version currently on the test site to the live booking
site.

```
/release-production
```

This releases software that takes money from people and allocates them
a parking bay on a matchday. Treat every step as if the failure will be
discovered by someone standing on a driveway in the rain with cars
queuing behind them.

**The one rule everything else serves:** release only a specific,
identified commit that is *actually running on staging right now*.
Never "deploy main". Never "deploy latest".

## How a release physically happens here

The `talli` Pages project builds `main` as its production branch. So
promoting is a **fast-forward of `main` to the commit staging is
serving**:

```
staging branch  ──┐
                  ├─ same commit
main branch     ──┘
```

Cloudflare then rebuilds that commit on the production branch and
publishes it to talli.co.nz.

A preview deployment is never promoted to production — Pages rebuilds —
so the tested *commit* is what carries across, not the tested *build*.
That is safe here for a specific reason worth knowing: the site is
static files with no build step, and the environment switch in
`assets/talli-config.js` runs in the browser off the hostname. The
identical bytes behave as test on `staging.talli.pages.dev` and as
production on `talli.co.nz`. Nothing is rebuilt differently for
production.

**Cloudflare does not deploy the backend.** Database migrations and edge
functions are a separate, manual release track against Supabase. A
green Pages deployment does not mean the backend shipped. Section 5
below covers this and it is the most common way this release can go
wrong.

## 0. Refuse to run outside Talli

This skill is **specific to one application**. It knows Talli's Pages
project by name, its two Supabase projects by ref, that `main`
is the production branch, and that promotion is a fast-forward. None of
that is transferable, and every one of those facts is load-bearing on a
release that takes real money.

So before anything else:

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
git -C "$ROOT" remote get-url origin      # expect andrewcnicholls-source/Talli
test -f "$ROOT/scripts/talli-env.sh" && echo "topology file: present"
```

If the remote is not `andrewcnicholls-source/Talli`, **or**
`scripts/talli-env.sh` is missing, **stop immediately.** Say something
like:

```
/release-production is specific to the Talli booking site.

This repository is <owner/repo>, which it knows nothing about — not
its hosting, not its branch topology, not whether it even has a
staging environment.

No changes were made. Tell me how this project releases and I'll help
with that directly.
```

Do not adapt this skill to another repository on the fly. Do not guess
at a deployment mechanism. A release procedure improvised against an
unfamiliar production system is exactly the thing this skill exists to
prevent.

## 1. Establish the ground truth

```bash
. "$ROOT/scripts/talli-env.sh"
git remote -v                     # must be andrewcnicholls-source/Talli
git fetch origin --prune --tags
git status --short
```

Note any uncommitted local changes. They are not part of the release —
a release ships what is on the remote — but say what they are, because
an uncommitted change to `assets/talli-config.js` sitting in the
working tree is worth knowing about before you touch production.

## 2. Ask Cloudflare what staging is actually serving

Do not infer this from git. Ask the deployment platform.

```bash
bash scripts/cf-deploy.sh preview
```

It prints one `key: value` per line.

**Do not go looking for an MCP tool that does this.** Cloudflare's MCP
server covers D1, KV, R2, Hyperdrive and Workers; it has no Pages
deployments tool, so there is no way to ask it what commit a deployment
is serving. This script is the route, not a fallback for one.

| Field | Why |
| --- | --- |
| `status` | Must be `success`. Anything else — `active`, `failure`, `canceled` — means STOP. |
| `commit` | **This is the release candidate.** Call it `S`. |
| `branch` | Should be `staging`. |
| `created_on` | How long it has been up for testing. |
| `id` | The staging deployment id, for the record. |
| `url` | The immutable URL of that exact build. |

If `commit` is empty, the deployment was uploaded from somebody's
working copy rather than built from git, and **there is no way to know
what code is on staging**. STOP and say exactly that. Do not fall back
to guessing from the branch tip.

If the command exits non-zero you did not get an answer, which is not
the same as "nothing is deployed". STOP, and say which of the two it
was. Exit `3` is the one to read carefully: it means Cloudflare answered
in a shape the script does not understand, so the script needs fixing
and **nothing has been learned about the deployment**. Do not report
that as a release problem, and do not fall back to the branch tip.

## 3. Ask Cloudflare what production is running

```bash
bash scripts/cf-deploy.sh production
```

Call its `commit` `P`, and keep its deployment `id` — that id is the
rollback handle and it must appear in the final report either way.

## 4. Prove the release is what it claims to be

Every one of these is a STOP, not a warning.

```bash
git cat-file -e "$S^{commit}"                                   # S exists locally
git merge-base --is-ancestor "$S" "origin/$TALLI_INTEGRATION_BRANCH"
git rev-parse "origin/$TALLI_INTEGRATION_BRANCH"                # == S ?
git merge-base --is-ancestor "$P" "$S"                          # forward, not back
git rev-parse "origin/$TALLI_PRODUCTION_BRANCH"                 # == P ?
```

- **S is not on `origin/staging`** → staging is serving a commit that
  is not on the staging branch. Someone deployed by hand. STOP.
- **`origin/staging` has moved past S** → the branch has newer commits
  than the site is serving. Either a build is in flight or one failed.
  Those newer commits have not been device-tested. STOP; the fix is to
  wait for staging to rebuild and re-test, not to promote S anyway.
- **P is not an ancestor of S** → this release moves production
  backwards or sideways onto unrelated history. STOP.
- **`origin/main` ≠ P** → the production branch tip is not what
  production is serving. Something was pushed to `main` and either has
  not deployed or failed to. STOP and work out which before adding to
  it.
- **S == P** → production is already running this commit. Nothing to
  do. Say so and stop, cheerfully.

### CI must have passed on S itself

Branch protection on `main` will refuse a fast-forward to a commit whose
required checks did not pass — but do not find that out by watching the
push fail. Ask first, so the report says what is wrong rather than that
something was rejected.

Use the GitHub MCP server: `actions_list`, method `list_workflow_runs`,
`resource_id: ci.yml`, filtered to `branch: staging`, `event: push`.
Find the run whose `head_sha` is **S**.

- **No run for S** — the commit never went through CI. That happens if
  it was pushed while Actions was disabled, or it reached staging by a
  route that does not trigger the workflow. STOP.
- **`status` is not `completed`** — CI is still running on the commit
  you are about to put in front of customers. Wait for it; do not
  promote a commit whose checks are in flight.
- **`conclusion` is not `success`** — STOP, and say which job failed.
  Both `check` and `typecheck` are required, and a failing job now
  fails the run: `typecheck` stopped being `continue-on-error` on
  2 Sep 2026, so a green run before that date says nothing about the
  edge function TypeScript.

Running `bash scripts/check.sh` locally at the release commit — which
§5 asks for, to verify the `IS_TEST` guards — is not a substitute. It
skips the TypeScript check whenever `deno` is missing or the sandbox
cannot reach esm.sh and jsr.io, which is most of the time in a Claude
session. CI is where that check actually runs.

Then try to reach the staging site:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 20 "$TALLI_STAGING_URL"
```

Three outcomes, and they are not the same thing:

- **200** — reachable, note it.
- **A non-200 from the site** — does not by itself block a release; the
  site sits behind a passphrase gate and Cloudflare may answer curl
  oddly.
  Report the code you got.
- **`CONNECT tunnel failed, response 403`** — the *session's* network
  policy blocked the request; nothing was learned about the site.
  Sessions running on Claude Code on the web cannot reach `talli.co.nz`
  or `staging.talli.pages.dev` at all. Report it as **not checked** and
  fall back to Cloudflare's own metadata, which is reachable: `status`,
  `created_on` and the deployment `url`.

Never convert a blocked request into a tick.

## 5. Work out what is actually in the release

```bash
git log --oneline "$P".."$S"
git diff --stat "$P" "$S"
git diff --name-only "$P" "$S"
```

Then classify. This is the part that earns the skill its name.

### Database migrations

```bash
git diff --name-status "$P" "$S" -- supabase/migrations/
```

- **Added files (`A`)** — new migrations. List each by name and read
  it. Summarise in one line what it does. Say whether it is
  backwards-compatible: adding a nullable column, a table, an index or
  a new function is; dropping or renaming a column, adding a NOT NULL
  without a default, or changing a function's signature is not.
- **Modified files (`M`)** — a migration that already ran somewhere has
  been edited. That is a defect, not a release step. STOP.

Confirm against the projects rather than the file list:

```
mcp__Supabase__list_migrations  project_id: $TALLI_STAGING_SUPABASE_REF
mcp__Supabase__list_migrations  project_id: $TALLI_PRODUCTION_SUPABASE_REF
```

Beware: the test project's migration ledger is known to under-report —
some changes were applied there as raw SQL and never recorded. So
absence from the test ledger does not prove absence from the test
database. Check the object itself with a read-only query before
concluding anything. `supabase/README.md` documents this.

Rules:

- **A migration must be applied to test and exercised there before
  production.** If a migration in this release is not yet on the test
  project, the thing on staging was never really tested. STOP.
- **Migrations are not applied by the deploy.** Cloudflare Pages ships
  static files. Somebody has to apply them, deliberately, with
  `mcp__Supabase__apply_migration` against
  `$TALLI_PRODUCTION_SUPABASE_REF`.
- **Backwards-compatible migrations go first, before the code deploy.**
  The old front end must survive the new schema for the minutes between
  the two.
- **A destructive migration** — `DROP`, `DROP COLUMN`, `TRUNCATE`, an
  unqualified `DELETE`/`UPDATE`, a NOT NULL added to a populated table
  — needs its own explicit confirmation, separate from the release
  confirmation, and needs its rollback consequence stated first. The
  `PreToolUse` hook will also stop these; do not treat the hook prompt
  as the confirmation.
- **Never run ad-hoc SQL against production to make a deploy succeed.**
  If the release needs SQL that is not in a migration file, the release
  is not ready.

Take particular care with anything touching `booking`,
`booking_addon`, `payment`, refunds, transaction state, webhook state,
availability or bay allocation. A bad migration there is not a bug, it
is a customer who paid and has nowhere to park.

### Edge functions

```bash
git diff --name-only "$P" "$S" -- supabase/functions/
```

Cloudflare does not deploy these either. A changed function needs
`mcp__Supabase__deploy_edge_function` against the production project —
which is deliberately *not* pre-approved by the permission hook.

Before deploying any function, check the `IS_TEST` block is intact.
`scripts/check.sh` verifies this and it is worth re-stating why:
deploying a function that has lost its `IS_TEST` guard points the test
site at production. Run `bash scripts/check.sh` at the release commit.

### Payment-critical changes

Check the release diff against `$TALLI_PAYMENT_PATHS`. If anything
matches, this is a payment release. Say so in capital letters in the
summary, and additionally:

- Confirm staging's Stripe key is a **test** key and production's is a
  **live** key. Do not read the secrets. Use the gate screen's *Check
  payment setup* button — it reports key mode and webhook mode without
  revealing either — on both sites, and use the answer.
- Confirm the production webhook endpoint points at
  `https://$TALLI_PRODUCTION_SUPABASE_REF.supabase.co/functions/v1/stripe-webhook`
  and the staging one at the test project. They are separate endpoints
  with separate signing secrets, and a live key paired with a test
  webhook secret is the failure that looks like success.
- **Never put a real payment through to test a release.** Card
  `4242 4242 4242 4242` belongs on staging and nowhere else.

### Booking-critical changes

Check against `$TALLI_BOOKING_PATHS`. Flag them; they need the booking
flow smoke-tested after the release.

## 6. Confirm the device testing happened — do not assume it

Staging exists so this can be checked on real hardware. Present the
list and ask. Record the answers in the release summary as the user
gave them.

```
STAGING TESTING — https://staging.talli.pages.dev @ <S>
                  deployed <created_on>

[ ] Desktop browser
[ ] iPhone / iPad (Safari)
[ ] Android phone / tablet (Chrome)
[ ] Narrow and wide layouts
[ ] Touch interactions on the booking picker
[ ] Booking flow end to end
[ ] Test-mode payment (4242 4242 4242 4242) and confirmation page
[ ] Gate screen at /admin.html
[ ] Anything this release specifically changed
```

If the user has not tested it, say the release is not ready and offer
to wait. If they say to release anyway, that is their call — proceed,
but record in the summary that device testing was **not** done, and
never write that it was.

Do not tick a box because a check in `scripts/check.sh` passed. Those
checks do not open a browser.

## 7. Present the release summary and get explicit confirmation

An instruction given earlier in the conversation is not confirmation.
Ask immediately before the push, with the real numbers in front of the
user.

```
READY TO RELEASE

  Version:            a1b2c3d  Let a customer cancel before the gate opens
  Staging deploy:     6a8eb9ad-97cc-2e1b-1195-b74f   success, 3h ago
  Staging permalink:  https://6a8eb9ad.talli.pages.dev
  Target:             PRODUCTION — https://talli.co.nz

  Commits (4):
    a1b2c3d Let a customer cancel before the gate opens
    ...

  Database migrations:
    20260826120000_booking_cancellation.sql
      Adds nullable cancelled_at to booking. Backwards compatible.
      Applied to test: yes (verified against the database)
      Applied to production: NO — must be applied before the deploy

  Edge functions changed:
    gate-ops — needs a separate deploy to the production project

  PAYMENT CHANGES:
    None
    (or: create-checkout — refund path. Verify live key + live webhook.)

  Rollback:
    Previous production deploy 6a8ebbb26280b500089fa6ef  (commit 6d5e2ee)
    Application rollback: available, instant, via Cloudflare
    Database rollback: NOT automatic — see below

  Device testing: confirmed by Andrew on iPhone, Android and desktop

Release a1b2c3d to production?
```

Wait for a clear yes. Anything ambiguous is a no.

## 8. Release, in this order

1. **Apply the migrations** to `$TALLI_PRODUCTION_SUPABASE_REF`, one at
   a time, with `mcp__Supabase__apply_migration` — the migration file
   verbatim, so the production ledger records it. Verify each landed
   before the next. If one fails, stop; do not deploy the front end on
   top of a half-migrated database.
2. **Deploy any changed edge functions** to the production project, and
   verify with `mcp__Supabase__get_edge_function`.
3. **Fast-forward `main` to S:**

   ```bash
   git push origin "$S:refs/heads/$TALLI_PRODUCTION_BRANCH"
   ```

   This is a fast-forward — step 4 proved P is an ancestor of S — so it
   needs no force and rewrites nothing. **Never use `--force` or
   `--force-with-lease` here.** If git rejects it as non-fast-forward,
   `main` moved while you were working: go back to step 3 and start
   again.
4. Cloudflare picks up the push and builds. Nothing else triggers it.

## 9. Verify — do not trust the push

A successful `git push` says nothing about whether the site deployed.

Poll the production environment until its current deployment settles:

```bash
bash scripts/cf-deploy.sh production
```

The release is deployed only when **`status` is `success` AND `commit`
equals S**. A successful deployment of the wrong commit is not this
release. If `status` is `failure`, read the build log in the dashboard
and go to rollback — do not retry blindly.

Then smoke-test for real. **If the session cannot reach the site — the
`CONNECT tunnel failed, response 403` case above — say so and stop
here; do not report these as passing.** Ask the user to open the site,
or re-run the release from a session that has network access to it.

```bash
for p in / /book.html /admin.html /booking-confirmed.html; do
  printf '%-24s %s\n' "$p" \
    "$(curl -sS -o /dev/null -w '%{http_code}' "$TALLI_PRODUCTION_URL$p")"
done

# The environment switch must resolve to production on the live host.
curl -sS "$TALLI_PRODUCTION_URL/assets/talli-config.js" \
  | grep -c "$TALLI_PRODUCTION_SUPABASE_REF"

# The test-site banner must NOT be present on the live site.
curl -sS "$TALLI_PRODUCTION_URL/" | grep -c 'talli-env-banner' || true
```

Then check the backend is healthy, read-only:

```
mcp__Supabase__get_advisors  project_id: $TALLI_PRODUCTION_SUPABASE_REF
mcp__Supabase__query_logs    project_id: $TALLI_PRODUCTION_SUPABASE_REF
```

Look for a spike in errors since `published_at`. Confirm a booking can
be *read* — do not create one, and do not put a card through.

Report each result as what it was. A check you did not run is
"not checked", not a tick.

## 10. Report

```
PRODUCTION RELEASE COMPLETE

  Version:            a1b2c3d
  Production deploy:  6a9f01c...   ready
  URL:                https://talli.co.nz
  Permalink:          https://6a9f01c.talli.pages.dev
  Staging tested:     yes — iPhone, Android, desktop, test payment

  Migrations applied to production:
    ✓ 20260826120000_booking_cancellation.sql

  Edge functions deployed:
    ✓ gate-ops

  Smoke tests:
    ✓ / 200   ✓ /book.html 200   ✓ /admin.html 200
    ✓ live host resolves to the production Supabase project
    ✓ no test-site banner on the live page
    ✓ no new errors in the production logs
    – booking flow not exercised end to end (no test payment on live)

  (or, from a session without network access to the site:)
  Smoke tests:
    – NOT RUN — this session cannot reach talli.co.nz (proxy 403).
      Cloudflare reports the deployment successful at a1b2c3d.
      Please open https://talli.co.nz and confirm.

  Previous version:   6d5e2ee  (deploy 6a8ebbb26280b500089fa6ef)
  Rollback:           available — application only, see below
```

If anything blocked it:

```
PRODUCTION RELEASE BLOCKED

  Reason:
    Staging is serving f396224, but origin/staging has advanced to
    9a1b2c3. Those 2 commits have not been on a device.

  No production changes were made.
  main is still at 6d5e2ee and talli.co.nz is unchanged.
```

Always state explicitly whether production was touched.

## Rollback

**Application rollback and database rollback are different things, and
one does not do the other.**

### Application

Cloudflare keeps every deployment immutable and addressable. The
previous production deployment id from step 3 is a working site, still
there.

- Workers & Pages → `talli` → **Deployments** → the previous deployment
  → **Rollback to this deployment**. Instant, no build, no git change.
- Then bring git back in line with `git revert` and a normal push.
  **Never force-push `main` to an older commit** — that rewrites the
  history of a branch other people and Cloudflare both read.

### Database

There is no equivalent. Reverting the front end does not un-apply a
migration. Before releasing anything destructive, know this in advance:

- An **additive** migration (new nullable column, new table, new index)
  usually needs no rollback — the old front end ignores it.
- A **destructive** migration cannot be undone by publishing an older
  deploy. Dropped data is gone unless it can be restored from a
  Supabase backup, which is a separate, slower operation with its own
  data loss window.
- If a migration in a release would make rollback impossible, **say so
  before the confirmation prompt**, not after.

This asymmetry is why backwards-compatible migrations are worth the
extra step: they keep the instant rollback path open.

## Never

- Run this skill against any repository other than Talli.
- Force-push, or rewrite history on `main`.
- Deploy a commit that is not the one staging is serving.
- Deploy when you cannot identify the staging commit.
- Skip staging because the change looks small. Say what you would be
  skipping and let the user decide explicitly.
- Include commits the user has not seen listed.
- Change production secrets or environment configuration as part of a
  release.
- Run destructive SQL, or any ad-hoc SQL, against production to make a
  deploy work.
- Put a real card through production to test a release.
- Write that device testing happened when it did not.
- Write that the release succeeded before Cloudflare reports the
  deployment successful at commit S.
