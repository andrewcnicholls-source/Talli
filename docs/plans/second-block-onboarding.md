# Plan: onboard a second block, and formalise the sites in the first

Written 11 Nov 2026 from a read of `staging` at `4118276` and read-only
queries against both Supabase projects. Every "today" statement below was
checked on that date; re-check before relying on one.

This file is a brief for agents. Each workstream in § 5 is sized to be one
`/new-agent <task>` branch. Read § 1–4 first whichever one you pick up.

## 1. Words

Andrew says "zone" for a cluster of driveways. **In the code that is a
`block`.** The code's `zone` is an area inside one property (lawn, berm,
valet lane) and is not what this plan is about.

| Andrew says | Table | Meaning |
| --- | --- | --- |
| zone / area | `block` | A cluster of nearby driveways one warden covers. What the customer books: "<anchor address> or within 100m". |
| site / property / driveway | `property` | One driveway, with one `host` who is paid for it. |
| — | `zone` | An area within one property. Leave alone. |

## 2. Where things stand today

**The block machinery is built, but only on staging and the test project.**

- `main` is at PR #31. `staging` is eight PRs ahead (#32–#39): blocks,
  wardens, the booking map, the Sites tab.
- The production database stops at `talli_price_one_car`. It has no
  `block`, `staff_block_access` or `property_tier_default` table. These
  five migrations are unapplied there:
  `20261105100000_talli_blocks_and_wardens`,
  `20261105110000_talli_add_site_to_event`,
  `20261106100000_talli_site_map_view`,
  `20261106120000_talli_site_map_price`,
  `20261107100000_talli_site_setup`.
- `gate-ops`, `create-checkout`, `get-booking` and `stripe-webhook` differ
  between `main` and `staging`, so all four need deploying with the release.
- Production has two properties, `86 Paice Ave` (Talli Limited, 4 zones)
  and `84 Paice Ave berm` (a neighbour host). Every upcoming event offers
  only `86 Paice Ave`. The other driveways used on a busy night are not in
  the system at all — that is the "informal" part.
- Next production event: Robbie Williams, 24 Nov 2026, already on sale.

**What already works on staging** (do not rebuild):

- Booking page: one card and one map pill per block, `pick_block_property`
  chooses the driveway (anchor first, then most room).
- Confirmation page and email say "<anchor> or a driveway within 100m"
  when a block has more than one site selling that event.
- Sites tab (operator only): create a site with a new or existing block,
  set usual spaces per type, online share, price offset, map position.
- Tonight tab: add a site to one event (joins `pending`), put it on sale
  (`confirmed`) or pause it.
- Wardens: `host_user.scope = 'blocks'` plus `staff_block_access` limits a
  warden to Arrivals for their blocks. Enforced in `gate-ops`
  (`allowedProperties`, `mayTouchBooking`).
- Check-in records the driveway the car actually went to and which warden.

## 3. Gaps this plan closes

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | Blocks are not on production. | § 2 |
| G2 | **Price shown can differ from price charged.** The booking page shows the anchor's price for a block (`v_block_tier_availability`), but `hold_booking` charges the tier price of whichever property `pick_block_property` chose, and offsets are per property (`property.price_offset_cents`). Two sites in one block with different offsets means a customer can be charged a figure they were never shown. | `20261105100000` § 7, `20261107100000` `apply_price_offsets` |
| G3 | A site cannot be edited after creation: name, address, host, block, active, `site_guide_url`, `fill_notes`, `walk_minutes`. A block cannot be edited at all: name, anchor, position, order, active. | `gate-ops` `save_site` only takes offset and tiers |
| G4 | A warden is invited and granted blocks only by SQL. | `gate-ops` reads `staff_block_access`, never writes it; see `supabase/test-only/seed-test-block.sql` |
| G5 | A new event starts with one property, and each other site is added per event by hand. Eight upcoming events × every new site is a lot of taps, and a missed one sells nothing. | `create_gate_event` takes one `p_property_id`; `default_event_property()` picks by zone count |
| G6 | Host money is not reportable. `host_earnings_cents` is fixed at hold time from the *booked* property, but the design says hosts are paid for cars that *parked* on their site, and check-in can move the car. `create_site` hard-codes a 50% share and a placeholder host email with no way to change either. No screen shows what each host is owed. | `hold_booking`, `check_in_booking_at`, `create_site` |
| G7 | `getting-here.html` and `eden-park.html` are written for 86 Paice Ave only (address, map embed, "750m, 8-minute walk"). A customer booked into the second block is sent to the wrong street. | those two files |
| G8 | Nothing in `TESTING.md` covers a multi-block night, and `scripts/check.sh` asserts nothing about warden scoping. | grep of both |

