-- Allocator and tiers moved onto the free_exit / may_be_blocked axis.

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
language plpgsql set search_path = public as $$
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
       -- A bay that boxes in someone who did not agree to wait may only be
       -- sold by a tier that carries a departure deadline.
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
$$;
revoke execute on function hold_booking(uuid, uuid, text, text, text, text, text, int, text, boolean, text)
  from public, anon, authenticated;

create or replace function upgrade_cost_cents(
  p_event_id uuid, p_property_id uuid, p_zone_code text default null
) returns int
language sql stable set search_path = public as $$
  select min(
    case when i.keys_held              then 0
         when i.blocker_bay_id is null then 0
         else coalesce((select max(t.price_cents) from offer_tier t
                          join event_offer o on o.id = t.event_offer_id
                         where o.event_id = i.event_id and o.property_id = i.property_id
                           and t.departure_by is not null and t.active), 0)
    end)::int
  from v_bay_inventory i
  where i.event_id = p_event_id and i.property_id = p_property_id
    and i.available
    and not i.requires_early_departure
    and (i.keys_held or i.blocker_bay_id is null
         or not exists (select 1 from bay_allocation a
                        where a.event_id = i.event_id and a.bay_id = i.blocker_bay_id))
    and (p_zone_code is null or i.zone_code = p_zone_code);
$$;
grant execute on function upgrade_cost_cents(uuid, uuid, text) to anon, authenticated;

create or replace view v_pricing_warnings
with (security_invoker = true) as
select
  eo.event_id, e.name as event_name, e.demand_tier, eo.property_id,
  g.code as guaranteed_tier, g.price_cents as guaranteed_price_cents,
  s.price_cents + d.price_cents as displaced_value_cents,
  'Clear-exit tier priced below the standard bay plus the double-park position it holds empty, at a demand level where you expect to sell out' as warning
from event_offer eo
join event e      on e.id = eo.event_id
join offer_tier g on g.event_offer_id = eo.id and g.guarantees_clear_exit and g.active
join offer_tier s on s.event_offer_id = eo.id and s.active
                 and s.zone_codes is not distinct from g.zone_codes
                 and s.bay_kind = 'may_be_blocked' and not s.guarantees_clear_exit
join offer_tier d on d.event_offer_id = eo.id and d.active and d.departure_by is not null
where e.demand_tier in ('high','premium')
  and g.price_cents < s.price_cents + d.price_cents;
revoke all on v_pricing_warnings from public, anon, authenticated;

-- ---------------------------------------------------- reseed the tiers
-- Adds 'near_road' for the lawn back row: near the road, but you wait a moment
-- for the car in front. That row was previously mis-sold as priority exit.

delete from offer_tier;

with pricing(demand_tier, valet, priority, near_road, yard, yard_clear, dbl) as (values
  ('low',      3000, 2200, 1800, 1500, 2000, 1200),
  ('standard', 4000, 3200, 2800, 2500, 3500, 2000),
  ('high',     5500, 5000, 4200, 3500, 6500, 3000),
  ('premium',  7000, 6000, 5000, 4000, 7500, 3500)
)
insert into offer_tier
  (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
   guarantees_clear_exit, arrival_from, arrival_until, departure_by,
   sort_order, active)
select eo.id, v.code, v.label, v.price_cents, v.zone_codes, v.bay_kind,
       v.guarantees_clear_exit,
       e.starts_at + v.from_offset, e.starts_at + v.until_offset,
       case when v.depart_offset is null then null else e.starts_at + v.depart_offset end,
       v.sort_order,
       case when v.guarantees_clear_exit then e.demand_tier in ('low','standard') else true end
from event_offer eo
join event   e on e.id = eo.event_id
join pricing p on p.demand_tier = e.demand_tier
cross join lateral (values
  ('valet', 'Valet — we hold your keys and bring the car to you',
     p.valet,      array['valet'],             'any',            false,
     interval '-150 minutes', interval '-5 minutes',  null::interval, 1),
  ('priority', 'Priority exit — near the road, nobody parked in behind you',
     p.priority,   array['front_lawn','berm'], 'free_exit',      false,
     interval '-150 minutes', interval '-10 minutes', null::interval, 2),
  ('near_road', 'Near the road — a short wait for the car in front to move',
     p.near_road,  array['front_lawn'],        'may_be_blocked', false,
     interval '-150 minutes', interval '-40 minutes', null::interval, 3),
  ('standard', 'Standard — best value, expect to wait for the drive to clear',
     p.yard,       array['back_yard'],         'may_be_blocked', false,
     interval '-150 minutes', interval '-10 minutes', null::interval, 4),
  ('guaranteed_clear', 'Guaranteed clear — nobody parks in behind you',
     p.yard_clear, array['back_yard'],         'may_be_blocked', true,
     interval '-150 minutes', interval '-10 minutes', null::interval, 5),
  ('quick_getaway', 'Quick getaway — parked in behind someone, must leave before full time',
     p.dbl,        array['back_yard'],         'free_exit',      false,
     interval '-45 minutes',  interval '-5 minutes',  interval '+10 minutes', 6)
) as v(code, label, price_cents, zone_codes, bay_kind, guarantees_clear_exit,
       from_offset, until_offset, depart_offset, sort_order);
