-- =====================================================================
--  Talli Parking — the houses on the booking page map
--
--  One row per driveway on sale online for an event, with where it is and
--  how many spaces it has left, so the booking page can pin every bookable
--  house and fit the map around them and Eden Park.
--
--  Only confirmed sites with a location appear. A site with no lat/lng is
--  still sold; it is just not pinned until someone sets its position.
--  Additive only: one view.
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
       sum(a.spots_left)::integer  as spots_left
  from v_tier_availability a
  join property p    on p.id = a.property_id and p.active
  join block bl      on bl.id = p.block_id and bl.active
  join event_offer o on o.event_id = a.event_id and o.property_id = a.property_id
 where o.status = 'confirmed'
   and p.lat is not null and p.lng is not null
 group by a.event_id, p.id, p.name, p.lat, p.lng, bl.id, bl.name, bl.anchor_property_id;

comment on view v_event_site_map is
  'Pins for the booking page map: each confirmed, located site at an event, '
  'with its block and online spaces left.';

grant select on v_event_site_map to anon, authenticated;

-- 86 Paice Ave's position (OpenStreetMap, 6 Nov 2026), so the Paice Ave
-- block is on the map from the start. Only fills an empty position.
update property set lat = -36.879536, lng = 174.740911
 where name = '86 Paice Ave' and lat is null;
