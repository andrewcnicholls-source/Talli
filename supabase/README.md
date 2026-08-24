# Backend

Until now the database schema and the edge functions lived only inside the
Supabase project, which made them impossible to review and easy to lose. This
directory is the record of both.

```
migrations/   SQL, applied in filename order
functions/    edge function sources, one directory per function
test-only/    fixtures and resets that must never run on production
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

## All six functions are here now

`stripe-webhook`, `register-interest` and `check-setup` came across with the
test-environment work, so `functions/` is the whole set rather than the three
this change touched.

Three of them carry a TEST-PROJECT FALLBACKS block: `create-checkout` (a
`SITE_URL` default and a stubbed Stripe round-trip), `gate-ops` (a known
`GATE_PASSPHRASE`) and `check-setup`. Each one keys off `IS_TEST`, which
compares the project's own injected `SUPABASE_URL` against the test project's
ref — so on production every fallback is unreachable, and a real secret always
wins over one.

## The two projects are NOT in step

Production has every migration in this directory. Test does not: as of the
merge it stops after `20260821093000_addons_at_the_gate`, so it is missing

```
20260821094000_name_the_spares
20260821095000_fold_duplicate_addon_lines
20260821096000_restore_security_invoker
20260821097000_event_interest_view_security_invoker
```

The third of those matters most. `v_gate_list` on test still has no
`security_invoker`, which is exactly the SECURITY DEFINER defect this change
fixed on production — a test-project anon key can read draft tiers and prices.
It is the test database, so nothing real is exposed, but do not read a green
run there as proof the fix works.

Test also carries schema production has never seen — `overflow_site`,
`booking_transfer` and friends, from work that is not in this repo. Whoever
brings the two back into step has to reconcile that first, not just replay the
four migrations above.
