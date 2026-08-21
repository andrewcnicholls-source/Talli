-- =====================================================================
--  Talli Parking — extras, sold online and handed over at the gate
--
--  Prices are computed here and nowhere else. The browser names an item
--  and a quantity; the database decides what that costs, exactly as it
--  already does for the parking itself.
--
--  Also teaches hold_booking about a tier called sold out by eye — the
--  driveway's judgement outranks the bay maths.
-- =====================================================================

-- ---------------------------------------------------------------------
--  Attach extras to a booking. Idempotent: re-running replaces the lines,
--  so a retried checkout can never double-charge for the same ponchos.
-- ---------------------------------------------------------------------
create or replace function add_booking_addons(
  p_booking_id uuid,
  p_items      jsonb,
  p_channel    text default 'online'
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_item   jsonb;
  v_addon  addon%rowtype;
  v_qty    integer;
  v_amount integer;
  v_total  integer := 0;
begin
  if not exists (select 1 from booking where id = p_booking_id) then
    raise exception 'NO_BOOKING: no such booking' using errcode = 'check_violation';
  end if;

  delete from booking_addon where booking_id = p_booking_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select * into v_addon
      from addon
     where code = (v_item ->> 'code') and active;
    if not found then
      raise exception 'NO_SUCH_ADDON: % is not something we sell', (v_item ->> 'code')
        using errcode = 'check_violation';
    end if;

    -- A stepper can only go so high on screen, but nothing stops a crafted
    -- request. Clamp rather than reject: the customer still gets their order.
    v_qty := least(greatest(coalesce((v_item ->> 'qty')::integer, 0), 0), v_addon.max_qty);
    continue when v_qty = 0;

    v_amount := addon_price_cents(
      v_addon.price_cents, v_addon.bundle_qty, v_addon.bundle_price_cents, v_qty);

    insert into booking_addon
      (booking_id, addon_id, code, name, qty, unit_price_cents, amount_cents, channel)
    values
      (p_booking_id, v_addon.id, v_addon.code, v_addon.name, v_qty,
       v_addon.price_cents, v_amount, coalesce(p_channel, 'online'));

    v_total := v_total + v_amount;
  end loop;

  update booking set addons_cents = v_total where id = p_booking_id;
  return v_total;
end;
$function$;

-- One tap at the gate covers the whole bag; nobody hands over a poncho and
-- an earplug pair in two separate transactions.
create or replace function set_addons_handed_over(
  p_booking_id uuid,
  p_handed     boolean default true
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare v_n integer;
begin
  update booking_addon
     set handed_over_at = case when coalesce(p_handed, true) then now() else null end
   where booking_id = p_booking_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------------
--  The gate list carries what each car has already paid for.
-- ---------------------------------------------------------------------
create or replace view v_gate_list as
select
  b.event_id,
  e.name as event_name,
  b.id as booking_id,
  b.customer_name,
  b.customer_phone,
  b.vehicle_rego,
  b.tier_code,
  i.zone_label,
  i.bay_label,
  i.exit_class,
  b.arrival_from,
  b.arrival_until,
  b.must_depart_by,
  b.accepts_street_parking,
  b.channel,
  b.payment_method,
  b.status,
  b.checked_in_at,
  (b.checked_in_at is not null) as arrived,
  b.amount_cents,
  b.notes,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'code', ba.code, 'name', ba.name, 'qty', ba.qty,
             'handed', ba.handed_over_at is not null)
           order by ba.code)
      from booking_addon ba where ba.booking_id = b.id), '[]'::jsonb) as addons,
  b.addons_cents,
  (select count(*)::integer from booking_addon ba
    where ba.booking_id = b.id and ba.handed_over_at is null) as addons_pending
from booking b
join event e on e.id = b.event_id
left join bay_allocation a on a.booking_id = b.id and a.role = 'occupied'
left join v_bay_inventory i on i.bay_id = a.bay_id and i.event_id = b.event_id
where b.status = any (array['paid', 'held']);

alter view v_gate_list set (security_invoker = true);

-- ---------------------------------------------------------------------
--  A tier called sold out in the driveway is sold out everywhere.
-- ---------------------------------------------------------------------
create or replace function hold_booking(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_email text,
  p_name text default null, p_phone text default null, p_rego text default null,
  p_hold_minutes integer default 30, p_channel text default 'online',
  p_accepts_street boolean default false, p_payment_method text default 'stripe')
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
    customer_phone, vehicle_rego, amount_cents,
    arrival_from, arrival_until, must_depart_by,
    platform_fee_cents, host_earnings_cents,
    channel, payment_method, accepts_street_parking, status, hold_expires_at
  ) values (
    p_event_id, p_property_id, v_tier.code, p_email, p_name,
    p_phone, p_rego, v_tier.price_cents,
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
