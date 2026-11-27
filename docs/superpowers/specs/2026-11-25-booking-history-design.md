# Booking history — design

## Why

On the night of 2026-11-24 Max told Andrew about a booking with a rego and a
name, no phone or email, and he wasn't sure it had been paid. Andrew couldn't
tell if it was one Max had just added at the gate or one Andrew had made
earlier for a customer who paid by bank transfer before the night. The
database knows when a booking was created but nothing records who created
it, and nothing on the gate screen shows when or who.

Goal: open any booking and read, in plain words, who created it, when, how,
and everything that has happened to it since.

## Goals

- A history line for each of these:
  - **created** (at the gate, by someone signed in; online by the customer)
  - **paid** (online via Stripe, or on the gate screen)
  - **details / payment / tier / price** edits
  - **checked in**
  - **placed / moved**
  - **cancelled, expired, refunded**
- Each line records **who** did it (`host_user`, or "customer online" /
  "Stripe" / "system" when no one signed in did it) and **when**.
- The history shows at the bottom of the booking's edit sheet on the gate
  screen.

## Non-goals

- A night-wide feed of what happened in time order (could come later; it
  reads the same table).
- Showing history to customers.
- Undoing changes from the history.

## Anti-goals

- Logging machinery (hold timers, space-code bookkeeping) that buries the
  lines that matter.
- A history that can be edited or deleted from the gate screen.
- Recording "who" from anything the browser sends. Who comes from the
  verified caller in gate-ops (`caller.me`), as `checked_in_by` already does.

## Constraints

- Build on `booking_change`
  (`20260929100000_talli_pay_later_and_edit_bookings.sql`). It cascades with
  the booking, so the test reset still clears it.
- Wardens see history only for bookings in blocks they can already see.
  gate-ops enforces this the same way as the edit sheet.
- History is written in the same database function as the change, so a
  change and its line succeed or fail together.

## Approaches

1. **Extend `booking_change` (chosen).** Add `by_host_user` and `by_label`,
   widen `kind`, and write a row from each database function that creates or
   changes a booking. Show it in the edit sheet. It builds on what exists,
   and every line is meaningful.
2. A trigger on `booking` logging every column change. Nothing is missed,
   but the noise is high, and "who" still has to be passed through each
   function.
3. Record only who created the booking, shown on the edit sheet. Cheapest,
   but there is no trail of later edits.

Andrew picked 1.

## The how

- **Names for staff** (Andrew's addition). The history says "Max", not an
  email address.
  - `host_user` gains `name text`.
  - The migration fills it for existing rows from the email's local part:
    split on `.`, `_`, `-` and `+`, drop digits, title-case each word
    (`max.smith@…` → "Max Smith").
  - The warden invite (Sites → People, `invite_warden`) gets a required
    **Name** field next to the email. A blank name is refused (`NO_NAME`).
  - The People list shows the name above the email, and the name can be
    corrected there (new gate-ops action `rename_staff`, operator only).
  - Andrew's own operator row gets a name the same way. Operators are
    still never made or changed from the People screen apart from the
    name.
  - Anywhere history shows a person, it uses `name`. It falls back to the
    email only if the name is somehow blank.
- **Migration** `talli_booking_history`:
  - `booking_change` gains `by_host_user uuid references host_user(id) on
    delete set null` and `by_label text` (for "customer online", "Stripe",
    "system").
  - `kind` widens to `created, paid, details, payment, tier, price,
    checked_in, placed, moved, cancelled, expired, refunded`.
  - `before` and `after` become nullable, since a creation has no before.
  - Backfill one `created` row per existing booking at its `created_at`,
    with no `by` ("who: not recorded").
- **Where lines come from** (revised at planning: about twelve functions
  write bookings, most of them long and restated, and most take no "who").
  - The existing `booking_change` inserts (details, payment, tier, price)
    stay as they are.
  - A trigger on `booking` writes the lifecycle lines in the same
    transaction as the change:
    - `created` on insert;
    - `paid`, `cancelled`, `expired`, `refunded` or `no_show` when
      `status` changes;
    - `checked_in` when `checked_in_at` is first set;
    - `moved` when `property_id` or `space_code` changes.
  - **Who** is `private.current_actor()`. It reads the `x-talli-actor`
    request header, which only gate-ops sets, from `caller.me`, on a
    per-request client. It is also `booking_change.by_host_user`'s
    default, so the existing inserts get "who" with no signature changes.
    Booking functions are callable only by the service role, so a browser
    cannot reach them to forge it.
  - With no actor, the trigger stores `by_label`:
    - "Customer online" for an online `created`;
    - "Stripe" for `paid` or `refunded` on a Stripe payment;
    - otherwise "System" (for example, expiry).
  - `cancel_unpaid_gate_booking` drops its own `payment` insert, since the
    trigger's `cancelled` line replaces it.
  - Lines from one transaction share `created_at`. The screen shows them
    as one entry: a gate sale is "Added at the gate · Max · 7:42pm ·
    Cash · checked in", not three lines.
- **gate-ops** gets a `booking_history` action returning the lines with
  the person's name. It is guarded by `bookingGuard`, as the edit sheet is.
  It is scope-checked like the edit sheet.
- **Edit sheet** (`assets/admin/booking-edit.js`): a "History" list at the
  bottom, newest last. Each line reads like "Added at the gate · Max ·
  Sat 7:42pm · Not paid yet", and a payment change reads "Not paid yet →
  Bank transfer".
- **Tests**: pgTAP for each function writing its line with the right `by`,
  the backfill, and that a warden can't read another block's history;
  Playwright for the history showing in the edit sheet after a gate sale
  and an edit.

## Left to the builder

- Exact wording of each line. Keep it short and use the screen's existing
  `METHOD_NAMES`.
- Whether `checked_in_by` and `booking_change` stay separate. Leave
  `checked_in_by` as is, and add the line as well.
- Tests also cover: the name backfill, an invite without a name being
  refused, and a rename showing up in an existing booking's history.
