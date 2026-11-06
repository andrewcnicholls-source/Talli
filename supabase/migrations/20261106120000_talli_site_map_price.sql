-- =====================================================================
--  Talli Parking — a price on each house on the booking map
--
--  The map shows each driveway as a price pill ("$30"), so the pin needs
--  the cheapest price still on sale online there. Same view, one column
--  added at the end. Additive only.
-- =====================================================================

create or replace view v_event_site_map
with (security_invoker = true) as
select a.event_id,
       p.id                        as property_id,
       p.name                      as site_name,
       p.lat, p.lng,
       bl.id                       as block_id,
       bl.name                     as block_name,
       (p.id = bl.anchor_property_id) as is_anchor,
       sum(a.spots_left)::integer  as spots_left,
       coalesce(min(a.price_cents) filter (where a.spots_left > 0),
                min(a.price_cents)) as from_cents
  from v_tier_availability a
  join property p    on p.id = a.property_id and p.active
  join block bl      on bl.id = p.block_id and bl.active
  join event_offer o on o.event_id = a.event_id and o.property_id = a.property_id
 where o.status = 'confirmed'
   and p.lat is not null and p.lng is not null
 group by a.event_id, p.id, p.name, p.lat, p.lng, bl.id, bl.name, bl.anchor_property_id;

grant select on v_event_site_map to anon, authenticated;
