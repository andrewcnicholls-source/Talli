---
name: finish-agent
description: Validate, commit and push an agent's feature branch, then hand back a PR title and body. Use when work in a Talli agent worktree is finished and ready for review, or when the user types /finish-agent. Runs the project's real checks, refuses to work on protected branches, and never deploys to staging or production.
---

# finish-agent

Get one agent's work ready for review. Push the branch, say honestly
whether it passes, and explain what happens next.

```
/finish-agent
```

**This skill does not deploy anything.** Talli's test site builds from
the `staging` branch, and that branch is shared. Pushing a feature
branch there would overwrite whatever another agent is currently
device-testing. Code reaches staging by being merged, not by being
copied.

## Steps

### 1. Establish where you are

```bash
git rev-parse --show-toplevel
git branch --show-current
git worktree list
. "$(git rev-parse --show-toplevel)/scripts/talli-env.sh"
```

### 2. Refuse to run on a protected branch

If the current branch is in `$TALLI_PROTECTED_BRANCHES` (`main`,
`staging`), stop. Explain what those branches mean:

- `main` is the live booking site. Committing here is a production
  deployment.
- `staging` is the shared device-test site. Committing here overwrites
  what someone may be testing on a phone right now.

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

Two things in this repository deserve a second look every time:

- **`assets/talli-config.js`** — the hostname switch is the only thing
  keeping the test site off production data.
- **`supabase/migrations/`** — a migration already applied to a project
  must never be edited in place. New behaviour means a new file.

### 4. Run the checks

```bash
bash scripts/check.sh
```

That is the project's validation command, and it is the same one CI
runs. There is no build, no bundler, no test framework and no linter in
this repository — do not invent `npm test`, `npm run lint` or
`npm run build`, and do not report them as passing.

What `scripts/check.sh` actually covers: JavaScript syntax, local
asset references, the environment switch, the edge-function `IS_TEST`
guards, the production build no-op, committed secrets, migration
filenames. What it does **not** cover: anything about how the site
behaves in a browser. Say both.

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
    (skipped: edge function TypeScript — deno not installed)

  Not covered by any automated check:
  browser behaviour, booking flow, payment flow, layout on real devices.

Changes:
  assets/booking.js       +48 −6
  book.html               +12 −0
  supabase/migrations/20260826120000_booking_cancellation.sql  (new)

Out-of-band release steps this branch will need:
  1 new migration — Netlify does not apply migrations.

Suggested PR
  Base: staging
  Title: Let a customer cancel a booking before the gate opens
  Body:  <3–6 lines: what changed, why, what to look at on staging>

  https://github.com/andrewcnicholls-source/Talli/compare/staging...feature/booking-cancellation

Next:
  1. Open the PR against staging.
  2. CI runs scripts/check.sh on it.
  3. Merge when approved — that deploys to talli-test.netlify.app.
  4. Test the staging site on real devices.
  5. Run /release-production to promote the tested commit to talli.co.nz.

Staging has NOT been updated. It updates when this merges to staging.
```

Adapt the shape; keep the honesty. In particular:

- **The PR base is `staging`, not `main`.** `main` is the production
  release branch — a PR merged there deploys to the live booking site
  without ever reaching a device. GitHub's default base is currently
  `main`, so say the base explicitly and use a compare URL that spells
  it out.
- Always end with whether staging was updated. It was not.
- If the branch adds files under `supabase/migrations/` or changes
  anything under `supabase/functions/`, list them under "out-of-band
  release steps". Netlify deploys the static site only; those two need
  a separate, deliberate step against Supabase.

## Never

- Deploy to staging or production, or push to `main` or `staging`.
- Force-push, rebase a pushed branch, amend a pushed commit,
  `git reset --hard`, or `git clean`.
- Discard a change because it looked unrelated.
- Run migrations against any Supabase project.
- Claim a check passed, or that staging is updated, without evidence.
