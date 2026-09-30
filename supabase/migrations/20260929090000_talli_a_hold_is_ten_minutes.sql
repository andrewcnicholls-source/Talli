-- =====================================================================
--  A hold is ten minutes once the night is close
--
--  A bay used to sit out of the yard for 34 minutes while somebody
--  thought about it. Two weeks out that costs nothing. At quarter past
--  six, with online sales closing at T-45, it is a space that never
--  gets sold at all.
--
--  So the hold is now short only where short buys something:
--
--    more than 3h to kickoff    34 min hold, Stripe's own 30 min expiry
--    inside 3h to kickoff       10 min hold, 8 min to pay
--
--  The far case is unchanged from what shipped before — the hold
--  outlasts the session, the session dies of old age, the webhook
--  returns the bay, and nothing sweeps anything. The near case is the
--  awkward one: Stripe will not create a Checkout Session expiring
--  sooner than 30 minutes, so there the session OUTLIVES the hold, and
--  left alone that inverts the one rule this flow has ever had — pay at
--  minute twenty for a bay resold at minute ten.
--
--  Near kickoff, then, the session is not allowed to die of old age. It
--  is killed early by the `expire-holds` edge function, at a deadline
--  written on the booking itself, with two minutes of daylight before
--  the hold lapses for a payment already in flight.
--
--  Two things in this file, and the second is the one that matters:
--
--    1. checkout_expires_at, so the sweep knows when to shut Stripe off
--       without having to know which regime the booking was made under,
--       or what constant create-checkout was built with. A booking
--       carries its own deadline, or carries none and is left alone.
--
--    2. confirm_booking stops confirming a hold that has run out.
--       Without this the sweep is load-bearing: miss a run, and a late
--       payment quietly confirms onto a bay that private.tier_sold has
--       already counted back as free — an oversell, discovered in the
--       driveway, by two people with the same space. With it, the same
--       miss is refused, and the webhook's existing "PAID BUT NOT
--       ALLOCATED" alarm fires instead. A refund is a bad night. Two
--       cars and one space is a worse one.
-- =====================================================================

alter table booking
  add column if not exists checkout_expires_at timestamptz;

comment on column booking.checkout_expires_at is
  'When the Stripe Checkout Session for this hold must be shut off by hand. '
  'Set by create-checkout only for a booking made inside the last few hours '
  'before kickoff, where the hold is shorter than Stripe can create a '
  'session for; enforced by the expire-holds function. Always earlier than '
  'hold_expires_at, so money cannot land on a bay that has gone back on '
  'sale. Null everywhere else — a booking made further out, a gate sale, a '
  'stubbed test payment — meaning there is nothing for the sweep to do.';

-- What the sweep reads, every minute, and nothing else does.
create index if not exists booking_checkout_expiry_idx
  on booking (checkout_expires_at)
  where status = 'held' and stripe_checkout_session_id is not null;

-- ---------------------------------------------------------------------
--  confirm_booking, with the hold's own clock respected.
--
--  Unchanged from 20260814115741 apart from the expiry test. 'paid' is
--  still accepted unconditionally so a duplicate webhook delivery stays
--  idempotent — that row already owns its bay and is not being asked to
--  take one. Only a 'held' row has to still be inside its hold.
--
--  hold_expires_at is null is treated as live, the same way
--  private.tier_sold treats it: a hold with no clock on it is one the
--  database never put a clock on, not one that has run out.
-- ---------------------------------------------------------------------
create or replace function confirm_booking(
  p_booking_id uuid, p_payment_intent_id text default null
) returns void
language plpgsql set search_path = public as $$
begin
  update booking
     set status = 'paid', paid_at = now(), hold_expires_at = null,
         checkout_expires_at = null,
         stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id)
   where id = p_booking_id
     and (status = 'paid'
          or (status = 'held'
              and (hold_expires_at is null or hold_expires_at > now())));
end;
$$;

comment on function confirm_booking(uuid, text) is
  'Turn a live hold into a paid booking. Refuses a hold whose clock has '
  'run out — the caller sees the row still sitting at "held" and must '
  'refund or place the car by hand, rather than sell the bay twice.';

revoke execute on function confirm_booking(uuid, text) from public, anon, authenticated;

-- release_booking already nulls hold_expires_at; the new column goes the
-- same way, so an expired or cancelled row carries no stale deadline for
-- the sweep to trip over.
create or replace function release_booking(
  p_booking_id uuid, p_status text default 'cancelled'
) returns void
language plpgsql set search_path = public as $$
begin
  delete from bay_allocation where booking_id = p_booking_id;
  update booking
     set status = p_status, hold_expires_at = null, checkout_expires_at = null
   where id = p_booking_id;
end;
$$;

revoke execute on function release_booking(uuid, text) from public, anon, authenticated;
