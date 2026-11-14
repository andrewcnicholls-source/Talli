-- =====================================================================
--  Talli Parking — prices by distance from Eden Park (rings)
--
--  Andrew, 14 Nov 2026: price is set by how far a house is from Eden
--  Park, like a bullseye. Ring 1 is within 200m, ring 2 the next 200m,
--  and so on. Two houses in the same ring always charge the same for the
--  same type of park. An area takes its ring from its anchor house by
--  default, and Andrew can put an area on the boundary in the ring he
--  thinks right.
--
--  This replaces "an adjustment per area" (plan B1) with "an adjustment
--  per ring". Everything else in B1 stands: prices are still measured
--  from the reference site (86 Paice Ave); Andrew still moves one price
--  and everything follows; every site in an area charges the same, so
--  the price shown is the price paid.
--
--  What changes:
--
--    1. price_ring (ring, outer_metres): rings 1–4 at 200m each, ring 5
--       for everything beyond 800m. Distances are to the point the
--       booking page uses for Eden Park.
--    2. ring_tier_offset (ring, code, offset_cents): a ring's price per
--       type, as a difference from the reference site. The reference
--       site's ring is always zero.
--    3. block.ring_override: the ring Andrew has put an area in, or null
--       for "from its anchor's distance".
--    4. block_ring(): the override, else the anchor's ring, else (no
--       position) the reference site's ring — priced as the reference,
--       as a site in no area always was.
--    5. apply_price_offsets() prices every site from its area's ring.
--       block_tier_offset stays in the table and nothing reads it.
--    6. set_ring_offsets() and set_block_ring(), each re-pricing the
--       upcoming nights they affect. set_block_offsets() refuses, by
--       name, so nothing can set the retired per-area figure.
--
--  Starting figures: each ring takes the per-area adjustment of the area
--  in it with the lowest sort order (the reference ring stays zero). An
--  area whose old adjustment differs from its ring's now charges its
--  ring's price; a NOTICE names it. Check the Sites page after release.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. The rings
-- ---------------------------------------------------------------------
create table if not exists price_ring (
  ring         smallint primary key check (ring between 1 and 9),
  outer_metres integer check (outer_metres is null or outer_metres > 0),
  updated_at   timestamptz not null default now()
);

comment on table price_ring is
  'Distance bands around Eden Park. A house belongs to the first ring '
  'whose outer_metres it is within; the ring with no outer_metres takes '
  'everything further out.';

insert into price_ring (ring, outer_metres) values
  (1, 200), (2, 400), (3, 600), (4, 800), (5, null)
on conflict (ring) do nothing;

alter table price_ring enable row level security;
revoke all on price_ring from public, anon, authenticated;
grant all on price_ring to service_role;

-- ---------------------------------------------------------------------
--  2. A ring's price per type
-- ---------------------------------------------------------------------
create table if not exists ring_tier_offset (
  ring         smallint not null references price_ring(ring) on delete cascade,
  code         text not null check (code in ('standard', 'priority', 'valet')),
  offset_cents integer not null default 0 check (abs(offset_cents) <= 10000),
  updated_at   timestamptz not null default now(),
  primary key (ring, code)
);

comment on table ring_tier_offset is
  'A ring''s price for each type of park, as a difference from the '
  'reference site. Every site in an area in this ring charges reference + '
  'this. A missing row is zero. The reference site''s ring is always zero.';

alter table ring_tier_offset enable row level security;
revoke all on ring_tier_offset from public, anon, authenticated;
grant all on ring_tier_offset to service_role;

-- ---------------------------------------------------------------------
--  3. An area put in a ring by hand
-- ---------------------------------------------------------------------
alter table block add column if not exists ring_override smallint references price_ring(ring);

comment on column block.ring_override is
  'The ring Andrew has put this area in, for one on a boundary. Null: '
  'the ring its anchor house is in by distance from Eden Park.';

comment on table block_tier_offset is
  'Retired by price rings (20261124100000): nothing reads it. An area is '
  'priced from its ring in ring_tier_offset.';

-- ---------------------------------------------------------------------
--  4. Which ring
-- ---------------------------------------------------------------------
-- Distance in metres between two map positions. Flat-earth is plenty at
-- this scale. Null when either is unknown. (Also defined, identically,
-- by 20261123100000_talli_placement_nearest.)
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

-- Metres from Eden Park: the same point the booking page and Getting Here
-- draw it at.
create or replace function private.metres_from_eden_park(p_lat numeric, p_lng numeric)
returns double precision
language sql
immutable
as $function$
  select private.metres_between(-36.8749, 174.7448, p_lat, p_lng);
