-- Talli Parking — availability views and the atomic hold/release logic

create or replace view v_bay_inventory
with (security_invoker = true) as
select
  eo.event_id,
  eo.property_id,
  z.id as zone_id, z.code as zone_code, z.label as zone_label,
  z.keys_held, z.reservable_in_advance, z.requires_consent, z.exit_rank,
  b.id as bay_id, b.label as bay_label, b.size_class, b.blocks_bay_id,
  (b.blocks_bay_id is not null) as is_blocking,
  (select bb.id from bay bb where bb.blocks_bay_id = b.id and bb.active) as blocker_bay_id,
  case
    when z.keys_held                 then 'valet'
    when b.blocks_bay_id is not null then 'blocking'
    when exists (select 1 from bay bb where bb.blocks_bay_id = b.id and bb.active)
                                     then 'blockable'
    else                                  'clear'
  end as exit_class,
  a.booking_id, a.role as allocation_role, (a.id is null) as available
from event_offer eo
join zone z on z.property_id = eo.property_id and z.active
join bay  b on b.zone_id = z.id and b.active
left join bay_allocation a on a.event_id = eo.event_id and a.bay_id = b.id;

-- spots_left      -> sellable ONLINE right now (excludes space you can't promise)
-- spots_left_gate -> placeable on the night, including the berm
-- NOT additive across tiers: several tiers compete for the same bays.
create or replace view v_tier_availability
with (security_invoker = true) as
select
  t.id as offer_tier_id, eo.event_id, eo.property_id,
  t.code, t.label, t.price_cents,
  t.zone_codes, t.bay_kind, t.guarantees_clear_exit,
  t.arrival_from, t.arrival_until, t.departure_by, t.sort_order,
  (select count(*) from v_bay_inventory i
    where i.event_id = eo.event_id and i.property_id = eo.property_id
      and i.available and i.reservable_in_advance
      and (t.zone_codes is null or i.zone_code = any(t.zone_codes))
      and case t.bay_kind when 'clear' then not i.is_blocking
                          when 'blocking' then i.is_blocking else true end
      and (not t.guarantees_clear_exit or i.blocker_bay_id is null
           or not exists (select 1 from bay_allocation a2
                          where a2.event_id = i.event_id and a2.bay_id = i.blocker_bay_id))
  )::int as spots_left,
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
where t.active;

-- Only complains at high/premium demand: below that the displaced bay had no
-- buyer anyway, so a modest premium beats nothing.
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
                 and s.bay_kind = 'clear' and not s.guarantees_clear_exit
join offer_tier d on d.event_offer_id = eo.id and d.active and d.bay_kind = 'blocking'
where e.demand_tier in ('high','premium')
  and g.price_cents < s.price_cents + d.price_cents;

create or replace view v_gate_list
with (security_invoker = true) as
select
  b.event_id, e.name as event_name, b.id as booking_id,
  b.customer_name, b.customer_phone, b.vehicle_rego, b.tier_code,
  i.zone_label, i.bay_label, i.exit_class,
  b.arrival_from, b.arrival_until, b.must_depart_by,
  b.accepts_street_parking, b.channel, b.status
from booking b
join event e on e.id = b.event_id
left join bay_allocation a on a.booking_id = b.id and a.role = 'occupied'
left join v_bay_inventory i on i.bay_id = a.bay_id and i.event_id = b.event_id
where b.status in ('paid','held');

-- Who you may move onto the berm to free a bookable bay.
create or replace view v_relocatable_to_consent_zone
with (security_invoker = true) as
select
  b.event_id, b.id as booking_id, b.customer_name, b.customer_phone,
  b.tier_code, i.zone_label as currently_in, i.bay_id as current_bay_id
from booking b
join bay_allocation a on a.booking_id = b.id and a.role = 'occupied'
join v_bay_inventory i on i.bay_id = a.bay_id and i.event_id = b.event_id
where b.status in ('paid','held')
  and b.accepts_street_parking
  and not i.requires_consent
  and not i.keys_held;

create or replace view v_zone_capacity
with (security_invoker = true) as
select
  eo.event_id, eo.property_id, i.zone_code, i.zone_label,
  i.exit_rank, i.keys_held, i.reservable_in_advance, i.requires_consent,
  count(*)::int                              as bays,
  count(*) filter (where i.is_blocking)::int as double_park_positions,
  count(*) filter (where i.available)::int   as available_now
from event_offer eo
join v_bay_inventory i on i.event_id = eo.event_id and i.property_id = eo.property_id
group by eo.event_id, eo.property_id, i.zone_code, i.zone_label,
         i.exit_rank, i.keys_held, i.reservable_in_advance, i.requires_consent;

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
  p_accepts_street boolean default false
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_tier       offer_tier%rowtype;
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

  select h.platform_share into v_share
    from property pr join host h on h.id = pr.host_id where pr.id = p_property_id;
  v_platform := round(v_tier.price_cents * v_share);

  insert into booking (
    event_id, property_id, tier_code, customer_email, customer_name,
    customer_phone, vehicle_rego, amount_cents,
    arrival_from, arrival_until, must_depart_by,
    platform_fee_cents, host_earnings_cents,
    channel, accepts_street_parking, status, hold_expires_at
  ) values (
    p_event_id, p_property_id, v_tier.code, p_email, p_name,
    p_phone, p_rego, v_tier.price_cents,
    v_tier.arrival_from, v_tier.arrival_until, v_tier.departure_by,
    v_platform, v_tier.price_cents - v_platform,
    p_channel, p_accepts_street, 'held', now() + make_interval(mins => p_hold_minutes)
  ) returning id into v_booking_id;

  for v_bay in
    select i.bay_id, i.blocker_bay_id
      from v_bay_inventory i
     where i.event_id = p_event_id and i.property_id = p_property_id and i.available
       and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
       -- Online can only ever land on space you actually control.
       and (p_channel = 'gate' or i.reservable_in_advance)
       -- And never anywhere they haven't agreed to.
       and (not i.requires_consent or p_accepts_street)
       and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                when 'blocking' then i.is_blocking else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       -- At the gate, spend the space you can't sell online FIRST.
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

-- Relocate a booking. Refuses consent-required zones without the checkbox, and
-- re-applies the clear-exit reservation if their tier promised one.
create or replace function reassign_booking(p_booking_id uuid, p_target_bay_id uuid)
returns void language plpgsql set search_path = public as $$
declare
  v_b booking%rowtype; v_requires boolean; v_zone text; v_guar boolean; v_blocker uuid;
begin
  select * into v_b from booking where id = p_booking_id;
  if not found then raise exception 'No such booking %', p_booking_id; end if;

  select z.requires_consent, z.label into v_requires, v_zone
    from bay ba join zone z on z.id = ba.zone_id where ba.id = p_target_bay_id;
  if not found then raise exception 'No such bay %', p_target_bay_id; end if;

  if v_requires and not v_b.accepts_street_parking then
    raise exception 'CONSENT_REQUIRED: this customer has not agreed to be placed in %', v_zone
      using errcode = 'check_violation';
  end if;

  select t.guarantees_clear_exit into v_guar
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = v_b.event_id and o.property_id = v_b.property_id
     and t.code = v_b.tier_code;

  delete from bay_allocation where booking_id = p_booking_id;
  insert into bay_allocation (event_id, bay_id, booking_id, role)
  values (v_b.event_id, p_target_bay_id, p_booking_id, 'occupied');

  if coalesce(v_guar, false) then
    select bb.id into v_blocker from bay bb
     where bb.blocks_bay_id = p_target_bay_id and bb.active;
    if v_blocker is not null then
      insert into bay_allocation (event_id, bay_id, booking_id, role)
      values (v_b.event_id, v_blocker, p_booking_id, 'blocked_reserve');
    end if;
  end if;
end;
$$;

create or replace function release_booking(p_booking_id uuid, p_status text default 'cancelled')
returns void language plpgsql set search_path = public as $$
begin
  delete from bay_allocation where booking_id = p_booking_id;
  update booking set status = p_status, hold_expires_at = null where id = p_booking_id;
end;
$$;

create or replace function confirm_booking(p_booking_id uuid, p_payment_intent_id text default null)
returns void language plpgsql set search_path = public as $$
begin
  update booking
     set status = 'paid', paid_at = now(), hold_expires_at = null,
         stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id)
   where id = p_booking_id and status in ('held','paid');
end;
$$;

create or replace function expire_stale_holds() returns int
language plpgsql set search_path = public as $$
declare v_count int;
begin
  with stale as (
    select id from booking
     where status = 'held' and hold_expires_at < now()
     for update skip locked
  )
  delete from bay_allocation a using stale s where a.booking_id = s.id;

  update booking set status = 'expired', hold_expires_at = null
   where status = 'held' and hold_expires_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- What it costs right now to promise nobody parks in behind them.
--   0    -> free (valet, or a bay nothing can park behind)
--   N    -> the double-park position you'd hold empty
--   NULL -> you cannot make the promise here; don't sell it
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
                           and t.bay_kind = 'blocking' and t.active), 0)
    end)::int
  from v_bay_inventory i
  where i.event_id = p_event_id and i.property_id = p_property_id
    and i.available and not i.is_blocking
    and (i.keys_held or i.blocker_bay_id is null
         or not exists (select 1 from bay_allocation a
                        where a.event_id = i.event_id and a.bay_id = i.blocker_bay_id))
    and (p_zone_code is null or i.zone_code = p_zone_code);
$$;
