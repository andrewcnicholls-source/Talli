-- =====================================================================
--  Talli Parking — pay later, and fix a booking after the fact
--
--  Two things from the last night on the driveway.
--
--  1. "I got stuck half completing a booking, then got stuck at the
--     payment choice. Had to repeat some of them."
--
--     The walk-up form was all-or-nothing: the sale only existed once the
--     money had been taken. So a terminal that would not connect, or a
--     driver still finding their wallet, threw away the plate and the
--     name that had already been typed. Now there is a fourth way to pay:
--     'unpaid'. The details are saved, the space is taken and the car is
--     ticked in; the money is captured afterwards from the booking itself.
--
--     An unpaid gate sale is a hold that never runs out: status 'held',
--     hold_expires_at null. tier_sold() already counts exactly that as a
--     space taken, expire_stale_holds() already leaves it alone (null is
--     never < now()), and nothing counts it as money taken until it is
--     paid. No reader has to learn a new status.
--
--  2. "I want to be able to click into an individual and change their
--     license plate or contact details, how they paid, etc. ... someone
--     paid for valet and ended up in priority. No refund was required,
--     but I needed to relocate parking so I attributed spots to how they
--     were actually used."
--
--     edit_booking_at_gate() does all of it in one transaction: the
--     details, the payment method, and moving the booking to another
--     type of space. Moving a paid booking keeps what they paid — no
--     refund, no top-up — and moves the space they are counted against.
--     Moving an unpaid one re-prices it, since nothing has changed hands.
--
--     Every change is written to booking_change, so the night can still
--     be reconciled after its figures have been corrected.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. 'unpaid' is a payment method.
--
--  The constraint was created inline in 20260814121108, so its name is
--  whatever Postgres chose. Drop every check on booking that constrains
--  payment_method rather than guessing the name.
-- ---------------------------------------------------------------------
do $$
declare v_name text;
begin
  for v_name in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.booking'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%payment_method%'
  loop
    execute format('alter table booking drop constraint %I', v_name);
  end loop;
end;
$$;

alter table booking
  add constraint booking_payment_method_check
  check (payment_method in
    ('stripe','cash','tap_to_pay','bank_transfer','free','other','unpaid'));

-- card_surcharge_cents() only surcharges 'stripe' and 'tap_to_pay', so an
-- unpaid booking carries no surcharge until it is paid by card — and the
-- booking_surcharge trigger re-works it the moment payment_method moves.

-- ---------------------------------------------------------------------
--  2. The walk-up, with "pay later".
--
--  Same signature as 20260907100000, so this replaces rather than adds an
--  overload. The only change: 'unpaid' keeps the hold open-ended instead
--  of confirming it.
-- ---------------------------------------------------------------------
create or replace function sell_at_gate(
  p_event_id      uuid,
  p_property_id   uuid,
  p_tier_code     text,
  p_payment_method text default 'cash',
  p_rego          text default null,
  p_name          text default null,
  p_phone         text default null,
  p_email         text default null,
  p_accepts_street boolean default false,
  p_low_clearance boolean default false
) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  if p_payment_method = 'stripe' then
    raise exception 'BAD_METHOD: a gate sale cannot be paid online'
      using errcode = 'check_violation';
  end if;

  v_id := hold_booking(
    p_event_id, p_property_id, p_tier_code,
    coalesce(p_email, 'gate+' || replace(gen_random_uuid()::text,'-','') || '@talli.co.nz'),
    p_name, p_phone, p_rego, 5, 'gate', p_accepts_street, p_payment_method,
    p_low_clearance);

  if p_payment_method = 'unpaid' then
    -- Holds the space until someone takes the money or cancels it.
    update booking set hold_expires_at = null where id = v_id;
  else
    perform confirm_booking(v_id, null);
  end if;

  perform check_in_booking(v_id);
  return v_id;
end;
$$;