$function$;

revoke all on function private.metres_from_eden_park(numeric, numeric) from public;
grant execute on function private.metres_from_eden_park(numeric, numeric) to service_role;

-- The ring a distance falls in. Null distance, null ring.
create or replace function private.ring_for_metres(p_metres double precision)
returns smallint
language sql
stable
set search_path to 'public'
as $function$
  select r.ring from price_ring r
   where p_metres is not null
     and (r.outer_metres is null or p_metres <= r.outer_metres)
   order by r.outer_metres nulls last, r.ring
   limit 1;
$function$;

revoke all on function private.ring_for_metres(double precision) from public;
grant execute on function private.ring_for_metres(double precision) to service_role;

-- The ring an area's anchor house is in by distance. Null with no anchor
-- or no position.
create or replace function public.block_ring_by_distance(p_block_id uuid)
returns smallint
language sql
stable
set search_path to 'public'
as $function$
  select private.ring_for_metres(private.metres_from_eden_park(p.lat, p.lng))
    from block b join property p on p.id = b.anchor_property_id
   where b.id = p_block_id;
$function$;

-- The ring the reference site prices from: its area's ring by distance
-- (its area cannot be overridden), else its own position.
create or replace function public.reference_ring()
returns smallint
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(
    (select public.block_ring_by_distance(p.block_id) from property p
      where p.id = reference_property() and p.block_id is not null),
    (select private.ring_for_metres(private.metres_from_eden_park(p.lat, p.lng))
       from property p where p.id = reference_property()));
$function$;

-- The ring an area is priced in: Andrew's choice, else its anchor's
-- distance, else the reference site's ring.
create or replace function public.block_ring(p_block_id uuid)
returns smallint
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(
    (select ring_override from block where id = p_block_id),
    public.block_ring_by_distance(p_block_id),
    public.reference_ring());
$function$;

-- ---------------------------------------------------------------------
--  Starting figures, from the per-area adjustments as they stood
-- ---------------------------------------------------------------------
do $$
declare
  v_ref_block uuid := (select block_id from property where id = reference_property());
  v_ref_ring smallint := public.reference_ring();
  r record;
begin
  insert into ring_tier_offset (ring, code, offset_cents)
  select distinct on (public.block_ring(b.id), bto.code)
         public.block_ring(b.id), bto.code, bto.offset_cents
    from block b
    join block_tier_offset bto on bto.block_id = b.id
   where b.id is distinct from v_ref_block
     and public.block_ring(b.id) is not null
     and public.block_ring(b.id) is distinct from v_ref_ring
   order by public.block_ring(b.id), bto.code, b.sort_order, b.name
  on conflict (ring, code) do nothing;

  for r in
    select b.name, public.block_ring(b.id) as ring, bto.code, bto.offset_cents as was,
           coalesce(rto.offset_cents, 0) as now
      from block b
      join block_tier_offset bto on bto.block_id = b.id
      left join ring_tier_offset rto on rto.ring = public.block_ring(b.id) and rto.code = bto.code
     where bto.offset_cents <> coalesce(rto.offset_cents, 0)
  loop
    raise notice 'Area % (ring %): % moves from % to % cents against the reference',
      r.name, r.ring, r.code, r.was, r.now;
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  5. Price every site from its area's ring
-- ---------------------------------------------------------------------
-- Same signature and shape as 20261115100000. A site in no area is
-- priced as the reference. Never below $1. Returns how many prices
-- changed. An event the reference site is not part of is left alone.
create or replace function public.apply_price_offsets(p_event_id uuid)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_ref uuid := reference_property();
  v_n integer;
begin
  if v_ref is null then
    return 0;
  end if;

  with ref as (
    select t.code, t.price_cents
      from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and o.property_id = v_ref
  ),
  want as (
    select t.id,
           greatest(100, ref.price_cents + coalesce(rto.offset_cents, 0)) as price_cents
      from offer_tier t
      join event_offer o on o.id = t.event_offer_id
      join property p    on p.id = o.property_id
      join ref           on ref.code = t.code
      left join ring_tier_offset rto
             on p.block_id is not null
            and rto.ring = public.block_ring(p.block_id)
            and rto.code = t.code
     where o.event_id = p_event_id
       and o.property_id <> v_ref
  )
  update offer_tier t
     set price_cents = want.price_cents,
         price_updated_at = now()
    from want
   where t.id = want.id
     and t.price_cents is distinct from want.price_cents;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- Re-price every upcoming night. Returns how many.
