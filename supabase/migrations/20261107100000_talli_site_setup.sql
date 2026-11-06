-- =====================================================================
--  Talli Parking — setting up a site, and pricing every site from one
--
--  The Sites tab on the gate screen (operator only for now; later the
--  host's own page) sets, per driveway:
--
--    * how many spaces of each type it has, and how many of those sell
--      online (the rest are held for the warden to sell on the night);
--    * a price offset from the reference site — Andrew's house, the
--      operator's own property. "-$5" means always five dollars under it.
--
--  Prices then move together: set a price on the reference site (or apply
--  a price template) and every other site in that event follows at its
--  offset. A price set by hand on one other site still sticks for that
--  site until the reference price next changes.
--
--  Also: create_site() adds a driveway (and its host and area if new) from
--  the phone, so a new host no longer needs SQL.
--
--  Additive only: one column, one table, new functions, and
--  add_event_offer() replaced with the same signature.
-- =====================================================================

alter table property
  add column if not exists price_offset_cents integer not null default 0;

comment on column property.price_offset_cents is
  'Price difference from the reference site (the operator''s own property), '
  'applied to every type of space. Negative is cheaper.';

create table if not exists property_tier_default (
  property_id uuid not null references property(id) on delete cascade,
  code        text not null check (code in ('standard', 'priority', 'valet')),
  capacity    integer not null default 0 check (capacity >= 0),
  online      integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (property_id, code),
  constraint property_tier_default_online_check check (online between 0 and capacity)
);

-- Start every site from what it is selling now: the counts on its next
-- upcoming event, or its most recent one. Without this a site nobody has
-- set up yet reads as zero spaces, and saving it with "apply to upcoming"
-- would empty its future events.
insert into property_tier_default (property_id, code, capacity, online)
select distinct on (o.property_id, t.code)
       o.property_id, t.code, t.capacity,
       greatest(t.capacity - coalesce(t.gate_reserve, 0), 0)
  from offer_tier t
  join event_offer o on o.id = t.event_offer_id
  join event e on e.id = o.event_id
 where t.code in ('standard', 'priority', 'valet')
 order by o.property_id, t.code,
          (e.starts_at < now()),                       -- upcoming first
          case when e.starts_at >= now() then e.starts_at end asc,
          e.starts_at desc
on conflict (property_id, code) do nothing;

comment on table property_tier_default is
  'A site''s usual spaces per type and how many sell online. Copied into '
  'each event the site joins; optionally pushed to its upcoming events.';

alter table property_tier_default enable row level security;
grant all on property_tier_default to service_role;

-- The site every other price is measured from: the operator's own house.
create or replace function public.reference_property()
 returns uuid
 language sql
 stable
 set search_path to 'public'
as $function$
  select p.id
    from property p join host h on h.id = p.host_id
   where h.is_operator and p.active
   order by p.created_at
   limit 1;
$function$;

-- Re-price every other site at an event from the reference site's prices.
-- Never below $1. Returns how many prices changed.
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
  )
  update offer_tier t
     set price_cents = greatest(100, ref.price_cents + p.price_offset_cents),
         price_updated_at = now()
    from event_offer o, property p, ref
   where t.event_offer_id = o.id
     and o.event_id = p_event_id
     and o.property_id <> v_ref
     and p.id = o.property_id
     and ref.code = t.code
     and t.price_cents is distinct from greatest(100, ref.price_cents + p.price_offset_cents);
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- Save a site's setup. With p_apply_upcoming, also push the counts to every
-- upcoming event the site is already in, never below what is already sold,
-- and re-price those events from the reference site.
create or replace function public.save_site_setup(
  p_property_id uuid,
  p_offset_cents integer,
  p_tiers jsonb,
  p_apply_upcoming boolean default false)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_tier jsonb;
  v_code text;
  v_cap integer;
  v_online integer;
  v_events integer := 0;
  v_kept integer := 0;
  r record;
begin
  if not exists (select 1 from property where id = p_property_id) then
    raise exception 'NO_SUCH_SITE: that site does not exist' using errcode = 'check_violation';
  end if;
  if p_offset_cents is null or abs(p_offset_cents) > 10000 then
    raise exception 'BAD_OFFSET: the price difference must be within $100' using errcode = 'check_violation';
  end if;

  update property set price_offset_cents = p_offset_cents where id = p_property_id;

  for v_tier in select * from jsonb_array_elements(coalesce(p_tiers, '[]'::jsonb)) loop
    v_code := v_tier->>'code';
    v_cap := greatest(0, coalesce((v_tier->>'capacity')::int, 0));
    v_online := least(v_cap, greatest(0, coalesce((v_tier->>'online')::int, 0)));
    insert into property_tier_default (property_id, code, capacity, online, updated_at)
    values (p_property_id, v_code, v_cap, v_online, now())
    on conflict (property_id, code) do update
      set capacity = excluded.capacity, online = excluded.online, updated_at = now();
  end loop;

  if p_apply_upcoming then
    for r in
      select o.event_id, t.id as tier_id, d.capacity, d.online,
             private.tier_sold(o.event_id, o.property_id, t.code) as sold
        from event_offer o
        join event e on e.id = o.event_id
        join offer_tier t on t.event_offer_id = o.id
        join property_tier_default d on d.property_id = o.property_id and d.code = t.code
       where o.property_id = p_property_id
         and e.starts_at > now()
         and e.status not in ('closed', 'cancelled')
    loop
      if r.capacity < r.sold then
        v_kept := v_kept + 1;
      end if;
      update offer_tier
         set capacity = greatest(r.capacity, r.sold),
             gate_reserve = greatest(0, greatest(r.capacity, r.sold) - r.online)
       where id = r.tier_id;
    end loop;

    for r in
      select distinct o.event_id
        from event_offer o join event e on e.id = o.event_id
       where o.property_id = p_property_id
         and e.starts_at > now()
         and e.status not in ('closed', 'cancelled')
    loop
      perform apply_price_offsets(r.event_id);
      v_events := v_events + 1;
    end loop;
  end if;

  return jsonb_build_object('events_updated', v_events, 'kept_at_sold', v_kept);
