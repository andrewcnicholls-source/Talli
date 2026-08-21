-- The front lawn is 3 across and 2 deep, not 6 independent bays. The street
-- row boxes in the back row, so only 3 of the 6 can honestly be sold as
-- "priority exit". Fixing that exposed a flaw in how tiers pick bays.
--
-- THE FLAW: bay_kind was 'clear' vs 'blocking' — whether a bay blocks someone
-- ELSE. But what the customer buys is whether THEY can leave. Different things:
--
--   lawn street row        — blocks the row behind, itself free to leave
--   back-yard double-park  — blocks a bay, itself free to leave
--   lawn back row          — blocks nobody, itself boxed in
--   back-yard ordinary bay — blocks nobody, itself boxed in
--
-- 'priority' needs the lawn street row AND the berm, which sat on opposite
-- sides of the old axis, so it could not be expressed at all. Switch the axis
-- to the customer's own exit:
--
--   free_exit      -> nothing can park in behind you
--   may_be_blocked -> something can
--
-- What then separates the lawn street row from a back-yard double-park spot is
-- an honest second question: does occupying it require promising to leave
-- early? Back yard yes; lawn no, because the lawn back row knowingly bought
-- "you'll wait for the car in front".

alter table bay add column requires_early_departure boolean not null default false;
comment on column bay.requires_early_departure is
  'Occupying this bay boxes in someone who has NOT agreed to wait, so it may only be sold with a departure deadline. True for back-yard double-park positions, false for the lawn street row.';

update bay set requires_early_departure = true where blocks_bay_id is not null;

-- ---------------------------------------------------- rebuild the front lawn
-- Safe: no bookings exist. 6 independent bays become 3 street + 3 back.

delete from bay where zone_id = (
  select z.id from zone z join property p on p.id = z.property_id
   where z.code = 'front_lawn' and p.name = '86 Paice Ave');

with z as (
  select z.id from zone z join property p on p.id = z.property_id
   where z.code = 'front_lawn' and p.name = '86 Paice Ave'
), back_row as (
  insert into bay (zone_id, label, size_class)
  select z.id, 'Lawn back row ' || g, 'standard' from z cross join generate_series(1,3) g
  returning id, label
)
insert into bay (zone_id, label, blocks_bay_id, requires_early_departure)
select (select id from z), 'Lawn street row ' || right(b.label,1), b.id, false
from back_row b;

-- ---------------------------------------------------- the new axis

alter table offer_tier drop constraint if exists offer_tier_bay_kind_check;
alter table offer_tier drop constraint if exists offer_tier_check1;
update offer_tier set bay_kind = 'may_be_blocked' where bay_kind = 'clear';
update offer_tier set bay_kind = 'free_exit'      where bay_kind = 'blocking';
alter table offer_tier add constraint offer_tier_bay_kind_check
  check (bay_kind in ('free_exit','may_be_blocked','any'));

drop view if exists v_bay_inventory cascade;

create view v_bay_inventory
with (security_invoker = true) as
select
  eo.event_id, eo.property_id,
  z.id as zone_id, z.code as zone_code, z.label as zone_label,
  z.keys_held, z.reservable_in_advance, z.requires_consent, z.exit_rank,
  b.id as bay_id, b.label as bay_label, b.size_class,
  b.blocks_bay_id, b.requires_early_departure,
  (b.blocks_bay_id is not null) as blocks_someone,
  (select bb.id from bay bb where bb.blocks_bay_id = b.id and bb.active) as blocker_bay_id,
  -- The customer's own exit, which is what they are actually buying.
  case
    when z.keys_held then 'valet'
    when (select bb.id from bay bb where bb.blocks_bay_id = b.id and bb.active) is null
         then 'free_exit'
    else 'may_be_blocked'
  end as exit_class,
  a.booking_id, a.role as allocation_role, (a.id is null) as available,
  z.gate_reserve
from event_offer eo
join zone z on z.property_id = eo.property_id and z.active
join bay  b on b.zone_id = z.id and b.active
left join bay_allocation a on a.event_id = eo.event_id and a.bay_id = b.id;

