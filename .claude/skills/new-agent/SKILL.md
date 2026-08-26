---
name: new-agent
description: Create an isolated git worktree and feature branch so an agent can work without colliding with other agents in the same checkout. Use when starting a new piece of work, or when the user types /new-agent with a task name. Branches from the repository's integration branch and creates a sibling worktree directory. Creates a workspace only — never deploys, and never touches a deployed environment.
---

# new-agent

Create an isolated workspace for one agent to do one piece of work.

```
/new-agent booking-cancellation
```

That is the whole job. This skill creates a branch and a worktree and
tells the user how to open it. **It deploys nothing, migrates nothing,
and touches no environment.** If you find yourself reaching for Netlify
or Supabase while running this skill, stop — you are in the wrong skill.

## Why worktrees

Two agents in one checkout fight over the index and the working tree,
and the loser's edits vanish. A worktree gives each agent its own
directory and its own checked-out branch off the same `.git`, so they
genuinely cannot collide.

## Steps

### 1. Find the repository root

```bash
git rev-parse --show-toplevel
```

If this fails, the current directory is not a git repository. Say so
and stop — do not run `git init`.

If the current directory is already a worktree rather than the main
checkout, note it. `git worktree list` shows the main checkout first;
new worktrees should be created from a known root, and creating one
from inside another worktree still works but the sibling path is
computed from the *main* checkout, not the current one:

```bash
git worktree list --porcelain | awk '/^worktree /{print $2; exit}'
```

Use that path as `ROOT`.

### 2. Work out the branch topology

Two facts are needed: which branch new work should be based on, and
which branches must never be committed to directly.

**In the Talli repository** — `scripts/talli-env.sh` exists at the root
— source it and use it. It is authoritative:

```bash
. "$ROOT/scripts/talli-env.sh"
```

That gives `$TALLI_INTEGRATION_BRANCH` (`staging`, not `main` — read
the file's comments before assuming), `$TALLI_PROTECTED_BRANCHES`,
`$TALLI_BRANCH_PREFIX` and `$TALLI_WORKTREE_PREFIX`.

**In any other repository**, derive them:

```bash
BASE="$(git -C "$ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null \
        | sed 's#^origin/##')"
```

That is the remote's own default branch, which is the right base for
new work almost everywhere. If it comes back empty the remote HEAD is
not set locally — try `git -C "$ROOT" remote set-head origin -a`, and
if it still fails, ask rather than guessing between `main` and
`master`.

Treat as protected: that base branch, plus any of `main`, `master`,
`develop`, `trunk`, `staging`, `release`, `production` that exist in
the repository. Branch prefix `feature/`. Worktree prefix: the repo
directory's own name plus a hyphen, so the sibling of `~/code/foo` is
`~/code/foo-<task>`.

Never hardcode a branch name. A repository whose default branch is
`main` and one whose deployable branch is `staging` are both normal,
and getting it backwards is how an agent ends up basing work on
untested code — or committing to production.

### 3. Inspect the current state and report it before changing anything

```bash
git -C "$ROOT" status --short
git -C "$ROOT" branch --show-current
git worktree list
git -C "$ROOT" fetch origin --prune
```

Uncommitted changes in the main checkout do **not** block creating a
worktree — a new worktree gets a clean checkout of the new branch and
leaves the existing one alone. Say so rather than refusing. Do warn if:

- the current checkout has uncommitted changes, so the user knows those
  stay behind and will not come with them;
- `git worktree list` already shows several worktrees, so they know how
  many agents are in flight;
- the fetch failed, so they know the branch check below is against
  possibly stale refs.

### 4. Choose the branch name

From the argument, lowercased, spaces and underscores to hyphens,
anything other than `[a-z0-9-]` dropped, collapsed hyphens, trimmed:

```
/new-agent booking cancellation  ->  feature/booking-cancellation
```

Prefix with `$TALLI_BRANCH_PREFIX`. If no argument was given, ask what
the work is — do not invent a name like `feature/agent-1`.

Never derive a name that collides with a protected branch
(`$TALLI_PROTECTED_BRANCHES`).

### 5. Check for collisions — and stop if there are any

```bash
git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"          # local
git -C "$ROOT" show-ref --verify --quiet "refs/remotes/origin/$BRANCH" # remote
test -e "$WORKTREE"                                                    # directory
```

Where `WORKTREE="$(dirname "$ROOT")/${PREFIX}${SLUG}"` and `PREFIX` is
`$TALLI_WORKTREE_PREFIX` in the Talli repo, or `$(basename "$ROOT")-`
anywhere else.

If **any** of these already exists, do not proceed. Report exactly what
exists and offer the choices:

- a different task name;
- reattaching a worktree to the *existing* branch, if the user confirms
  they want to continue that work — `git worktree add "$WORKTREE" "$BRANCH"`
  with no `-b`;
- deleting the old one first, which is `cleanup-agent`'s job, not this
  one.

Never pass `-B`, never `--force`, never delete a directory to make room.

### 6. Create the worktree

Branch from the integration branch, not from whatever happens to be
checked out — an agent's work should be based on the current deployable
version:

```bash
git -C "$ROOT" worktree add -b "$BRANCH" "$WORKTREE" "origin/$BASE"
```

where `$BASE` is the integration branch established in step 2.

If `origin/$BASE` does not exist, say so and stop. In the Talli repo
that branch is the deploy source for the test site, so its absence is a
real problem worth surfacing rather than routing around; elsewhere it
means the topology was guessed wrong, which is worth knowing before a
branch is created from the wrong place.

### 7. Verify it worked

Do not report success from the exit code alone:

```bash
test -d "$WORKTREE/.git" || test -f "$WORKTREE/.git"
git -C "$WORKTREE" branch --show-current     # must equal $BRANCH
git -C "$WORKTREE" status --short            # should be empty
git -C "$WORKTREE" log --oneline -1
```

If any of these disagree, report the mismatch rather than the success
message.

### 8. Report

```
Agent workspace ready

Branch:       feature/booking-cancellation
Based on:     origin/staging @ f396224
Worktree:     /home/user/Talli-booking-cancellation
Repository:   /home/user/Talli

Open it:
  cd /home/user/Talli-booking-cancellation && claude

Nothing was deployed. Staging and production are untouched.
```

Always include a closing line saying nothing was deployed — it is the
point of the skill. In a repository with no staging or production to
speak of, say "Nothing was deployed." on its own.

## Never

- Deploy to Netlify, or run anything against Supabase.
- Modify `main` or `staging`, or any environment configuration.
- Overwrite an existing branch, worktree or directory without the user
  explicitly saying to.
- Create the worktree *inside* the repository — it must be a sibling, or
  git will see it as untracked content in its own parent.
- `git init`, `git reset --hard`, `git clean`, or force anything.
