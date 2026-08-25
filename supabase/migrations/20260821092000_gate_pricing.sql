-- =====================================================================
--  Talli Parking — pricing and sell-outs decided on the night
--
--  The signage is a rack of swappable price cards, and it gets swapped:
--  selling fast, the price goes up; slow, it comes down to fill the yard.
--  The database has to be able to follow that within a few seconds, from
--  a phone, without anyone opening a dashboard.
--
--  Two levers, both per event and per tier:
--    * price_cents          — what the card in the driveway says.
--    * manually_sold_out    — "Standard's gone", called by eye, before the
--                             bay maths agrees. Stops online and gate sales
--                             alike, and is reversible in one tap.
--
--  Neither touches bookings already taken: a booking snapshots its price
--  at the moment of sale and never moves.
-- =====================================================================

alter table offer_tier
  add column if not exists manually_sold_out boolean not null default false,
  add column if not exists price_updated_at  timestamptz;

comment on column offer_tier.manually_sold_out is
  'Called sold out at the gate by eye, ahead of the bay count. Reversible.';
comment on column offer_tier.price_updated_at is
  'When the price last moved. Only ever set by the gate screen re-pricing on the night.';

-- ---------------------------------------------------------------------
--  Availability honours the call made in the driveway.
-- ---------------------------------------------------------------------
create or replace view v_tier_availability as
select
  t.id as offer_tier_id,
  eo.event_id,
  eo.property_id,
  t.code,
  t.label,
  t.price_cents,
  t.zone_codes,
  t.bay_kind,
  t.guarantees_clear_exit,
  t.arrival_from,
  t.arrival_until,
  t.departure_by,
  t.sort_order,
  (case
     when t.manually_sold_out then 0::numeric
     when e.online_sales_close_at is not null and now() > e.online_sales_close_at then 0::numeric
     else coalesce((
       select sum(greatest(0::bigint, zz.matching - zz.gate_reserve))
         from (
           select i.zone_id,
                  max(i.gate_reserve) as gate_reserve,
                  count(*) filter (where i.available and
                    case t.bay_kind
                      when 'free_exit'      then i.blocker_bay_id is null
                      when 'may_be_blocked' then i.blocker_bay_id is not null
                      else true
                    end
                    and (t.departure_by is not null or not i.requires_early_departure)
                    and (not t.guarantees_clear_exit or i.blocker_bay_id is null
                         or not exists (select 1 from bay_allocation a2
                                         where a2.event_id = i.event_id
                                           and a2.bay_id = i.blocker_bay_id)))
                    as matching
             from v_bay_inventory i
            where i.event_id = eo.event_id and i.property_id = eo.property_id
              and i.reservable_in_advance
              and (t.zone_codes is null or i.zone_code = any (t.zone_codes))
            group by i.zone_id
         ) zz), 0::numeric)
   end)::integer as spots_left,
  (case when t.manually_sold_out then 0 else (
     select count(*)
       from v_bay_inventory i
      where i.event_id = eo.event_id and i.property_id = eo.property_id
        and i.available
        and (t.zone_codes is null or i.zone_code = any (t.zone_codes))
        and case t.bay_kind
              when 'free_exit'      then i.blocker_bay_id is null
              when 'may_be_blocked' then i.blocker_bay_id is not null
              else true
            end
        and (t.departure_by is not null or not i.requires_early_departure)
        and (not t.guarantees_clear_exit or i.blocker_bay_id is null
             or not exists (select 1 from bay_allocation a2
                             where a2.event_id = i.event_id
                               and a2.bay_id = i.blocker_bay_id)))
   end)::integer as spots_left_gate,
  t.manually_sold_out
from offer_tier t
join event_offer eo on eo.id = t.event_offer_id
join event e on e.id = eo.event_id
where t.active;

alter view v_tier_availability set (security_invoker = true);

-- ---------------------------------------------------------------------
--  Re-price, and call a tier gone. Both are one round trip from a phone.
-- ---------------------------------------------------------------------
create or replace function set_tier_price(
  p_event_id    uuid,
  p_property_id uuid,
  p_tier_code   text,
  p_price_cents integer
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  -- A price typed on a wet phone. $1 and $500 are both almost certainly a
  -- slip, and a slip here sells the whole yard at the wrong number.
  if p_price_cents is null or p_price_cents < 100 or p_price_cents > 50000 then
    raise exception 'BAD_PRICE: a price must be between $1 and $500'
      using errcode = 'check_violation';
  end if;

  select t.id into v_id
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  update offer_tier
     set price_cents = p_price_cents, price_updated_at = now()
   where id = v_id;

  return p_price_cents;
end;
$function$;

create or replace function set_tier_sold_out(
  p_event_id    uuid,
  p_property_id uuid,
  p_tier_code   text,
  p_sold_out    boolean
) returns boolean
language plpgsql
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  select t.id into v_id
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  update offer_tier set manually_sold_out = coalesce(p_sold_out, false) where id = v_id;
  return coalesce(p_sold_out, false);
end;
$function$;