create view v_tier_availability
with (security_invoker = true) as
select
  t.id as offer_tier_id, eo.event_id, eo.property_id,
  t.code, t.label, t.price_cents,
  t.zone_codes, t.bay_kind, t.guarantees_clear_exit,
  t.arrival_from, t.arrival_until, t.departure_by, t.sort_order,
  case when e.online_sales_close_at is not null and now() > e.online_sales_close_at
       then 0
       else coalesce((
         select sum(greatest(0, zz.matching - zz.gate_reserve))
         from (
           select i.zone_id,
                  max(i.gate_reserve) as gate_reserve,
                  count(*) filter (where i.available
                    and case t.bay_kind
                          when 'free_exit'      then i.blocker_bay_id is null
                          when 'may_be_blocked' then i.blocker_bay_id is not null
                          else true end
                    and (t.departure_by is not null or not i.requires_early_departure)
                    and (not t.guarantees_clear_exit or i.blocker_bay_id is null
                         or not exists (select 1 from bay_allocation a2
                                        where a2.event_id = i.event_id
                                          and a2.bay_id = i.blocker_bay_id))) as matching
           from v_bay_inventory i
           where i.event_id = eo.event_id and i.property_id = eo.property_id
             and i.reservable_in_advance
             and (t.zone_codes is null or i.zone_code = any(t.zone_codes))
           group by i.zone_id
         ) zz), 0) end::int as spots_left,
  (select count(*) from v_bay_inventory i
    where i.event_id = eo.event_id and i.property_id = eo.property_id
      and i.available
      and (t.zone_codes is null or i.zone_code = any(t.zone_codes))
      and case t.bay_kind
            when 'free_exit'      then i.blocker_bay_id is null
            when 'may_be_blocked' then i.blocker_bay_id is not null
            else true end
      and (t.departure_by is not null or not i.requires_early_departure)
      and (not t.guarantees_clear_exit or i.blocker_bay_id is null
           or not exists (select 1 from bay_allocation a2
                          where a2.event_id = i.event_id and a2.bay_id = i.blocker_bay_id))
  )::int as spots_left_gate
from offer_tier t
join event_offer eo on eo.id = t.event_offer_id
join event e on e.id = eo.event_id
where t.active;

create view v_zone_capacity
with (security_invoker = true) as
select
  eo.event_id, eo.property_id, i.zone_code, i.zone_label,
  i.exit_rank, i.keys_held, i.reservable_in_advance, i.requires_consent,
  count(*)::int                                      as bays,
  count(*) filter (where i.blocks_someone)::int      as blocking_positions,
  count(*) filter (where i.blocker_bay_id is null)::int as free_exit_bays,
  count(*) filter (where i.available)::int           as available_now
from event_offer eo
join v_bay_inventory i on i.event_id = eo.event_id and i.property_id = eo.property_id
group by eo.event_id, eo.property_id, i.zone_code, i.zone_label,
         i.exit_rank, i.keys_held, i.reservable_in_advance, i.requires_consent;

create view v_gate_list
with (security_invoker = true) as
select
  b.event_id, e.name as event_name, b.id as booking_id,
  b.customer_name, b.customer_phone, b.vehicle_rego, b.tier_code,
  i.zone_label, i.bay_label, i.exit_class,
  b.arrival_from, b.arrival_until, b.must_depart_by,
  b.accepts_street_parking, b.channel, b.payment_method, b.status,
  b.checked_in_at, (b.checked_in_at is not null) as arrived,
  b.amount_cents, b.notes
from booking b
join event e on e.id = b.event_id
left join bay_allocation a on a.booking_id = b.id and a.role = 'occupied'
left join v_bay_inventory i on i.bay_id = a.bay_id and i.event_id = b.event_id
where b.status in ('paid','held');

create view v_relocatable_to_consent_zone
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

grant select on v_bay_inventory, v_tier_availability, v_zone_capacity
  to anon, authenticated;
revoke all on v_gate_list, v_relocatable_to_consent_zone
  from public, anon, authenticated;
