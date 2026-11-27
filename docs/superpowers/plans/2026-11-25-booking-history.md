# Booking History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every booking carries a readable history (who did what, when) on
the gate screen's edit sheet, and every staff member has a name.

**Architecture:**
- One migration adds `host_user.name` and widens `booking_change`.
- A trigger on `booking` writes the lifecycle lines. "Who" comes from a
  request header that only gate-ops sets, from the verified caller.
- gate-ops sends that header on a per-request client and serves the
  history. The edit sheet renders it, grouping lines from one transaction
  into a single entry.

**Tech Stack:** Postgres/plpgsql (Supabase), pgTAP, Deno edge functions
(supabase-js 2.119.0), plain ES-module JS, Playwright, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-25-booking-history-design.md`

## Global Constraints

- Work only in `C:\Users\Andrew\Talli-booking-history`, on
  `feature/booking-history`. Commit nothing to `staging` or `main`. Deploy
  nothing.
- Migration file: `supabase/migrations/20261130100000_talli_booking_history.sql`.
  Its timestamp must sort after `20261129100000_talli_reviews.sql`.
- `booking_change.kind` values, exactly:
  `created, paid, details, payment, tier, price, checked_in, moved,
  cancelled, expired, refunded, no_show`.
- `by_label` values, exactly: `Customer online`, `Stripe`, `System`.
- Header name: `x-talli-actor`. Its value is a `host_user.id` uuid.
- New error code `NO_NAME` for a blank name on invite or rename.
- Validation is `bash scripts/check.sh`. Report any skipped suite as
  skipped.
- `booking_change` stays service-role only. No grant to anon or
  authenticated.

## Review Focus

- **Forged actor:** a malformed or non-uuid `x-talli-actor` header must
  give null "who", not an error that breaks a sale. Test it in Task 1.
- **Lines from one transaction:**
  - a gate sale must show as one entry, not three;
  - an unpaid → cash edit shows the payment change once.

  Test in Task 3 (unit, grouping function).
- **Warden reading another block's booking history:** refused with the
  same code as editing it. Test in Task 2.
- **Name backfill from odd emails:** `j.o'neil+gate2@x`, an email with no
  separators, and digits only must each give a non-empty name. Test in
  Task 1.
- **History of a booking whose staff member was deleted:** `by_host_user`
  is set null, so the line shows "Unknown" and does not crash. Test in
  Task 3 (unit).

---

### Task 1: Migration — names, history table, trigger

**Files:**
- Create: `supabase/migrations/20261130100000_talli_booking_history.sql`
- Test: `supabase/tests/database/19_booking_history.test.sql`

**Interfaces:**
- Produces:
  - `host_user.name text not null`
  - `private.name_from_email(text) returns text`
  - `private.current_actor() returns uuid`
  - `booking_change(by_host_user uuid null, by_label text null)`;
    `before` and `after` are nullable
  - `invite_warden(p_email text, p_name text, p_block_ids uuid[], p_by uuid)`
    returns the same jsonb as today
  - `rename_staff(p_host_user_id uuid, p_name text) returns jsonb {id, name}`
  - `booking_history(p_booking_id uuid) returns table(at timestamptz,
    kind text, before jsonb, after jsonb, by_name text, by_label text)`,
    oldest first
  - `staff_list()` rows gain `name`

- [ ] **Step 1: Write the failing pgTAP test** `19_booking_history.test.sql`.
  Use the fixture style of `17_transfer_before_check_in.test.sql`, rolled
  back. Assertions:
  - `private.name_from_email('max.smith@gmail.com') = 'Max Smith'`
  - `private.name_from_email('j.o''neil+gate2@x.nz') = 'J O''neil Gate'`
  - `private.name_from_email('123@x.nz')` is not null and not blank (it
    falls back to the local part as typed)
  - no `host_user` has a null or blank `name` after the migration
  - after `set_config('request.headers', '{"x-talli-actor":"<andrew host_user id>"}', true)`
    and a `sell_at_gate(..., 'cash', 'HIS001')`: rows for that booking have
    kinds `{created, paid, checked_in}`, all with that `by_host_user` and
    one shared `created_at`
  - with header `{"x-talli-actor":"not-a-uuid"}`, `sell_at_gate` still
    succeeds and its rows have null `by_host_user` and `by_label = 'System'`
  - with no header, `hold_booking(... channel 'online')` gives `created`
    with `by_label = 'Customer online'`, and `confirm_booking` gives
    `paid` with `by_label = 'Stripe'`
  - `edit_booking_at_gate(id, p_rego => 'NEW1')` gives a `details` row
    whose `by_host_user` comes from the header (via the column default)
  - `transfer_booking` to the neighbour site gives a `moved` row with
    `before.property_id` and `after.property_id`
  - `cancel_unpaid_gate_booking` gives exactly one row in its transaction:
    `cancelled` (no `payment` row)
  - `invite_warden('x@y.nz', '  ', ...)` throws `NO_NAME`
  - `rename_staff(id, 'Maxwell')` changes `booking_history(...).by_name`
    for that person's old lines
  - every existing booking has exactly one `created` row (backfill), with
    null `by_host_user` and null `by_label`

