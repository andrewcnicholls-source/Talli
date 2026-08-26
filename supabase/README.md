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

**Test carries schema production has never seen**, from work that is in no
mainline branch. Inventoried against both databases on 26 Aug:

| Kind | Test only | Production |
| --- | --- | --- |
| Tables | `overflow_site`, `event_overflow_limit`, `booking_transfer`, `booking_cancellation` | absent |
| Functions | `cancel_booking_admin`, `transfer_booking_to_site`, `undo_booking_transfer`, `set_event_overflow_limit`, `set_event_status`, `set_event_sales_close` | absent |
| View | `v_overflow_site_status` | absent |
| `v_gate_list` columns | `customer_email`, `in_consent_zone`, `refundable_by_card`, `transfer_site_id`, `transfer_site_name`, `transferred_at`, `transfer_refund_cents` | absent |

None of it is in a migration file. None of it has a caller: `admin.js`
calls eight gate-ops actions (`list`, `events`, `check_in`, `hand_over`,
`sell`, `move_to_overflow`, `set_price`, `set_sold_out`, `adjust_capacity`)
and `gate-ops` implements exactly those. Nothing anywhere reads one of the
seven extra `v_gate_list` columns or calls one of the six functions.

What it *is*, read off the signatures: sending a car to a different site
with recorded consent and a partial refund, admin cancellation with a
refund, and event status / sales-close controls. A designed feature with
no interface.

**This does not mean production is missing anything it uses.** The
question came up as "the Tonight tab works on test but not production",
and that is not what is happening — checked at every layer on 26 Aug:

- production's deployed `gate-ops` is version 16 and carries all eight
  actions, `move_to_overflow` included;
- everything that path reads exists on production — `v_gate_list`,
  `v_night_capacity`, `v_tier_availability`, `v_bay_inventory`,
  `event_bay_status`, `reassign_booking`, `booking.accepts_street_parking`,
  and 35 consent-zone overflow bays;
- all three views return rows.

So the Tonight tab is whole on production, and this schema is genuinely
orphaned rather than a missing dependency.

**Do not promote it to production as a way of "catching production up".**
Two of those functions take refund amounts and Stripe refund IDs and
mutate booking state; putting them on the live database with no caller
adds surface to a payments system for no working feature. If the transfer
and cancellation feature is wanted, it wants: migrations written from the
existing test objects, the gate-ops actions built, the admin UI built, and
then the whole thing through staging and real device testing like anything
else.
