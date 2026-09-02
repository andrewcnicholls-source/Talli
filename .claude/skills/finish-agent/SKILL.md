---
name: finish-agent
description: Validate, commit and push an agent's feature branch, then hand back a PR title and body. Use when work in an agent worktree is finished and ready for review, or when the user types /finish-agent. Runs the validation commands the repository actually defines, refuses to work on protected branches, and never deploys to staging or production.
---

# finish-agent

Get one agent's work ready for review. Push the branch, say honestly
whether it passes, and explain what happens next.

```
/finish-agent
```

**This skill does not deploy anything.** In Talli, the test site builds
from the shared `staging` branch — pushing a feature branch there would
overwrite whatever another agent is currently device-testing. Code
reaches a shared environment by being merged, not by being copied. That
holds as a general rule, not just here.

## Steps

### 1. Establish where you are, and the branch topology

```bash
git rev-parse --show-toplevel
git branch --show-current
git worktree list
```

**In the Talli repository**, `scripts/talli-env.sh` exists at the root
and is authoritative — source it for `$TALLI_INTEGRATION_BRANCH` (which
is `staging`, not `main`) and `$TALLI_PROTECTED_BRANCHES`.

**Anywhere else**, the integration branch is the remote's default:

```bash
BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null \
        | sed 's#^origin/##')"
```

Protected: that branch, plus any of `main`, `master`, `develop`,
`trunk`, `staging`, `release`, `production` that exist.

### 2. Refuse to run on a protected branch

If the current branch is protected, stop. Say what it deploys to if you
know — in Talli:

- `main` is the live booking site. Committing here is a production
  deployment.
- `staging` is the shared device-test site. Committing here overwrites
  what someone may be testing on a phone right now.

Elsewhere, say plainly that it is a shared branch and the work belongs
on its own.

Offer to move the work onto a feature branch instead
(`git switch -c feature/<name>`), which preserves everything. Do not
commit, and do not reset.

### 3. Show what changed

```bash
git status --short
git diff --stat "origin/$TALLI_INTEGRATION_BRANCH"...HEAD
git diff "origin/$TALLI_INTEGRATION_BRANCH"...HEAD
```

Read the diff. Call out anything that does not belong to the stated
task — a stray debug `console.log`, a reformatted unrelated file, a
change to `assets/talli-config.js` that was not asked for, an edited
migration that has already been applied somewhere. Name them; let the
user decide. Do not silently revert them.

Two things in the Talli repository deserve a second look every time:

- **`assets/talli-config.js`** — the hostname switch is the only thing
  keeping the test site off production data.
- **`supabase/migrations/`** — a migration already applied to a project
  must never be edited in place. New behaviour means a new file.

The general form of that: anything holding an environment boundary, and
anything already applied elsewhere that cannot be edited retroactively.

### 4. Run the checks that exist

**In the Talli repository:**

```bash
bash scripts/check.sh
```

That is the project's only validation command, and CI runs the same
file. There is no build, no bundler, no test framework and no linter —
do not invent `npm test`, `npm run lint` or `npm run build`.

What it covers: JavaScript syntax, local asset references, the
environment switch, the edge-function `IS_TEST` guards, the production
build no-op, committed secrets, migration filenames. What it does
**not** cover: anything about how the site behaves in a browser. Say
both.

**The TypeScript check is usually skipped locally, and that is not the
same as passing.** `deno check` needs to reach esm.sh and jsr.io for
the Stripe and supabase-js imports, and most sandboxes cannot, so
`check.sh` reports it as a skip rather than pretending. CI runs it as
a separate required job (`typecheck` in `.github/workflows/ci.yml`) on
a runner that can reach both. If the local run skipped it, say so in
the report and say that CI is where it gets checked — do not let a
skip read as coverage.

**Anywhere else**, find out what the repository actually has before
running anything. Look, in this order, for what the project itself
defines:

