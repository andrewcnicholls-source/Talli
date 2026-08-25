# Backend

`TESTING.md` in the repo root is the map of the two environments — sites,
branches, projects, keys. This file only covers what lives in here.

```
migrations/   SQL, applied in filename order
functions/    edge function sources, one directory per function
test-only/    fixtures and resets that must never be pointed at production
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

## All six functions are here now

`stripe-webhook`, `register-interest` and `check-setup` came across with the
test-environment work, so `functions/` is the whole set rather than the three
this change touched.

**The `IS_TEST` blocks in the functions are fallbacks, never overrides.** They
compare the project's own `SUPABASE_URL` — injected by Supabase, not settable
by a caller — against the test project's ref, and only ever fill in a value
that has not been set: the test site's `SITE_URL`, a known gate passphrase, and
a stand-in for the Stripe round-trip. A real secret always wins, and on
production every one of them is unreachable. Deploying a function that has lost
these blocks quietly points the test site at production, so keep them when
merging.

## The two projects are NOT in step

Checked against both databases on 25 Aug, and the picture is better than it
looks from the migration ledgers but still not clean.

**The addons work is fully live on production.** All eight migrations are
applied, and `create-checkout`, `gate-ops` and `get-booking` are deployed at
bundle hashes identical to test. Production has been able to sell a poncho
since 21 Aug; only the front end was missing.

**Test's ledger under-reports what test actually has.** It stops at
`20260821093000_addons_at_the_gate`, so these four look missing:

```
20260821094000_name_the_spares
20260821095000_fold_duplicate_addon_lines
20260821096000_restore_security_invoker
20260821097000_event_interest_view_security_invoker
```

They are not. Verified directly: every view on test carries
`security_invoker`, `add_booking_addons` is the version that folds duplicate
codes before pricing, and both it and `addon_price_cents` have `search_path`
pinned. The effect is there; it was applied as raw SQL rather than through
`apply_migration`, so it never reached the ledger. Do not replay these four
blind — check the object first.

**Test carries schema production has never seen.** `overflow_site`,
`event_overflow_limit`, `booking_transfer`, `booking_cancellation` and extra
columns on `v_gate_list`, from work that is in no mainline branch. Worse, the
`gate-ops` deployed to test no longer has the actions that drive them —
`cancel_booking`, `transfer`, `undo_transfer`, `set_event_status`,
`set_sales_close`, `set_overflow_limit` all return `Unknown action`. That half
of the feature is orphaned: schema on test, code nowhere. Whoever brings the
two projects back into step has to decide what happens to it first.
