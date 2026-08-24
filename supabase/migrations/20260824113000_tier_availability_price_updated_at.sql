-- =====================================================================
--  Talli Parking — show when a price last moved
--
--  The prices tab wants to say "changed 6:12pm". That is the difference
--  between a price set last week on purpose and one set an hour ago and
--  forgotten about. offer_tier already records it; the view was not
--  passing it through.
--
--  Appended as the last column so the view can be replaced in place. The
--  availability arithmetic above it is untouched, byte for byte.
-- =====================================================================

create or replace view public.v_tier_availability as
  select t.id as offer_tier_id,
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
       when t.manually_sold_out then (0)::numeric
       when ((e.online_sales_close_at is not null) and (now() > e.online_sales_close_at)) then (0)::numeric
       else coalesce((
         select sum(greatest((0)::bigint, (zz.matching - zz.gate_reserve))) as sum
           from (select i.zone_id,
                        max(i.gate_reserve) as gate_reserve,
                        count(*) filter (where (i.available and
                          case t.bay_kind
                            when 'free_exit'::text then (i.blocker_bay_id is null)
                            when 'may_be_blocked'::text then (i.blocker_bay_id is not null)
                            else true
                          end and ((t.departure_by is not null) or (not i.requires_early_departure))
                          and ((not t.guarantees_clear_exit) or (i.blocker_bay_id is null)
                               or (not (exists (select 1 from bay_allocation a2
                                                 where ((a2.event_id = i.event_id)
                                                    and (a2.bay_id = i.blocker_bay_id)))))))) as matching
                   from v_bay_inventory i
                  where ((i.event_id = eo.event_id) and (i.property_id = eo.property_id)
                     and i.reservable_in_advance
                     and ((t.zone_codes is null) or (i.zone_code = any (t.zone_codes))))
                  group by i.zone_id) zz), (0)::numeric)
     end)::integer as spots_left,
    (case
       when t.manually_sold_out then (0)::bigint
       else (select count(*) as count
               from v_bay_inventory i
              where ((i.event_id = eo.event_id) and (i.property_id = eo.property_id) and i.available
                 and ((t.zone_codes is null) or (i.zone_code = any (t.zone_codes)))
                 and case t.bay_kind
                       when 'free_exit'::text then (i.blocker_bay_id is null)
                       when 'may_be_blocked'::text then (i.blocker_bay_id is not null)
                       else true
                     end
                 and ((t.departure_by is not null) or (not i.requires_early_departure))
                 and ((not t.guarantees_clear_exit) or (i.blocker_bay_id is null)
                      or (not (exists (select 1 from bay_allocation a2
                                        where ((a2.event_id = i.event_id)
                                           and (a2.bay_id = i.blocker_bay_id))))))))
     end)::integer as spots_left_gate,
    t.manually_sold_out,
    t.price_updated_at
   from ((offer_tier t
     join event_offer eo on ((eo.id = t.event_offer_id)))
     join event e on ((e.id = eo.event_id)))
  where t.active;

-- Replacing a view keeps its settings, but state it rather than trust it:
-- this one is read straight from the browser with the public key, so it must
-- run as the caller and stay behind row level security.
alter view public.v_tier_availability set (security_invoker = on);
