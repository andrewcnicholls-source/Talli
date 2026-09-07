-- ---------------------------------------------------------------------
--  "My car is lowered" — told at checkout, read in the driveway
--
--  A few positions in the yard are reached over a steep crossing or a
--  lip that a car sitting low will ground out on. Nothing in the bay
--  plan knows which car is which, so today the marshal finds out at the
--  worst possible moment: halfway in, with a queue behind them.
--
--  So the customer gets to say so while they are booking, and the flag
--  rides with the booking to the gate list.
--
--  What it deliberately is NOT: it changes no price, reserves no
--  particular bay, and does not narrow what hold_booking will allocate.
--  Where a car actually goes is still a judgement made in the driveway
--  by someone standing next to it — this only means that judgement gets
--  made before the car is committed to the entry.
-- ---------------------------------------------------------------------

alter table booking
  add column if not exists vehicle_low_clearance boolean not null default false;

comment on column booking.vehicle_low_clearance is
  'Customer told us the car is lowered or sits low. Advisory only: it warns '
  'the marshal, it does not constrain bay allocation or pricing.';

-- ---------------------------------------------------------------------
--  hold_booking carries it through
--
--  Restated in full because plpgsql has no way to add one column to an
--  INSERT from outside. The body below is the 20260821093000 version
--  with two lines added — the column and the parameter — and nothing
--  else touched.
--
--  The 11-argument signature is dropped rather than left as an overload.
--  PostgREST refuses to call a function name that resolves to two
--  candidates, so leaving the old one in place would take create-checkout
--  down the moment this ships.
-- ---------------------------------------------------------------------
create or replace function hold_booking(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_email text,
  p_name text default null, p_phone text default null, p_rego text default null,
  p_hold_minutes integer default 30, p_channel text default 'online',
  p_accepts_street boolean default false, p_payment_method text default 'stripe',
  p_low_clearance boolean default false)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_tier offer_tier%rowtype; v_close timestamptz; v_share numeric(5,4);
  v_platform int; v_booking_id uuid; v_bay record; v_got_bay boolean := false;