- [ ] **Step 2: Run it and see it fail.**
  Run: `bash scripts/check.sh --fast`.
  Expected: the database suite fails on `19_booking_history`.

- [ ] **Step 3: Write the migration**, in this order:
  1. `alter table host_user add column name text`, backfill with
     `private.name_from_email(email)`, then `set not null`.
     `name_from_email`:
     - local part before `@`;
     - split on `[._+-]`;
     - drop tokens that are all digits;
     - `initcap` each token, joined with spaces;
     - if nothing is left, the local part as typed.
  2. `private.current_actor()`: read
     `current_setting('request.headers', true)::json->>'x-talli-actor'`.
     Return it as a uuid only if it matches the uuid regex and exists in
     `host_user`; otherwise null. Never raise.
  3. `booking_change`:
     - add `by_host_user uuid references host_user(id) on delete set null default private.current_actor()`
       and `by_label text`;
     - drop not-null on `before` and `after`;
     - replace `booking_change_kind_check` with the Global Constraints
       list.
  4. Trigger function `private.booking_history_line()` (`after insert or
     update on booking`, for each row), using `private.current_actor()`:
     - **insert:** `created`, after =
       `{channel, payment_method, status, tier_code, property_id, amount_cents}`.
     - **update of status:** kind = the new status if it is in
       `paid/cancelled/expired/refunded/no_show`.
       before/after = `{status, payment_method}`.
     - **`checked_in_at` null → not null:** `checked_in`.
     - **`property_id` or `space_code` changed:** `moved`, before/after =
       `{property_id, space_code}`.
     - **`by_label` when there is no actor:**
       - `Customer online` for `created` with channel `online`;
       - `Stripe` for `paid`/`refunded` with payment_method `stripe`;
       - otherwise `System`.
  5. Backfill one `created` row per booking that has none, at
     `booking.created_at`, with null `by_host_user` and null `by_label`.
  6. Restate `cancel_unpaid_gate_booking` from
     `20260929100000_talli_pay_later_and_edit_bookings.sql` without its
     `insert into booking_change`.
  7. Restate `invite_warden` from
     `20261122100000_talli_warden_access.sql` with `p_name` after
     `p_email`:
     - drop the old signature first;
     - trim the name; raise `NO_NAME` when blank;
     - an existing invitation's name is updated.
  8. `rename_staff`: `NO_NAME` on blank; `NO_PERSON` when the id is
     missing.
  9. Restate `staff_list` adding `name`.
  10. `booking_history` joins `host_user` for `by_name`.
  11. Grants for every new or restated function, following the pattern
      already used in `talli_warden_access`: revoke from public, anon and
      authenticated; grant execute to service_role.

- [ ] **Step 4: Run it and see it pass.**
  Run: `bash scripts/check.sh --fast`.
  Expected: `19_booking_history` passes, and every earlier database test
  still passes. If one asserted the old `cancel_unpaid` `payment` row,
  update it to expect `cancelled`.

- [ ] **Step 5: Commit.** `git add supabase/ && git commit -m "Booking history: who did what to a booking, and a name for everyone at the gate"`

### Task 2: gate-ops — say who, serve history, names

**Files:**
- Modify: `supabase/functions/gate-ops/shared.ts` (add `dbAs`)
- Modify: `supabase/functions/gate-ops/index.ts` or `auth.ts`, wherever
  `Ctx` is built (add `db` to `Ctx`)
- Modify: `supabase/functions/gate-ops/handlers/arrivals.ts`, `staff.ts`
  and `events.ts` (use `ctx.db` for calls that write bookings; add the
  actions)
- Modify: `supabase/functions/gate-ops/auth.ts` (add `rename_staff` to
  `OPERATOR_ONLY`)
- Test: `tests/functions/booking-history.test.js`