end;
$function$;

-- Add a driveway from the phone: its host (by name) and, if new, its area.
create or replace function public.create_site(
  p_name text,
  p_address text,
  p_host_name text,
  p_block_id uuid default null,
  p_new_block_name text default null,
  p_lat numeric default null,
  p_lng numeric default null)
 returns uuid
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_host uuid;
  v_block uuid := p_block_id;
  v_property uuid;
begin
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_address), '') = '' then
    raise exception 'SITE_DETAILS_REQUIRED: a name and an address are needed'
      using errcode = 'check_violation';
  end if;
  if v_block is null and coalesce(trim(p_new_block_name), '') = '' then
    raise exception 'AREA_REQUIRED: pick an area or name a new one' using errcode = 'check_violation';
  end if;

  -- A host is who gets paid for the driveway. Their email is not needed
  -- until they sign in, so a placeholder stands in until then.
  insert into host (name, email, platform_share, payout_method)
  values (trim(coalesce(nullif(p_host_name, ''), p_name)),
          'host+' || replace(gen_random_uuid()::text, '-', '') || '@talli.co.nz',
          0.5, 'manual_bank')
  returning id into v_host;

  if v_block is null then
    insert into block (name, sort_order)
    values (trim(p_new_block_name), (select coalesce(max(sort_order), 0) + 10 from block))
    returning id into v_block;
  end if;

  insert into property (host_id, name, address, active, block_id, lat, lng)
  values (v_host, trim(p_name), trim(p_address), true, v_block, p_lat, p_lng)
  returning id into v_property;

  -- The first driveway in a new area is its anchor.
  update block set anchor_property_id = v_property
   where id = v_block and anchor_property_id is null;

  return v_property;
end;
$function$;

-- add_event_offer, now starting from the site's own setup: its usual
-- counts (online = counts minus what is held for the gate) and its price
-- offset from the reference site. Still joins as pending.
create or replace function public.add_event_offer(p_event_id uuid, p_property_id uuid)
 returns uuid
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_offer uuid;
  v_source uuid;
  v_block uuid;
begin
  if not exists (select 1 from property where id = p_property_id and active) then
    raise exception 'NO_SUCH_SITE: that property is not active'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from event_offer where event_id = p_event_id and property_id = p_property_id) then
    raise exception 'ALREADY_ADDED: that site is already part of this event'
      using errcode = 'check_violation';
  end if;

  select block_id into v_block from property where id = p_property_id;

  select o.id into v_source
    from event_offer o join property p on p.id = o.property_id
   where o.event_id = p_event_id
   order by (p.block_id is not distinct from v_block) desc, o.id
   limit 1;

  insert into event_offer (event_id, property_id, status)
  values (p_event_id, p_property_id, 'pending')
  returning id into v_offer;

  if v_source is not null then
    insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                            guarantees_clear_exit, arrival_from, arrival_until, departure_by,
                            sort_order, active, manually_sold_out, gate_reserve, capacity)
    select v_offer, t.code, t.label, t.price_cents, '{}'::text[], t.bay_kind,
           t.guarantees_clear_exit, t.arrival_from, t.arrival_until, t.departure_by,
           t.sort_order, t.active, false,
           coalesce(d.capacity - d.online, 0), coalesce(d.capacity, 0)
      from offer_tier t
      left join property_tier_default d on d.property_id = p_property_id and d.code = t.code
     where t.event_offer_id = v_source;

    perform apply_price_offsets(p_event_id);
  end if;

  return v_offer;
end;
$function$;

revoke all on function public.reference_property() from public, anon, authenticated;
revoke all on function public.apply_price_offsets(uuid) from public, anon, authenticated;
revoke all on function public.save_site_setup(uuid, integer, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.create_site(text, text, text, uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reference_property() to service_role;
grant execute on function public.apply_price_offsets(uuid) to service_role;
grant execute on function public.save_site_setup(uuid, integer, jsonb, boolean) to service_role;
grant execute on function public.create_site(text, text, text, uuid, text, numeric, numeric) to service_role;
