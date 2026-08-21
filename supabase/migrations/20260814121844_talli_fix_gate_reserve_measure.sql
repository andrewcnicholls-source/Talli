-- The reserve was counted against EVERY available bay in the zone, including
-- the double-park positions. Back yard has 7 ordinary bays and 7 double-park
-- positions, so a reserve of 2 measured against 14 never bit: online could
-- sell all 7 ordinary bays and still see 7 "available".
--
-- Correct semantics: gate_reserve holds back that many bays OF EACH KIND —
-- ordinary and double-park — so a walk-up wanting either still has somewhere
-- to go. Back yard reserve 2 therefore means online may sell 5 of the 7
-- ordinary bays and 5 of the 7 double-park positions.

comment on column zone.gate_reserve is
  'Bays held back from online sale so walk-ups always have somewhere to go. Applies separately to ordinary bays and to double-park positions.';

create or replace view v_tier_availability
with (security_invoker = true) as
select
  t.id as offer_tier_id, eo.event_id, eo.property_id,
  t.code, t.label, t.price_cents,
  t.zone_codes, t.bay_kind, t.guarantees_clear_exit,
  t.arrival_from, t.arrival_until, t.departure_by, t.sort_order,
  case when e.online_sales_close_at is not null and now() > e.online_sales_close_at
       then 0
       else coalesce((
         select sum(greatest(0, z.matching - z.gate_reserve))
         from (
           select i.zone_id,
                  max(i.gate_reserve) as gate_reserve,
                  count(*) filter (where i.available
                    and case t.bay_kind when 'clear'    then not i.is_blocking
                                        when 'blocking' then i.is_blocking
                                        else true end
                    and (not t.guarantees_clear_exit or i.blocker_bay_id is null
                         or not exists (select 1 from bay_allocation a2
                                        where a2.event_id = i.event_id
                                          and a2.bay_id = i.blocker_bay_id))) as matching
           from v_bay_inventory i
           where i.event_id = eo.event_id and i.property_id = eo.property_id
             and i.reservable_in_advance
             and (t.zone_codes is null or i.zone_code = any(t.zone_codes))
           group by i.zone_id
         ) z), 0) end::int as spots_left,
  (select count(*) from v_bay_inventory i
    where i.event_id = eo.event_id and i.property_id = eo.property_id
      and i.available
      and (t.zone_codes is null or i.zone_code = any(t.zone_codes))
      and case t.bay_kind when 'clear' then not i.is_blocking
                          when 'blocking' then i.is_blocking else true end
      and (not t.guarantees_clear_exit or i.blocker_bay_id is null
           or not exists (select 1 from bay_allocation a2
                          where a2.event_id = i.event_id and a2.bay_id = i.blocker_bay_id))
  )::int as spots_left_gate
from offer_tier t
join event_offer eo on eo.id = t.event_offer_id
join event e on e.id = eo.event_id
where t.active;

grant select on v_tier_availability to anon, authenticated;

-- Same correction inside the allocator.
create or replace function hold_booking(
  p_event_id     uuid,
  p_property_id  uuid,
  p_tier_code    text,
  p_email        text,
  p_name         text default null,
  p_phone        text default null,
  p_rego         text default null,
  p_hold_minutes int  default 30,
  p_channel      text default 'online',
  p_accepts_street boolean default false,
  p_payment_method text default 'stripe'
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_tier       offer_tier%rowtype;
  v_close      timestamptz;
  v_share      numeric(5,4);
  v_platform   int;
  v_booking_id uuid;
  v_bay        record;
  v_got_bay    boolean := false;
begin
  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;
  if not found then
    raise exception 'No active tier "%" for that event and property', p_tier_code;
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
       -- Online may not sell a zone down into its walk-up reserve, counted
       -- against bays of the same kind this tier sells.
       and (p_channel = 'gate' or i.gate_reserve = 0 or (
             select count(*) from v_bay_inventory j
              where j.event_id = p_event_id and j.zone_id = i.zone_id and j.available
                and case v_tier.bay_kind when 'clear'    then not j.is_blocking
                                         when 'blocking' then j.is_blocking
                                         else true end
           ) > i.gate_reserve)
       and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                when 'blocking' then i.is_blocking else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       case when i.reservable_in_advance then 1 else 0 end,
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
    exception when unique_violation then
      continue;
    end;
  end loop;

  if not v_got_bay then
    if p_channel = 'online' and exists (
         select 1 from v_bay_inventory i
          where i.event_id = p_event_id and i.property_id = p_property_id
            and i.available and i.reservable_in_advance
            and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
            and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                     when 'blocking' then i.is_blocking else true end)
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
            and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                     when 'blocking' then i.is_blocking else true end)
    then
      raise exception 'CONSENT_REQUIRED: space is available for tier "%", but only in a zone the customer must opt into first', p_tier_code
        using errcode = 'check_violation';
    end if;

    raise exception 'SOLD_OUT: no bay available for tier "%" at that property', p_tier_code
      using errcode = 'check_violation';
  end if;

  return v_booking_id;
end;
$$;

revoke execute on function hold_booking(uuid, uuid, text, text, text, text, text, int, text, boolean, text)
  from public, anon, authenticated;