revoke execute on function sell_at_gate(
  uuid, uuid, text, text, text, text, text, text, boolean, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  3. What was changed, and from what.
--
--  Cascades with the booking, so the test reset — which clears bookings
--  before events — clears this too without being told about it.
-- ---------------------------------------------------------------------
create table if not exists booking_change (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references booking(id) on delete cascade,
  kind        text not null check (kind in ('details','payment','tier')),
  before      jsonb not null,
  after       jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists booking_change_booking_idx
  on booking_change (booking_id, created_at);

comment on table booking_change is
  'Edits made to a booking from the gate screen: contact details, how it '
  'was paid, and moves between types of space. One row per kind of change.';

alter table booking_change enable row level security;
revoke all on booking_change from anon, authenticated;

-- ---------------------------------------------------------------------
--  4. Edit a booking.
--
--  Every argument after the id is optional: null means "leave it". An
--  empty string for a text field clears it — except email, which a
--  booking must have, so a blank email leaves the one it has.
--
--  Online checkouts still in progress (a hold with a clock on it) can
--  have their details corrected, but not their payment or their type:
--  Stripe is about to settle them, and it settles what it was sold.
-- ---------------------------------------------------------------------
create or replace function edit_booking_at_gate(
  p_booking_id     uuid,
  p_name           text    default null,
  p_phone          text    default null,
  p_email          text    default null,
  p_rego           text    default null,
  p_low_clearance  boolean default null,
  p_notes          text    default null,
  p_payment_method text    default null,
  p_tier_code      text    default null
) returns jsonb
language plpgsql set search_path = public as $$
declare
  b        booking%rowtype;
  v_tier   offer_tier%rowtype;
  v_share  numeric(5,4);
  v_price  integer;
  v_sold   integer;
  v_before jsonb;
  v_after  jsonb;
  v_email  text;
begin
  select * into b from booking where id = p_booking_id for update;
  if not found then
    raise exception 'NO_BOOKING: no such booking' using errcode = 'check_violation';
  end if;
  if b.status not in ('paid', 'held') then
    raise exception 'BOOKING_CLOSED: this booking is % and cannot be edited', b.status
      using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------------------ details
  v_email := nullif(trim(coalesce(p_email, '')), '');
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'BAD_EMAIL: "%" is not an email address', v_email
      using errcode = 'check_violation';
  end if;

  v_before := jsonb_build_object(
    'name', b.customer_name, 'phone', b.customer_phone,
    'email', b.customer_email, 'rego', b.vehicle_rego,
    'low_clearance', b.vehicle_low_clearance, 'notes', b.notes);

  update booking set
    customer_name  = case when p_name  is null then customer_name
                          else nullif(trim(p_name), '') end,
    customer_phone = case when p_phone is null then customer_phone
                          else nullif(trim(p_phone), '') end,
    customer_email = coalesce(v_email, customer_email),
    vehicle_rego   = case when p_rego  is null then vehicle_rego
                          else nullif(upper(trim(p_rego)), '') end,
    vehicle_low_clearance = coalesce(p_low_clearance, vehicle_low_clearance),
    notes          = case when p_notes is null then notes
                          else nullif(trim(p_notes), '') end
  where id = b.id
  returning * into b;

  v_after := jsonb_build_object(
    'name', b.customer_name, 'phone', b.customer_phone,
    'email', b.customer_email, 'rego', b.vehicle_rego,
    'low_clearance', b.vehicle_low_clearance, 'notes', b.notes);

  if v_after is distinct from v_before then
    insert into booking_change (booking_id, kind, before, after)
    values (b.id, 'details', v_before, v_after);
  end if;

  -- An online checkout that is still running belongs to Stripe.
  if b.status = 'held' and b.hold_expires_at is not null
     and ((p_tier_code is not null and p_tier_code <> b.tier_code)
          or (p_payment_method is not null and p_payment_method <> b.payment_method)) then
    raise exception 'IN_CHECKOUT: this booking is still being paid for online — '
      'wait for it to finish before changing the space or the payment'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------- type of space
  if p_tier_code is not null and p_tier_code <> b.tier_code then
    select t.* into v_tier
      from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = b.event_id and o.property_id = b.property_id
       and t.code = p_tier_code and t.active
       for update of t;
    if not found then
      raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
        using errcode = 'check_violation';
    end if;

    -- The gate may sell into the walk-up reserve, and so may a move.
    -- What it may not do is claim a space that is not there.
    v_sold := private.tier_sold(b.event_id, b.property_id, p_tier_code);
    if v_sold >= coalesce(v_tier.capacity, 0) then
      raise exception 'SOLD_OUT: every "%" space is already taken — add one on the Tonight tab first',
        p_tier_code
        using errcode = 'check_violation';
    end if;

    v_before := jsonb_build_object('tier_code', b.tier_code,
      'amount_cents', b.amount_cents);

    -- Paid: what they paid stands, in either direction. Unpaid: nothing
    -- has changed hands, so they owe what the space they got costs.
    if b.status = 'paid' then
      v_price := b.amount_cents;
    else
      v_price := v_tier.price_cents;
    end if;

    select h.platform_share into v_share
      from property pr join host h on h.id = pr.host_id where pr.id = b.property_id;

    update booking set
      tier_code           = v_tier.code,
      arrival_from        = v_tier.arrival_from,
      arrival_until       = v_tier.arrival_until,
      must_depart_by      = v_tier.departure_by,
      amount_cents        = v_price,
      platform_fee_cents  = round(v_price * coalesce(v_share, 0)),
      host_earnings_cents = v_price - round(v_price * coalesce(v_share, 0))
    where id = b.id
    returning * into b;

    insert into booking_change (booking_id, kind, before, after)
    values (b.id, 'tier', v_before,
            jsonb_build_object('tier_code', b.tier_code, 'amount_cents', b.amount_cents));
  end if;

  -- --------------------------------------------------------- payment
  if p_payment_method is not null and p_payment_method <> b.payment_method then
    if b.payment_method = 'stripe' then
      raise exception 'PAID_ONLINE: this was paid by card on the website — Stripe holds that record'
        using errcode = 'check_violation';
    end if;
    if p_payment_method = 'stripe' then
      raise exception 'BAD_METHOD: only the website can take an online payment'
        using errcode = 'check_violation';
    end if;
    if p_payment_method not in ('cash','tap_to_pay','bank_transfer','free','other','unpaid') then
      raise exception 'BAD_METHOD: "%" is not a way to pay', p_payment_method
        using errcode = 'check_violation';
    end if;

    v_before := jsonb_build_object('payment_method', b.payment_method,
      'status', b.status, 'surcharge_cents', b.surcharge_cents);

    if p_payment_method = 'unpaid' then
      update booking set payment_method = 'unpaid', status = 'held',
             paid_at = null, hold_expires_at = null
       where id = b.id
      returning * into b;
    else
      update booking set payment_method = p_payment_method, status = 'paid',
             paid_at = coalesce(paid_at, now()), hold_expires_at = null
       where id = b.id
      returning * into b;
    end if;

    insert into booking_change (booking_id, kind, before, after)
    values (b.id, 'payment', v_before,
            jsonb_build_object('payment_method', b.payment_method,
              'status', b.status, 'surcharge_cents', b.surcharge_cents));
  end if;

  return jsonb_build_object(
    'booking_id', b.id,
    'status', b.status,
    'tier_code', b.tier_code,
    'payment_method', b.payment_method,
    'amount_cents', b.amount_cents,
    'addons_cents', b.addons_cents,
    'surcharge_cents', b.surcharge_cents,
    'total_cents', coalesce(b.amount_cents, 0) + coalesce(b.addons_cents, 0)
                   + coalesce(b.surcharge_cents, 0));
end;
$$;

revoke execute on function edit_booking_at_gate(
  uuid, text, text, text, text, boolean, text, text, text)
  from public, anon, authenticated;
grant execute on function edit_booking_at_gate(
  uuid, text, text, text, text, boolean, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------
--  5. Letting go of a walk-up that never paid.
--
--  Only an open-ended gate hold: an online checkout expires by itself,
--  and a paid booking is a refund, which is a different conversation.
-- ---------------------------------------------------------------------
create or replace function cancel_unpaid_gate_booking(p_booking_id uuid)
returns void
language plpgsql set search_path = public as $$
declare b booking%rowtype;
begin
  select * into b from booking where id = p_booking_id for update;
  if not found then
    raise exception 'NO_BOOKING: no such booking' using errcode = 'check_violation';
  end if;
  if b.status <> 'held' or b.payment_method <> 'unpaid' then
    raise exception 'NOT_UNPAID: only an unpaid walk-up can be cancelled from here'
      using errcode = 'check_violation';
  end if;

  update booking set status = 'cancelled', hold_expires_at = null
   where id = b.id;

  insert into booking_change (booking_id, kind, before, after)
  values (b.id, 'payment', jsonb_build_object('status', 'held'),
          jsonb_build_object('status', 'cancelled'));
end;
$$;

revoke execute on function cancel_unpaid_gate_booking(uuid)
  from public, anon, authenticated;
grant execute on function cancel_unpaid_gate_booking(uuid) to service_role;
