-- Mixed channels on one physical inventory.
--
-- The failure named: online keeps selling in the last hour while cash buyers
-- are physically filling bays. Three defences, in order of bluntness:
--
--   1. gate_reserve — bays per zone that online may never sell down into, so
--      the marshal always has stock in hand even if a cash sale takes a minute
--      to get recorded.
--   2. online_sales_close_at — a hard stop per event. After it, gate only.
--   3. Fast gate recording. Nothing here replaces that; these two just buy the
--      slack to be a few sales behind without overselling.

alter table zone add column gate_reserve int not null default 0
  check (gate_reserve >= 0);
comment on column zone.gate_reserve is
  'Bays held back from online sale so walk-ups always have somewhere to go.';

alter table event add column online_sales_close_at timestamptz;
comment on column event.online_sales_close_at is
  'After this, online sales stop and the night is gate-controlled. Null = open until sold out.';

alter table booking add column payment_method text not null default 'stripe'
  check (payment_method in ('stripe','cash','tap_to_pay','bank_transfer','free','other'));
alter table booking add column checked_in_at timestamptz;
alter table booking add column notes text;
create index on booking (event_id, checked_in_at);

-- Starting point: two back-yard bays and one lawn bay kept for walk-ups,
-- online closing 45 minutes before kickoff.
update zone set gate_reserve = 2 where code = 'back_yard';
update zone set gate_reserve = 1 where code = 'front_lawn';
update event set online_sales_close_at = starts_at - interval '45 minutes';

-- Carry gate_reserve through the inventory view first, so the availability
-- view can see it.
create or replace view v_bay_inventory
with (security_invoker = true) as
select
  eo.event_id, eo.property_id,
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
  a.booking_id, a.role as allocation_role, (a.id is null) as available,
  z.gate_reserve
from event_offer eo
join zone z on z.property_id = eo.property_id and z.active
join bay  b on b.zone_id = z.id and b.active
left join bay_allocation a on a.event_id = eo.event_id and a.bay_id = b.id;

-- spots_left now respects the reserve and the cutoff; spots_left_gate does not.
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
         select sum(least(z.matching, greatest(0, z.zone_available - z.gate_reserve)))
         from (
           select i.zone_id,
                  max(i.gate_reserve)                 as gate_reserve,
                  count(*) filter (where i.available) as zone_available,
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

grant select on v_bay_inventory, v_tier_availability to anon, authenticated;
