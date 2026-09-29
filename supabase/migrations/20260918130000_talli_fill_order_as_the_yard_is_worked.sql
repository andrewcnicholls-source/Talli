-- =====================================================================
--  Talli Parking — cars go in the order the yard is actually worked
--
--  Andrew's running order, in his words:
--
--      back yard, double park
--        > back yard not blocked
--        > front yard, double parked
--        > front yard, priority exit
--        > over flow parking
--        > valet
--
--  and, on the back yard, confirmed: the deep bay first and the stack
--  position in front of it second, because a car in the stack position
--  is between the deep bay and the gate. Squeezes come last everywhere —
--  they only exist because somebody pressed "+".
--
--  Two things this changes, both of them mine to correct.
--
--  20260918100000 sorted by the kind of space BEFORE the zone, so that
--  boxing somebody in was a last resort across the whole property. That
--  is a tidy rule and it is not how the yard is filled: the back yard is
--  worked until it is full, stack included, and only then does anyone
--  start on the lawn. Zone first, kind second.
--
--  And the very first sort key preferred bays that cannot be sold
--  online — the verges — so a Priority sale at the gate went to the
--  overflow before the lawn's street row. Whatever that was protecting,
--  it is not the order above, and zone_codes says the same thing more
--  plainly. Gone.
--
--  NOTHING ELSE MOVES, and the reason is worth writing down, because
--  "the overflow belongs to Priority" reads like a change and is not:
--
--    * Priority already lists ['front_lawn', 'berm'], so the overflow is
--      already its own and already falls after the street row once the
--      zone list is the running order.
--    * The neighbour's verge is already in reach, as three flex bays
--      inside 86 Paice Ave's own berm zone, opened with "+" like any
--      other spare.
--    * The separate `neighbour_berm` zone belongs to a different
--      property, 84 Paice Ave berm. hold_booking and v_bay_inventory are
--      both scoped to one property, and all eighteen events are offered
--      at 86 Paice Ave alone, so naming that zone in a tier would read
--      as inventory and never be reachable. It stays unnamed.
--
--  So the running order is one ORDER BY, and the yard's shape is left
--  exactly where it already was.
-- =====================================================================

-- ---------------------------------------------------------------------
--  The allocator works a zone out before it moves on.
--
--  Two keys decide a bay now, and the old first key is gone.
--
--    * the tier's zone_codes, read as the running order it already is
--
--    * within a zone: the plain bay, then the position stacked in front
--      of it, then a squeeze.
--
--      "Plain" is any bay that is always there. The stack positions and
--      the lawn's boxed-in back row became flex in 20260918120000 so
--      they start a night closed, which makes is_flex too blunt to sort
--      by on its own: it now covers three different things. What
--      separates them is what they do to a neighbour — a stack position
--      carries a departure deadline, a back-row bay has somebody parked
--      in front of it — while a squeeze blocks nobody and is blocked by
--      nobody. So a squeeze sorts last and the rest sort in between.
--
--  Nothing here overrides bay_kind, which still decides what a tier may
--  touch at all: Standard never takes a clear-run bay, Priority takes
--  only clear-run bays. So the two halves of the lawn never contend —
--  Standard sees the back row, Priority sees the street row — and the
--  running order falls out per tier without either knowing about the
--  other.
-- ---------------------------------------------------------------------
create or replace function hold_booking(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_email text,
  p_name text default null, p_phone text default null, p_rego text default null,
  p_hold_minutes integer default 30, p_channel text default 'online',
  p_accepts_street boolean default false, p_payment_method text default 'stripe',
  p_low_clearance boolean default false
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_tier offer_tier%rowtype; v_close timestamptz; v_share numeric(5,4);
  v_platform int; v_booking_id uuid; v_bay record; v_got_bay boolean := false;
  v_sellable_online bigint;
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

  -- The walk-up reserve. The marshal standing at the window is the reason
  -- it exists, so the gate itself is never held back by it.
  if p_channel <> 'gate' and v_tier.gate_reserve > 0 then
    select count(*) into v_sellable_online
      from v_bay_inventory i
     where i.event_id = p_event_id and i.property_id = p_property_id
       and i.available
       and i.reservable_in_advance
       and (v_tier.zone_codes is null or i.zone_code = any (v_tier.zone_codes))
       and case v_tier.bay_kind
             when 'free_exit'      then i.blocker_bay_id is null
             when 'may_be_blocked' then i.blocker_bay_id is not null
             when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                         or i.requires_early_departure
                                         or i.is_flex)
             else true
           end
       and (v_tier.departure_by is not null or not i.requires_early_departure)
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                            where a2.event_id = p_event_id
                              and a2.bay_id = i.blocker_bay_id));

    if v_sellable_online <= v_tier.gate_reserve then
      raise exception
        'HELD_FOR_GATE: the last % space(s) of tier "%" are held for walk-ups',
        v_tier.gate_reserve, p_tier_code
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
       and case v_tier.bay_kind
             when 'free_exit'      then i.blocker_bay_id is null
             when 'may_be_blocked' then i.blocker_bay_id is not null
             when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                         or i.requires_early_departure
                                         or i.is_flex)
             else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       -- Work one zone out before starting the next.
       coalesce(array_position(v_tier.zone_codes, i.zone_code), 99),
       -- Plain bay, then the position stacked in front of it, then a squeeze.
       case
         when not i.is_flex then 0
         when i.requires_early_departure or i.blocker_bay_id is not null then 1
         else 2
       end,
       -- A tier that promises a clear exit takes a genuinely clear one first.
       case when v_tier.guarantees_clear_exit and i.blocker_bay_id is null then 0 else 1 end,
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
                  when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                              or i.requires_early_departure
                                              or i.is_flex)
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