create or replace function private.reprice_upcoming(p_block_id uuid default null)
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_n integer := 0;
  r record;
begin
  for r in
    select distinct o.event_id
      from event_offer o
      join property p on p.id = o.property_id
      join event e on e.id = o.event_id
     where (p_block_id is null or p.block_id = p_block_id)
       and e.starts_at > now()
       and e.status not in ('closed', 'cancelled')
  loop
    perform apply_price_offsets(r.event_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;

revoke all on function private.reprice_upcoming(uuid) from public, anon, authenticated;
grant execute on function private.reprice_upcoming(uuid) to service_role;

-- ---------------------------------------------------------------------
--  6. Setting them
-- ---------------------------------------------------------------------
-- p_offsets: [{code, offset_cents}, ...]. Types not named keep what they
-- had. Re-prices every upcoming night. Returns how many.
create or replace function public.set_ring_offsets(p_ring smallint, p_offsets jsonb)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_item jsonb;
  v_code text;
  v_cents integer;
begin
  if not exists (select 1 from price_ring where ring = p_ring) then
    raise exception 'NO_SUCH_RING: there is no ring %', p_ring using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_offsets, '[]'::jsonb)) loop
    v_code := lower(v_item->>'code');
    if v_code not in ('standard', 'priority', 'valet') then
      raise exception 'BAD_TYPE: no type of park called "%"', v_code using errcode = 'check_violation';
    end if;
    begin
      v_cents := (v_item->>'offset_cents')::integer;
    exception when others then
      v_cents := null;
    end;
    if v_cents is null or abs(v_cents) > 10000 then
      raise exception 'BAD_OFFSET: an adjustment must be within $100' using errcode = 'check_violation';
    end if;
    if v_cents <> 0 and p_ring = public.reference_ring() then
      raise exception 'REFERENCE_RING: the reference site''s ring is the price everything '
                      'is measured from; its adjustment is always zero'
        using errcode = 'check_violation';
    end if;

    insert into ring_tier_offset (ring, code, offset_cents, updated_at)
    values (p_ring, v_code, v_cents, now())
    on conflict (ring, code) do update
      set offset_cents = excluded.offset_cents, updated_at = now();
  end loop;

  return private.reprice_upcoming(null);
end;
$function$;

-- Put an area in a ring by hand, or (null) back to its anchor's distance.
-- Not the reference site's area: its ring is what every price is measured
-- from. Re-prices the area's upcoming nights. Returns how many.
create or replace function public.set_block_ring(p_block_id uuid, p_ring smallint)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if not exists (select 1 from block where id = p_block_id) then
    raise exception 'NO_SUCH_BLOCK: that area does not exist' using errcode = 'check_violation';
  end if;
  if p_ring is not null and not exists (select 1 from price_ring where ring = p_ring) then
    raise exception 'NO_SUCH_RING: there is no ring %', p_ring using errcode = 'check_violation';
  end if;
  if p_block_id = (select block_id from property where id = reference_property()) then
    raise exception 'REFERENCE_BLOCK: the reference site''s area stays in the ring its '
                    'distance puts it in; every price is measured from it'
      using errcode = 'check_violation';
  end if;

  update block set ring_override = p_ring where id = p_block_id;
  return private.reprice_upcoming(p_block_id);
end;
$function$;

-- The per-area figure is retired. Refused by name, so an old screen
-- cannot write a number nothing reads and think it changed a price.
create or replace function public.set_block_offsets(p_block_id uuid, p_offsets jsonb)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
begin
  raise exception 'PRICED_BY_RING: an area is priced by its ring now — set the ring''s '
                  'prices, or put the area in another ring'
    using errcode = 'check_violation';
end;
$function$;

revoke all on function public.block_ring_by_distance(uuid) from public, anon, authenticated;
revoke all on function public.reference_ring() from public, anon, authenticated;
revoke all on function public.block_ring(uuid) from public, anon, authenticated;
revoke all on function public.set_ring_offsets(smallint, jsonb) from public, anon, authenticated;
revoke all on function public.set_block_ring(uuid, smallint) from public, anon, authenticated;
grant execute on function public.block_ring_by_distance(uuid) to service_role;
grant execute on function public.reference_ring() to service_role;
grant execute on function public.block_ring(uuid) to service_role;
grant execute on function public.set_ring_offsets(smallint, jsonb) to service_role;
grant execute on function public.set_block_ring(uuid, smallint) to service_role;

-- Every upcoming night, priced by ring from here on.
select private.reprice_upcoming(null);
