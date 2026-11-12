# Talli

Static site (plain HTML/CSS/JS) backed by Supabase. Booking flow lives in
`assets/booking.js`, admin views in `assets/admin.js`, shared config in
`assets/talli-config.js`.

## How work gets done here

`DEPLOYMENT.md` is the full map: environments, branches, deploys,
rollback, database and payment separation. The short version, and the
rules that bind agents:

### Branch names are not the conventional ones

| Branch | Deploys to | Means |
| --- | --- | --- |
| `staging` | https://staging.talli.pages.dev | the integration branch — merge here |
| `main` | https://talli.co.nz | the **release** branch — merging here is a production deploy |

`staging` is where feature branches land and where device testing
happens. `main` is downstream of it. Both are defined once, in
`scripts/talli-env.sh`; read that rather than hardcoding a name.

> GitHub's default base branch is still `main`, so a PR opened without
> thinking targets production. Set the base to `staging` explicitly.

### Agents work in worktrees, never on a protected branch

Parallel agents in one checkout overwrite each other. Each agent gets
its own worktree and its own branch, named `feature/<task>`, sibling to
the repo root at `../Talli-<task>`.

Never commit directly to `main` or `staging`.

### The four skills

| Skill | When |
| --- | --- |
| `/new-agent <task>` | starting work — creates the branch and worktree. Deploys nothing. |
| `/finish-agent` | work is done — validates, commits, pushes, drafts the PR. Deploys nothing. |
| `/cleanup-agent` | the worktree is finished with — removes it, but never unmerged or uncommitted work. |
| `/release-production` | staging has been device-tested — promotes that exact commit to talli.co.nz. |

### Where the skills live

`.claude/skills/` in this repository, which means a Claude Code session
only sees them with this repo checked out. A chat in a claude.ai
*project* is not Claude Code and never sees them.

To have them in every Claude Code session, any repository, upload them
to the Claude account — `bash scripts/package-skills.sh` builds the
zips, and claude.ai → Settings → Capabilities → Skills takes them. The
repository copies stay the source of truth; re-run and re-upload after
a change or the account copy drifts.

`new-agent`, `finish-agent` and `cleanup-agent` work in any repository:
they read `scripts/talli-env.sh` when it exists and otherwise derive
the integration branch from the remote's default. `release-production`
is Talli-only and refuses to run elsewhere.

### Validation

Validation is part of the work, not a step after it. A change comes
with tests for what it changes, and is not finished until they pass.

`bash scripts/check.sh` is the one validation command, and CI runs the
same script. Never report a check as passing without running it.

It runs the static checks, then the automated suites from workstream
T0 (`TESTING.md`, "Automated tests"): units, database (pgTAP),
edge functions and browser (Playwright), against a **local** Supabase
stack in Docker, rebuilt from `supabase/migrations/` on every run —
never against the shared test project. `--fast` skips the browser,
`--static` needs no Docker. A suite that could not run is reported as
skipped, never as passed; say so when it happens. Add to these suites
rather than starting another, and do not invent `npm test`,
`npm run lint` or `npm run build` — the tools live in
`tests/package.json` and exist only to serve `check.sh`.

The tests sign in with password accounts seeded in
`supabase/test-only/seed-test-users.sql`. No server check may be
weakened, skipped or special-cased to let a test through; if a test
cannot sign in honestly, the test is wrong.

There is still no build and no bundler: the site is served as the
files in this repository.

### Staging is shared, and it is the real test

- Staging is Andrew's device-testing environment: phones, tablets,
  desktops, touch, the booking flow, test-mode payments. An automated
  check passing is not the same thing and does not replace it.
- Never push a feature branch to `staging` to "have a look". It would
  overwrite whatever is being tested on a phone at that moment. Code
  reaches staging by merging.
- Staging must never use production payment credentials, and must
  never hold production data. Its Stripe key is `sk_test_…`, in the
  test Supabase project; production's `sk_live_…` is in the production
  project, and nowhere else.
- Never copy real customer or payment data into test. There is no
  masking process, and the fixtures are invented for this reason.

### Production releases are deliberate

Only a commit that has actually been running on staging is promoted,
and only after explicit confirmation at the moment of release.
Cloudflare Pages publishes the static site; **migrations and edge
functions are a separate manual step against Supabase** and go first.
Never force-push, never deploy an unidentified version, never claim a
deploy succeeded before Cloudflare reports it successful at that commit.

## Supabase environments

| Environment | Project name | Project ID | Notes |
| --- | --- | --- | --- |
| Test | `talli-test` | `uhdoverwvlxvyyctskle` | Scratch. Safe to break. |
| Production | andrewcnicholls-source's Project | `oxzwfemyavznykqixhvk` | Live site data. |

