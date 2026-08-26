---
name: cleanup-agent
description: Safely remove an agent worktree once its work is merged or deliberately abandoned. Use when finished with an agent workspace, or when the user types /cleanup-agent. Refuses to delete uncommitted or unmerged work without explicit confirmation, treats git merge status as the only proof, and never removes the main checkout.
---

# cleanup-agent

Remove an agent's worktree once it is genuinely finished with.

```
/cleanup-agent
```

The only thing this skill is really for is refusing to delete work that
still matters. Deleting a directory is easy; knowing it is safe is the
job.

**Git merge status is the source of truth.** "I tested it on staging"
is not evidence a branch is merged — staging can be running a build
that predates the branch, or a build that includes it via someone
else's merge. Ask git.

## Steps

### 1. Establish what you are being asked to remove

```bash
git rev-parse --show-toplevel
git branch --show-current
git worktree list --porcelain
```

**In the Talli repository**, source `scripts/talli-env.sh` for
`$TALLI_INTEGRATION_BRANCH` and `$TALLI_PROTECTED_BRANCHES`.
**Anywhere else**, the integration branch is the remote's default:

```bash
BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null \
        | sed 's#^origin/##')"
```

Protected: that branch, plus any of `main`, `master`, `develop`,
`trunk`, `staging`, `release`, `production` that exist.

If run with no argument, the target is the worktree you are in. If run
with a name, resolve it against `git worktree list` and confirm the
match before doing anything.

### 2. Refuse the main checkout

The first entry in `git worktree list` is the main checkout. If the
target is that path, stop. Removing it destroys the repository. Say so
and offer to list the actual agent worktrees instead.

Also refuse if the target's branch is in `$TALLI_PROTECTED_BRANCHES`.

### 3. Check for uncommitted work

```bash
git -C "$TARGET" status --porcelain
git -C "$TARGET" stash list
```

Anything at all in either — modified, staged, untracked, stashed — and
you stop. Show the user the list. Explain that removing the worktree
deletes those files and they exist nowhere else. Offer to commit them
to the branch first.

Only proceed if the user explicitly says to discard them, having seen
what they are. Never `git clean`, never `git checkout -- .`, never
`--force` past this on your own judgement.

### 4. Check whether the branch is merged

```bash
git fetch origin --prune
git branch --contains "$BRANCH_TIP" -a
git merge-base --is-ancestor "$BRANCH_TIP" "origin/$BASE"
```

In Talli, check both branches, because they mean different things:

```bash
git merge-base --is-ancestor "$BRANCH_TIP" "origin/$TALLI_INTEGRATION_BRANCH"
git merge-base --is-ancestor "$BRANCH_TIP" "origin/$TALLI_PRODUCTION_BRANCH"
```

| Result | Meaning | What to do |
| --- | --- | --- |
| Ancestor of `origin/staging` | Merged and on the test site's branch | Safe |
| Ancestor of `origin/main` too | Also released to production | Safe |
| Ancestor of neither | **Unmerged** | Stop and warn |

Elsewhere, "merged into the integration branch" is the whole test —
being an ancestor of `origin/$BASE` is safe, anything else is not.

If the fetch fails, say the merge check is against stale refs and treat
the result as unproven. Do not guess.

If the branch is unmerged, report it plainly:

```
feature/booking-cancellation is NOT merged into staging.

3 commits would be lost:
  a1b2c3d Add cancellation window to the booking record
  d4e5f6a Show the cancel button before the gate opens
  b7c8d9e Handle a cancellation that arrives after check-in

The branch is pushed to origin, so removing the worktree would not
destroy them — they stay on the remote. Removing the local branch
as well would.
```

That distinction matters and is worth stating every time: an unmerged
branch that has been pushed is recoverable; one that has not is not.
Check with `git rev-parse "origin/$BRANCH"` before claiming either.

### 5. Remove the worktree

Only after the above. From the **main checkout**, not from inside the
worktree you are deleting:

```bash
git -C "$ROOT" worktree remove "$TARGET"
```

No `--force`. If git refuses, it has found something you missed —
report what it said rather than adding the flag.

### 6. Prune stale metadata

```bash
git -C "$ROOT" worktree prune
git -C "$ROOT" worktree list
```

`prune` only clears records of worktrees whose directories are already
gone. It never deletes a directory.

### 7. The local branch — separately, and only if asked

Removing a worktree does not remove its branch, and that is the safe
default. Delete the local branch only when it is confirmed merged, or
when the user explicitly asks having been told it is not:

```bash
git -C "$ROOT" branch -d "$BRANCH"     # merged only; refuses otherwise
```

Never `-D`. If `-d` refuses, that refusal is the check working.

Leave the **remote** branch alone unless asked. It is the backup.

### 8. Report exactly what happened

```
Removed

Worktree:      /home/user/Talli-booking-cancellation   (deleted)
Branch:        feature/booking-cancellation
  local:       deleted (merged into staging)
  origin:      still there
Merged into:   origin/staging ✓   origin/main ✓
Pruned:        1 stale worktree record

Remaining worktrees:
  /home/user/Talli                        [staging]
  /home/user/Talli-gate-refund            [feature/gate-refund]
```

If you removed the worktree but left the branch, say so, and say why.

## Never

- Delete the main checkout, or a worktree whose branch is protected.
- Remove a worktree with uncommitted, staged, untracked or stashed
  changes unless the user has seen the list and said to.
- Delete an unmerged branch on your own judgement.
- Use `worktree remove --force`, `branch -D`, `git clean`, or
  `push --delete` without being asked.
- Treat "it worked on staging" — or on any deployed environment — as
  proof a branch is merged. Ask git.
- Touch another agent's worktree because it looked idle.
