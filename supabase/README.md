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

There is a second Supabase project, `talli-test`, carrying a copy of the
original schema. None of these migrations have been applied to it.