begin
  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;
  if not found then
    raise exception 'No active tier "%" for that event and property', p_tier_code;
  end if;

  -- Called gone at the gate, by eye, before the bay count agrees. That call
  -- wins: it is usually made because the yard is physically fuller than the
  -- plan thinks.
  if v_tier.manually_sold_out then
    raise exception 'SOLD_OUT: tier "%" has been marked sold out for this event', p_tier_code
      using errcode = 'check_violation';
  end if;

  if p_channel = 'online' then
    select e.online_sales_close_at into v_close from event e where e.id = p_event_id;
    if v_close is not null and now() > v_close then
      raise exception 'ONLINE_SALES_CLOSED: online sales for this event closed at %', v_close
        using errcode = 'check_violation';
    end if;
  end if;

  select h.platform_share into v_share
    from property pr join host h on h.id = pr.host_id where pr.id = p_property_id;
  v_platform := round(v_tier.price_cents * v_share);

  insert into booking (
    event_id, property_id, tier_code, customer_email, customer_name,
    customer_phone, vehicle_rego, vehicle_low_clearance, amount_cents,
    arrival_from, arrival_until, must_depart_by,
    platform_fee_cents, host_earnings_cents,
    channel, payment_method, accepts_street_parking, status, hold_expires_at
  ) values (
    p_event_id, p_property_id, v_tier.code, p_email, p_name,
    p_phone, p_rego, coalesce(p_low_clearance, false), v_tier.price_cents,
    v_tier.arrival_from, v_tier.arrival_until, v_tier.departure_by,
    v_platform, v_tier.price_cents - v_platform,
    p_channel, p_payment_method, p_accepts_street, 'held',
    now() + make_interval(mins => p_hold_minutes)
  ) returning id into v_booking_id;

  for v_bay in
    select i.bay_id, i.blocker_bay_id
      from v_bay_inventory i
     where i.event_id = p_event_id and i.property_id = p_property_id and i.available
       and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
       and (p_channel = 'gate' or i.reservable_in_advance)
       and (not i.requires_consent or p_accepts_street)
       and (v_tier.departure_by is not null or not i.requires_early_departure)
       and (p_channel = 'gate' or i.gate_reserve = 0 or (
             select count(*) from v_bay_inventory j
              where j.event_id = p_event_id and j.zone_id = i.zone_id and j.available
                and case v_tier.bay_kind
                      when 'free_exit'      then j.blocker_bay_id is null
                      when 'may_be_blocked' then j.blocker_bay_id is not null
                      else true end
           ) > i.gate_reserve)
       and case v_tier.bay_kind
             when 'free_exit'      then i.blocker_bay_id is null
             when 'may_be_blocked' then i.blocker_bay_id is not null
             else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       case when i.reservable_in_advance then 1 else 0 end,
       case when v_tier.guarantees_clear_exit and i.blocker_bay_id is null then 0 else 1 end,
       -- A spare only opened because the yard was tight is the last thing to
       -- hand out; keep it for the car that would otherwise be turned away.
       case when i.is_flex then 1 else 0 end,
       i.exit_rank, i.bay_label
  loop
    begin
      insert into bay_allocation (event_id, bay_id, booking_id, role)
      values (p_event_id, v_bay.bay_id, v_booking_id, 'occupied');
      if v_tier.guarantees_clear_exit and v_bay.blocker_bay_id is not null then
        insert into bay_allocation (event_id, bay_id, booking_id, role)
        values (p_event_id, v_bay.blocker_bay_id, v_booking_id, 'blocked_reserve');
      end if;
      v_got_bay := true;
      exit;
    exception when unique_violation then continue;
    end;
  end loop;

  if not v_got_bay then
    if p_channel = 'online' and exists (
         select 1 from v_bay_inventory i
          where i.event_id = p_event_id and i.property_id = p_property_id
            and i.available and i.reservable_in_advance
            and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
            and (v_tier.departure_by is not null or not i.requires_early_departure)
            and case v_tier.bay_kind
                  when 'free_exit'      then i.blocker_bay_id is null
                  when 'may_be_blocked' then i.blocker_bay_id is not null
                  else true end)
    then
      raise exception 'HELD_FOR_GATE: the only space left in that zone is the walk-up reserve'
        using errcode = 'check_violation';
    end if;

    if not p_accepts_street and exists (
         select 1 from v_bay_inventory i
          where i.event_id = p_event_id and i.property_id = p_property_id
            and i.available and i.requires_consent
            and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
            and (p_channel = 'gate' or i.reservable_in_advance)
            and (v_tier.departure_by is not null or not i.requires_early_departure)
            and case v_tier.bay_kind
                  when 'free_exit'      then i.blocker_bay_id is null
                  when 'may_be_blocked' then i.blocker_bay_id is not null
                  else true end)
    then
      raise exception 'CONSENT_REQUIRED: space is available for tier "%", but only in a zone the customer must opt into first', p_tier_code
        using errcode = 'check_violation';
    end if;

    raise exception 'SOLD_OUT: no bay available for tier "%" at that property', p_tier_code
      using errcode = 'check_violation';
  end if;

  return v_booking_id;
end;
$function$;

-- ---------------------------------------------------------------------
--  Same story for the walk-up. sell_at_gate is dropped and rebuilt for
--  the same reason: two overloads and PostgREST stops calling it.
--
--  Dropped in dependency order — sell_at_gate first, because its body
--  names hold_booking.
-- ---------------------------------------------------------------------
drop function if exists sell_at_gate(uuid, uuid, text, text, text, text, text, text, boolean);
drop function if exists hold_booking(uuid, uuid, text, text, text, text, text, integer, text, boolean, text);

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
  v_id := hold_booking(
    p_event_id, p_property_id, p_tier_code,
    coalesce(p_email, 'gate+' || replace(gen_random_uuid()::text,'-','') || '@talli.co.nz'),
    p_name, p_phone, p_rego, 5, 'gate', p_accepts_street, p_payment_method,
    p_low_clearance);
  perform confirm_booking(v_id, null);
  perform check_in_booking(v_id);
  return v_id;
end;
$$;

-- Both stay server-side only, exactly as the signatures they replace were.
revoke execute on function hold_booking(
  uuid, uuid, text, text, text, text, text, integer, text, boolean, text, boolean)
  from public, anon, authenticated;
revoke execute on function sell_at_gate(
  uuid, uuid, text, text, text, text, text, text, boolean, boolean)
  from public, anon, authenticated;