`assets/talli-config.js` carries both, and switches on the browser's
hostname at load time — `talli.co.nz` and its aliases get production,
everything else falls to test. There is no build-time substitution.

## Who may open the gate screen

`admin.html` is Google sign-in, through Supabase Auth. There is no shared
passphrase any more, on either project.

`gate-ops` and `check-setup` resolve the caller's bearer token against the
auth server — never by decoding it, because the anon key is itself a valid
JWT — then look the verified email up in `host_user`. Signed in is not the
same as allowed; the table is what decides.

A `host_user` row with no `user_id` is an unclaimed invitation, claimed by
the first sign-in with that email. That is how a new host is added: one
`insert`, no console step. Both projects carry a seeded invitation for
Andrew, and they are separate projects so they are separate sign-ins.

Two things follow that are easy to get wrong:

- **Google sign-in is dashboard configuration**, per Supabase project, and
  no MCP tool reaches it. `DEPLOYMENT.md` § 0c has the exact steps. Until
  it is done on a project, that project's gate screen lets nobody in.
- **Losing any of the three checks fails open.** The screen keeps working
  for whoever is signed in, and for everyone else too. `scripts/check.sh`
  asserts they are still there; do not weaken those checks to make a
  refactor pass.

Events are deliberately **not** filtered by host. What a person sees is
decided by `host_user.scope`: `all` (Andrew, on the operator host — the one
with `host.is_operator`) sees everything; `blocks` (a warden) sees only the
properties in the blocks switched on for them in `staff_block_access`, and
only the Arrivals tab. A warden with every grant switched off is refused
(`NO_BLOCKS`), never widened to everything. gate-ops enforces this; the
screen only stops offering what the server would refuse.

A **block** is a cluster of nearby properties one warden covers and the thing
customers book ("70 Gribblehurst or within 100m"). It is not a `zone`, which
is an area within one property. `booking.property_id` is where the car is
(updated at check-in); `booking.booked_property_id` is where it was booked.
`supabase/test-only/seed-test-block.sql` adds an invented second block to the
test project.

## Database permission policy

Andrew's standing instruction, enforced by the `PreToolUse` hook at
`.claude/hooks/supabase-permissions.py`:

1. **Test environment is fully automated.** Any Supabase operation against
   `uhdoverwvlxvyyctskle` runs without asking — including drops and deletes.
   It does not matter if the test database breaks.
2. **Promoting test to production is automated.** Once Andrew says test is
   ready to go to prod, apply the changes directly. `execute_sql` and
   `apply_migration` against `oxzwfemyavznykqixhvk` run without asking.
   Don't ask him to confirm a migration he has already approved.
3. **Destructive production SQL still asks.** `DROP` of any object,
   `DROP COLUMN`, `DROP CONSTRAINT`, `DISABLE TRIGGER`, `TRUNCATE`, and
   `DELETE`/`UPDATE` with no `WHERE` clause against production stop for
   confirmation. So does **any `DELETE` from `event`, `event_interest`,
   `booking`, `booking_addon`, `bay_allocation`, `booking_cancellation`
   or `booking_transfer`** — with a `WHERE` clause or without one. A
   precise delete of the wrong row is still gone.
4. **Everything else asks.** Edge function deploys, project lifecycle
   (create/pause/restore), and branch operations against production are not
   pre-approved. Nor is any project ID the hook doesn't recognise.

Read-only introspection (`list_*`, `get_*`, `query_logs`,
`generate_typescript_types`, `search_docs`) runs unprompted on either project.

### Working practice

Develop and iterate against **test**. Only touch production when Andrew has
said the change is ready to promote. When promoting, prefer `apply_migration`
over raw `execute_sql` for DDL so the change is recorded in the migration
history.

### An event is taken off sale, never deleted

Wiping test data is fine and needs no permission. Production is different,
and the difference is not the environment — it is whether anyone is
attached to the night.

An `event` with **paid bookings, unpaid holds, or registered interest**
cannot be deleted at all. The database refuses it
(`20260902090000_talli_event_deletion_guard`) and says so by name:
`EVENT_NOT_EMPTY`. The right action is a status change — `cancelled` for
a game that is off, `closed` for one that is over — which the gate
screen does from the Tonight tab. Both are reversible; a delete is not.

An event nobody has touched still deletes cleanly, on either project.

This is why the rule can be identical on test and production: it is a
property of the data. The test reset works because it clears bookings and
interest before it clears events, and `scripts/check.sh` asserts that
ordering still holds.

### Changing the policy

Edit `.claude/hooks/supabase-permissions.py` — the project IDs and the
destructive-statement patterns are constants near the top. The hook only ever
returns `allow` or `ask`, never `deny`, so anything it stops can still be
approved at the prompt.
