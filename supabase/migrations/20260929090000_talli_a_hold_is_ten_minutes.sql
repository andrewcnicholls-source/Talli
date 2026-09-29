-- =====================================================================
--  A hold is ten minutes, and the pay window closes first
--
--  A bay used to sit out of the yard for 34 minutes while somebody
--  thought about it. On a night that sells out in an hour that is a
--  space nobody can buy, for half an hour, because one person opened
--  a checkout tab and wandered off.
--
--  Ten minutes instead. The awkward part is Stripe: a Checkout Session
--  cannot be created with an expiry sooner than 30 minutes, so the
--  session always outlives the hold. Left alone, that inverts the one
--  rule this flow has ever had — the customer could pay at minute
--  twenty for a bay that went back on sale at minute ten.
--
--  So the session is no longer allowed to die of old age. It is killed
--  early, by the `expire-holds` edge function, at a deadline written on
--  the booking itself:
--
--    checkout_expires_at   t + 8   Stripe is shut off here
--    hold_expires_at       t + 10  the bay is back on sale here
--
--  Two minutes between them, for a payment already in flight to land.
--  Same shape as the 30/34 pair it replaces, an hour shorter.
--
--  Two things in this file, and the second is the one that matters:
--
--    1. checkout_expires_at, so the sweep knows when to shut Stripe off
--       without having to know what constant create-checkout was built
--       with. A booking carries its own deadline; changing the constant
--       later cannot retroactively move one already in flight.
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
  'When the Stripe Checkout Session for this hold must stop accepting '
  'payment. Set by create-checkout, enforced by the expire-holds function. '
  'Always earlier than hold_expires_at, so money cannot land on a bay that '
  'has gone back on sale. Null for gate sales and stubbed test payments, '
  'which never had a session to expire.';

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
