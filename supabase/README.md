# Backend

`TESTING.md` in the repo root is the map of the two environments — sites,
branches, projects, keys. This file only covers what lives in here.

```
migrations/   SQL, applied in filename order
functions/    edge function sources, one directory per function
test-only/    scripts that must never be pointed at production
```

Both Supabase projects — `oxzwfemyavznykqixhvk` (production) and
`uhdoverwvlxvyyctskle` (test) — carry every migration in this directory.

## Three rules worth not relearning

**Prices are decided by the database, never by the browser.** The page names a
tier code and a list of `{code, qty}` extras. `hold_booking` and
`add_booking_addons` look up what those cost. Nothing in a request body is ever
treated as an amount.

**`CREATE OR REPLACE VIEW` resets reloptions.** Replacing a view silently drops
`security_invoker`, turning it into a SECURITY DEFINER view that bypasses RLS
for whoever queries it. That happened once already. Any migration replacing one
of these views must re-assert the setting immediately afterwards:

```sql
alter view <name> set (security_invoker = true);
```

**The `IS_TEST` blocks in the functions are fallbacks, never overrides.** They
compare the project's own `SUPABASE_URL` — injected by Supabase, not settable
by a caller — against the test project's ref, and only ever fill in a value
that has not been set: the test site's `SITE_URL`, a known gate passphrase, and
a stand-in for the Stripe round-trip. A real secret always wins, and on
production every one of them is unreachable. Deploying a function that has lost
these blocks quietly points the test site at production, so keep them when
merging.
