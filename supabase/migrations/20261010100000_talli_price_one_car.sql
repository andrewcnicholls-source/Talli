-- =====================================================================
--  Talli Parking — the price for one car
--
--  From the driveway:
--
--     "Sometimes cars arrive all at once. In the heat of the moment I
--      found I was putting the cars in the wrong types. This came from
--      needing to have a more fluid pricing. I want to be able to
--      override the price set for any parking — not have to change it
--      for everyone."
--
--  The only lever was the tier price, which moves the sign for every car
--  after this one. So a deal struck at the window — "$20, go on then" —
--  was rung up as whichever type happened to cost $20, and the night's
--  counts of Standard, Priority and Valet stopped meaning anything.
--
--  Now the price is a property of the car, not just of its type:
--
--   1. sell_at_gate() takes an optional p_price_cents. Null is the sign
--      price, exactly as before. Set, it is what this one car paid — in
--      the same transaction as the sale, so there is never a moment where
--      the booking holds the wrong figure.
--
--   2. set_booking_price_at_gate() changes it afterwards, from the edit
--      sheet, for the car that was rung up at the sign price before
--      anyone remembered the deal.
--
--  Either way the type of space is left alone, the card surcharge follows
--  the new amount (booking_surcharge fires on amount_cents), the host and
--  platform split is worked again, and the difference from the sign is
--  written to booking_change so the night still reconciles.
--
--  On production the DROPs below stop for confirmation. That is expected:
--  sell_at_gate gains an argument, and a constraint gains a value. Nothing
--  is lost.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. A price change is a kind of change.
-- ---------------------------------------------------------------------
alter table booking_change drop constraint if exists booking_change_kind_check;
alter table booking_change
  add constraint booking_change_kind_check
  check (kind in ('details', 'payment', 'tier', 'price'));

-- ---------------------------------------------------------------------
--  2. Set what one booking paid for its space.
--
--  The space only: extras are priced item by item, and the surcharge is
--  worked from the result. $1 to $500, the same bounds as the sign.
--
--  Refused for anything Stripe settled or is settling — the website sold
--  that at the website's price, and Stripe holds the record of it.
-- ---------------------------------------------------------------------
create or replace function set_booking_price_at_gate(
  p_booking_id  uuid,
  p_price_cents integer
) returns jsonb
language plpgsql set search_path = public as $$
declare
  b       booking%rowtype;
  v_share numeric(5,4);
  v_was   integer;
begin
  if p_price_cents is null or p_price_cents < 100 or p_price_cents > 50000 then
    raise exception 'BAD_PRICE: a price between $1 and $500, please'
      using errcode = 'check_violation';
  end if;

  select * into b from booking where id = p_booking_id for update;
  if not found then
    raise exception 'NO_BOOKING: no such booking' using errcode = 'check_violation';
  end if;
  if b.status not in ('paid', 'held') then
    raise exception 'BOOKING_CLOSED: this booking is % and cannot be re-priced', b.status
      using errcode = 'check_violation';
  end if;
  if b.payment_method = 'stripe' then
    raise exception 'PAID_ONLINE: this was paid on the website — its price is what Stripe charged'
      using errcode = 'check_violation';
  end if;

  v_was := b.amount_cents;
  if v_was = p_price_cents then
    return jsonb_build_object('booking_id', b.id, 'amount_cents', b.amount_cents,
      'surcharge_cents', b.surcharge_cents);
  end if;

  select h.platform_share into v_share
    from property pr join host h on h.id = pr.host_id where pr.id = b.property_id;

  update booking set
    amount_cents        = p_price_cents,
    platform_fee_cents  = round(p_price_cents * coalesce(v_share, 0)),
    host_earnings_cents = p_price_cents - round(p_price_cents * coalesce(v_share, 0))
  where id = b.id
  returning * into b;

  insert into booking_change (booking_id, kind, before, after)
  values (b.id, 'price',
          jsonb_build_object('amount_cents', v_was),
          jsonb_build_object('amount_cents', b.amount_cents,
                             'surcharge_cents', b.surcharge_cents));

  return jsonb_build_object('booking_id', b.id, 'amount_cents', b.amount_cents,
    'surcharge_cents', b.surcharge_cents);
end;
$$;

revoke execute on function set_booking_price_at_gate(uuid, integer)
  from public, anon, authenticated;
grant execute on function set_booking_price_at_gate(uuid, integer) to service_role;

-- ---------------------------------------------------------------------
--  3. The walk-up, with a price of its own.
--
--  As 20260929100000, plus p_price_cents. A new argument is a new
--  signature, so the old one goes first — leaving it would make two
--  overloads that PostgREST cannot tell apart.
-- ---------------------------------------------------------------------
drop function if exists sell_at_gate(
  uuid, uuid, text, text, text, text, text, text, boolean, boolean);

create function sell_at_gate(
  p_event_id       uuid,
  p_property_id    uuid,
  p_tier_code      text,
  p_payment_method text default 'cash',
  p_rego           text default null,
  p_name           text default null,
  p_phone          text default null,
  p_email          text default null,
  p_accepts_street boolean default false,
  p_low_clearance  boolean default false,
  p_price_cents    integer default null
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

  -- Before it is confirmed, so it is never paid at the wrong figure.
  if p_price_cents is not null then
    perform set_booking_price_at_gate(v_id, p_price_cents);
  end if;

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
  uuid, uuid, text, text, text, text, text, text, boolean, boolean, integer)
  from public, anon, authenticated;
grant execute on function sell_at_gate(
  uuid, uuid, text, text, text, text, text, text, boolean, boolean, integer)
  to service_role;
