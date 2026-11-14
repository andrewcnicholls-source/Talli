-- =====================================================================
--  Talli Parking — place a car at the nearest house that has the space
--  it paid for (follow-up to plan B5)
--
--  Andrew, 14 Nov 2026: where a car goes is about what it paid for. A
--  Standard car goes to the nearest Standard space; if the only one is
--  two houses down, that is where it goes. The same for Priority: if the
--  closest Priority space is two houses away, the car goes there.
--
--  What changes in propose_space, and nothing else:
--
--    1. "Elsewhere in the block" is ordered by distance from the house
--       the warden is standing at, nearest first. It was the anchor
--       first, then the most room. Houses with no map position come
--       after every house that has one, then anchor first, most room, as
--       before.
--    2. Every type may go to its own type at another house in the block.
--       It was Standard only: a Priority car whose Priority space here was
--       gone was proposed nothing. Only Standard still spills into
--       another type (Priority). Nothing ever goes into Valet that was not
--       sold as Valet.
--
--  The order for a Standard car is unchanged otherwise: Standard here;
--  Standard at the nearest house in the block; Priority here; Priority at
--  the nearest house.
--
--  sell_at_gate only asks propose_space about Standard, so a Priority or
--  Valet walk-up is still sold where the warden is standing, or refused.
--  Online selling (hold_booking) is untouched. Restated with the same
--  signature and grants.
-- =====================================================================

-- Distance in metres between two map positions. Flat-earth is plenty
-- for houses a few hundred metres apart. Null when either is unknown.
create or replace function private.metres_between(
  p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
returns double precision
language sql
immutable
as $function$
  select case when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null
              then null
              else sqrt(power((p_lat2 - p_lat1)::double precision * 111320, 2)
                        + power((p_lng2 - p_lng1)::double precision * 111320
                                * cos(radians(((p_lat1 + p_lat2) / 2)::double precision)), 2))
         end;
$function$;

revoke all on function private.metres_between(numeric, numeric, numeric, numeric) from public;
grant execute on function private.metres_between(numeric, numeric, numeric, numeric)
  to anon, authenticated, service_role;

-- Where a car of this type should go, standing at p_property_id. One row,
-- or none when there is no room anywhere it may go.
--
--   Its own type here; its own type at the nearest house in the block.
--   Standard only, after that: a Priority space here; a Priority space
--   at the nearest house in the block. Never Valet unless sold as Valet.
create or replace function propose_space(
  p_event_id uuid, p_property_id uuid, p_tier_code text,
  p_booking_id uuid default null, p_selling boolean default false)
returns table (property_id uuid, space_code text, free integer)
language sql
stable
set search_path to 'public'
as $function$
  with here as (
    select p.id, p.block_id, p.lat, p.lng from property p where p.id = p_property_id
  ),
  sites as (
    -- This site, and when it is in a block, every active site in the
    -- block that is confirmed for this night.
    select o.property_id as id,
           (o.property_id = p_property_id) as is_here,
           coalesce(o.property_id = bl.anchor_property_id, false) as is_anchor,
           private.metres_between(here.lat, here.lng, pr.lat, pr.lng) as metres,
           pr.name
      from event_offer o
      join property pr on pr.id = o.property_id
      left join block bl on bl.id = pr.block_id
      cross join here
     where o.event_id = p_event_id
       and (o.property_id = p_property_id
            or (here.block_id is not null and pr.block_id = here.block_id and pr.active
                and o.status = 'confirmed'))
  ),
  options as (
    select s.id, c.code, s.is_here, s.is_anchor, s.metres, s.name,
           private.space_free(p_event_id, s.id, c.code, p_booking_id, p_selling) as free,
           case when c.code = p_tier_code and s.is_here then 0
                when c.code = p_tier_code then 1
                when s.is_here then 2
                else 3 end as rank
      from sites s
      cross join (
        select p_tier_code as code
        union all
        select 'priority' where p_tier_code = 'standard'
      ) c
  )
  select id, code, free
    from options
   where free > 0
   order by rank, metres nulls last, is_anchor desc, free desc, name
   limit 1;
$function$;

revoke all on function propose_space(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function propose_space(uuid, uuid, text, uuid, boolean) to service_role;
