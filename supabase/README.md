# Backend

Until now the database schema and the edge functions lived only inside the
Supabase project, which made them impossible to review and easy to lose. This
directory is the record of both.

```
migrations/   SQL, applied in filename order
functions/    edge function sources, one directory per function
```

Everything here has already been applied to the live project
(`oxzwfemyavznykqixhvk`) — the one `assets/talli-config.js` points at, and the
one talli.co.nz talks to. The files are the record, not a pending queue.

## Two rules worth not relearning

**Prices are decided by the database, never by the browser.** The page names a
tier code and a list of `{code, qty}` extras. `hold_booking` and
`add_booking_addons` look up what those cost. Nothing in a request body is ever
treated as an amount.

**`CREATE OR REPLACE VIEW` resets reloptions.** Replacing a view silently drops
`security_invoker`, which turns it into a SECURITY DEFINER view that bypasses
RLS for whoever queries it. Any migration that replaces one of these views must
re-assert the setting immediately afterwards:

```sql
alter view <name> set (security_invoker = true);
```

## Only partly covered here

`stripe-webhook`, `register-interest` and `check-setup` were not touched by this
change, so their sources are not in the repo yet. They are still live in the
Supabase project. Worth exporting next time one of them needs an edit.

## Both Supabase projects are in step

Every migration and all three functions have been applied to **both**
`oxzwfemyavznykqixhvk` (production) and `uhdoverwvlxvyyctskle` (test). The
deployed function bundles hash identically across the two.

What is **not** in step is the front end. `talli-test.netlify.app` is meant to
build the `staging` branch, which does not exist yet — see `TESTING.md` on
`claude/test-environment-setup-kaaudq`, where that setup lives unmerged. Until
those branches come together, the test site is serving the old pages against
an updated test database.

That branch also rewrites `assets/talli-config.js` into a hostname-based
environment switch. This branch changed the same file. Whoever merges them
must keep the environment switch and carry `gateTierOrder` across — though
`admin.js` now defaults that list internally, so a bad merge degrades into
nothing worse than a stale comment.