**Interfaces:**
- Consumes: Task 1's functions.
- Produces:
  - `dbAs(hostUserId: string): SupabaseClient` creates a client with
    `global.headers = { 'x-talli-actor': hostUserId }`.
  - `Ctx.db` is that client for the request.
  - `booking_history { booking_id }` →
    `{ lines: [{at, kind, before, after, by_name, by_label}] }`, guarded
    by `bookingGuard`.
  - `rename_staff { host_user_id, name }` → `{ ok, id, name }`.
  - `invite_warden` takes `body.name`.

- [ ] **Step 1: Write the failing test** `booking-history.test.js`. Follow
  `warden-access.test.js` for sign-in and calls. Assertions:
  - operator `sell` then `booking_history` → kinds include `created`,
    `paid` and `checked_in`, each with `by_name` = the operator's seeded
    name;
  - a warden calling `booking_history` on a booking in a block they lack
    gets the same status and code as `edit_booking` on it;
  - `invite_warden` with no `name` → 409 `NO_NAME`;
  - a warden calling `rename_staff` is refused as operator-only;
  - the operator's `rename_staff` → `staff_list` shows the new name.
- [ ] **Step 2: Run it and see it fail.** `bash scripts/check.sh --fast`.
  Expected: `booking-history.test.js` fails.
- [ ] **Step 3: Implement.**
  - Every handler that calls a booking-writing RPC uses `ctx.db`. Reads
    may keep `db`.
  - Booking-writing RPCs: `sell_at_gate`, `edit_booking_at_gate`,
    `set_booking_price_at_gate`, `cancel_unpaid_gate_booking`,
    `check_in_*`, `place_booking`, `transfer_booking`,
    `add_booking_addons`, and anything else in `handlers/` that writes
    `booking`. Grep `rpc('` to find them.
- [ ] **Step 4: Run it and see it pass.** `bash scripts/check.sh --fast`.
  Expected: it passes, and the other function suites are unchanged.
- [ ] **Step 5: Commit.**

### Task 3: Gate screen — history on the edit sheet, names in People

**Files:**
- Create: `assets/admin/history.js`, exporting
  `historyEntries(lines): Array<{at, who, text}>` and
  `renderHistory(container, lines)`
- Modify: `assets/admin/booking-edit.js` (`openEdit` fetches
  `booking_history` and renders it under the form)
- Modify: `admin.html` (a `<section id="ad-edit-history">` in the edit
  sheet)
- Modify: `assets/admin/people.js` (a name input in `inviteForm`; the
  name shown above the email; an inline rename)
- Modify: the admin CSS file used by `ad-edit-*`, for a small muted
  list style
- Test: `tests/units/history.test.js` and
  `tests/browser/gate.spec.js` / `people.spec.js`

**Interfaces:**
- Consumes: Task 2's `booking_history`, `rename_staff` and
  `invite_warden(name)`.

- [ ] **Step 1: Write failing unit tests** for `historyEntries`:
  - `created`+`paid`+`checked_in` with the same `at` and by "Max" →
    one entry: `{who: 'Max', text: 'Added at the gate · Cash · checked in'}`
  - `payment` (before `unpaid`, after `bank_transfer`) plus `paid` with
    the same `at` → one entry: `'Payment: Not paid yet → Bank transfer'`
  - `by_name` null and `by_label` null → who `'Unknown'`
  - `by_label 'Customer online'` → who `'Customer online'`
  - an online `created` → text starts `'Booked online'`
  - the order is oldest first; the time is formatted like the rest of the
    screen (weekday + h:mm am/pm, NZ)
- [ ] **Step 2: Run and see them fail.** `bash scripts/check.sh --fast`.
- [ ] **Step 3: Implement `history.js`.**
  - Group by identical `at`.
  - Use `METHOD_NAMES` from `booking-edit.js`. Move it to `core.js` if
    importing it would be circular.
  - A `details` line names the fields that changed
    (`'Changed rego, phone'`).
  - `moved` reads `'Moved to <site name>'` when the site is known in
    `state`, else `'Moved'`.
- [ ] **Step 4: Wire it into the edit sheet and People.**
  - Browser tests:
    - in `gate.spec.js`, sell a walk-up, open it, and see one history
      line containing the operator's name and `Added at the gate`;
    - in `people.spec.js`, inviting without a name shows the `NO_NAME`
      message, and the name appears in the list after a valid invite.
- [ ] **Step 5: Run everything.** `bash scripts/check.sh`. Expected: all
  suites pass. List any that were skipped.
- [ ] **Step 6: Commit.**