```bash
ls Makefile justfile Taskfile.yml 2>/dev/null
[ -f package.json ] && python3 -c "import json;print(' '.join(json.load(open('package.json')).get('scripts',{})))"
ls pyproject.toml tox.ini noxfile.py Cargo.toml go.mod 2>/dev/null
ls .github/workflows/*.y*ml 2>/dev/null
```

The CI workflow is the best guide — whatever it runs on a PR is what
the project considers validation. Run those same commands: formatting,
lint, typecheck, unit tests, integration tests, build, in whatever
subset genuinely exists.

**Never invent a command.** A `package.json` without a `test` script
means there are no tests, not that you should write `npm test` and
report the failure as a problem. Say "no test script defined" and move
on. Report exactly what you ran and what it returned.

If it fails:

- report the failures verbatim;
- do not commit, do not push;
- say plainly that the task is not complete;
- offer to fix them.

Never describe a check as passing unless you watched it pass.

### 5. Commit

Only if there is something uncommitted. Stage deliberately —
`git add <paths>`, not `git add -A`, so nothing unrelated is swept in.

Write a message in this repository's style: a short imperative subject
describing the change in the terms of the product, and a body
explaining why where it is not obvious. Look at `git log` for the tone.

### 6. Push

```bash
git push -u origin "$BRANCH"
```

Never `--force`, never `--force-with-lease`, never rewrite history.
On a network failure retry with backoff (2s, 4s, 8s, 16s).

### 7. Report

```
Agent work complete

Branch:
  feature/booking-cancellation
  pushed to origin

Validation:
  ✓ scripts/check.sh — 20 passed, 0 failed, 1 skipped
    (skipped: edge function TypeScript — deno cannot reach esm.sh
     from here; CI's typecheck job is where that one runs)

  Not covered by any automated check:
  browser behaviour, booking flow, payment flow, layout on real devices.

Changes:
  assets/booking.js       +48 −6
  book.html               +12 −0
  supabase/migrations/20260826120000_booking_cancellation.sql  (new)

Out-of-band release steps this branch will need:
  1 new migration — Cloudflare Pages does not apply migrations.

Suggested PR
  Base: staging
  Title: Let a customer cancel a booking before the gate opens
  Body:  <3–6 lines: what changed, why, what to look at on staging>

  https://github.com/andrewcnicholls-source/Talli/compare/staging...feature/booking-cancellation

Next:
  1. Open the PR against staging.
  2. CI runs scripts/check.sh and the edge-function typecheck on it.
     Both are required checks; the PR cannot merge until they pass.
  3. Merge when approved — that deploys to staging.talli.pages.dev.
  4. Test the staging site on real devices.
  5. Run /release-production to promote the tested commit to talli.co.nz.

Staging has NOT been updated. It updates when this merges to staging.
```

Adapt the shape; keep the honesty. In particular:

- **In Talli the PR base is `staging`, not `main`.** `main` is the
  production release branch — a PR merged there deploys to the live
  booking site without ever reaching a device. Say the base explicitly
  and use a compare URL that spells it out. Elsewhere, base the PR on
  the integration branch from step 1, and still name it explicitly
  rather than relying on the repository's default.
- Always end with whether staging was updated. It was not.
- If the branch adds files under `supabase/migrations/` or changes
  anything under `supabase/functions/`, list them under "out-of-band
  release steps". Cloudflare Pages deploys the static site only; those
  two need a separate, deliberate step against Supabase. The general
  form: anything in the diff that the deployment pipeline does not
  itself ship — migrations, infrastructure, secrets, scheduled jobs —
  gets named, because a green deploy will not carry it.
- The "Next" steps describe Talli's route to production. In another
  repository, describe that repository's actual route, and if you do
  not know it, say so instead of inventing one.

## Never

- Deploy to staging or production, or push to `main` or `staging`.
- Force-push, rebase a pushed branch, amend a pushed commit,
  `git reset --hard`, or `git clean`.
- Discard a change because it looked unrelated.
- Run migrations against any Supabase project.
- Claim a check passed, or that staging is updated, without evidence.