## 4. Decisions only Andrew can make

Agents: do not guess these. If your workstream depends on one that is
unanswered, stop and ask.

1. **The second block:** its name, anchor address, the properties in it,
   each one's host, usual spaces per type and how many sell online.
2. **The first block's informal sites:** which driveways become
   properties, and who the host of each is.
3. **Pricing:** is price set per block (recommended — it is what the
   customer is shown) or may sites within one block differ? G2 is fixed
   differently depending on the answer.
4. **Host split:** the share per host, and whether a host is paid for
   cars booked at their site or cars parked there.
5. **Wardens:** who covers the second block (the Google account email
   they will sign in with).
6. **Tier codes:** `property_tier_default` allows only `standard`,
   `priority`, `valet`. Confirm the second block sells no other type.
7. **First live night** for the second block, which sets the deadline.

## 5. Workstreams

Order: **W0 → W1 → (W2, W3, W4, W5, W6 in parallel) → W7 → W8**.
W1 is the only one that must land before the second block sells a space.

### W0 — Release what is on staging (Andrew, not an agent)

`/release-production` once staging is device-tested. Migrations and the
four edge functions go first, then the Pages deploy. After it:

- `block` exists on production with one row, `Paice Ave`, anchored on
  `86 Paice Ave`; both existing properties are in it.
- Every existing `event_offer` is `confirmed`, so nothing comes off sale.
- Check `host.is_operator` is true for Talli Limited only.
- Check `host.platform_share`: production currently holds `0` for Talli
  Limited and `1` for the berm host, the reverse of what the column
  comment describes (1.0 = Talli keeps everything). Harmless today, wrong
  the moment W5 reports on it.

### W1 — `block-pricing`: one price per block  *(fixes G2; blocks go-live)*

- Decide per § 4.3. Recommended: move the offset to the block
  (`block.price_offset_cents`), have `apply_price_offsets` price every
  property from its block's offset, and keep `property.price_offset_cents`
  only if Andrew wants within-block differences.
- Whatever the model, add a guard so a customer is never charged more
  than shown: `create-checkout` should pass the price the page displayed
  as an *expectation* (never as an amount to charge) and refuse with a
  named error if the held booking's `amount_cents` differs.
- Sites tab: move the offset field to the block if the model changes.
- Files: new migration, `supabase/functions/create-checkout/index.ts`,
  `supabase/functions/gate-ops/index.ts`, `assets/admin.js`,
  `assets/booking.js`.
- Done when: on test, two sites in one block with the anchor full show
  and charge the same figure, and a forced mismatch is refused by name.

### W2 — `site-and-block-editing`  *(G3)*

- gate-ops actions (operator only): `save_site_details` (name, address,
  host name, block, active, map position, `walk_minutes`,
  `site_guide_url`, `fill_notes`) and `save_block` (name, anchor,
  position, sort order, active).
- Guards: a site with bookings on an upcoming event cannot be
  deactivated or moved to another block; a block's anchor must be one of
  its own active properties.
- Sites tab UI for both.
- Done when: every field `create_site` sets, and every block field, can
  be changed from a phone with no SQL.

### W3 — `warden-access`  *(G4)*

- gate-ops actions (operator only): `staff_list`, `staff_invite` (email
  + blocks → `host_user` row with `scope = 'blocks'`, `user_id` null),
  `staff_set_block` (flip `staff_block_access.active`), `staff_set_active`.
- A "People" section on the Sites tab.
- Must not weaken: the three auth checks, `NO_BLOCKS` for a warden with
  every grant off, and the rule that the email comes from the verified
  token, never the request body.
- Add a `scripts/check.sh` assertion that these actions are refused for
  a `blocks`-scoped caller.
- Done when: Andrew can invite a warden, grant one block, and revoke it,
  from the screen; the warden sees only that block's Arrivals.

### W4 — `event-site-rollout`  *(G5)*

- "Add to all upcoming events" when creating or editing a site: calls
  `add_event_offer` for each future event not `closed`/`cancelled`,
  joining as `pending`.
- New events include every active site by default (pending for all but
  the operator's), using each site's `property_tier_default`.
- A per-event view on Tonight that lists sites by block with status, so
  a pending site on a night about to go on sale is obvious.
- Replace `default_event_property()`'s zone-count guess with
  `reference_property()`.
- Done when: creating one site and one event needs no per-event taps
  except confirming each site for sale.

### W5 — `host-settlement`  *(G6)*

- Depends on § 4.4. Recommended: pay on where the car parked, computed
  at reporting time from `booking.property_id`, not stored at hold.
- Editable host details: share, real email, payout notes.
- Insights: per event, per host and site — cars parked, cars booked,
  takings by channel and payment method, host share owed, cash held by
  each warden (`cash_collected_by`).
- Read-only reporting first. No Stripe Connect in this workstream.
- Done when: after a test night with a car moved between two hosts'
  driveways, the report attributes it per the chosen rule.

### W6 — `directions-per-block`  *(G7)*

- `getting-here.html` and the walking section of `eden-park.html` take
  the block from the booking (link from the confirmation page and email
  carries it) and show that block's anchor address, map links and walk
  time. With no block given, list every active block.
- Source the data from `block` / anchor `property` (`walk_minutes`,
  `lat`, `lng`), not from HTML.
- The footer's "86 Paice Ave" is the company address and stays.
- Done when: a booking in the second block never shows a Paice Ave
  direction anywhere in the customer journey.

### W7 — `multi-block-test-night`  *(G8)*

- Extend `supabase/test-only/seed-test-block.sql` to mirror the real
  shape: two blocks, two or more sites each, different hosts, one warden
  per block.
- Add a device-test script to `TESTING.md`: book into each block; fill
  an anchor so the next booking lands on a neighbour; warden signs in
  and sees one block; check a car in at a different driveway; sell at
  the gate; pause a site mid-sale; read the settlement report.
- `scripts/check.sh`: assert the new views keep `security_invoker`, and
  that every gate-ops action taking a booking id goes through
  `mayTouchBooking`.

### W8 — Go-live runbook (Andrew, on production, after W1–W7 release)

1. Sites tab: create the second block with its anchor, then each other
   site. Set spaces, online share, position.
2. Create the first block's informal driveways as sites the same way.
3. Invite the warden and grant the block.
4. Add the sites to the chosen events; they join `pending`.
5. Check the booking page still shows only confirmed sites.
6. Confirm each site once its host has said yes for that night.
7. Make one real booking in the new block and check the confirmation
   page, the email, the directions, and the warden's Arrivals list.

## 6. Rules for every agent on this plan

- Follow `CLAUDE.md`: work in a worktree on `feature/<task>`, PR base is
  `staging` (not GitHub's default), `bash scripts/check.sh` is the only
  validation command.
- Develop against the **test** project only. Production changes go
  through `/release-production`.
- Migrations are additive. Any `create or replace view` must re-assert
  `security_invoker = true` (see `supabase/README.md`).
- `hold_booking`, `v_gate_list` and `create_gate_event` have each been
  restated in several migrations. Start from the newest definition, and
  check no other open branch is restating the same object.
- Prices come from the database. Nothing in a request body is an amount.
- Fixtures are invented. Never copy real hosts, customers or addresses
  into test.
- W1–W5 all touch `gate-ops/index.ts` and `assets/admin.js`. Keep each
  change to its own `case` blocks and functions, and rebase on `staging`
  before opening the PR.
