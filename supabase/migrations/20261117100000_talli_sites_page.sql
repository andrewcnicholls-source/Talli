-- =====================================================================
--  Talli Parking — the Sites page (plan B3)
--
--  A new site goes from an address to on sale at three nights with no SQL
--  and no visit to Tonight. Everything about a site is set in one place:
--
--    1. save_site_details() — name, address, host, block, map position,
--       walking time, site guide, fill notes, active. Guards: a site with
--       bookings on an upcoming night is not deactivated or moved block;
--       the reference site is neither; a block's anchor is one of its own
--       active sites, so the anchor cannot leave while others remain.
--    2. add_site() — a new driveway from one set of details, its host
--       picked from the existing hosts or named new. create_site() stays
--       as it was for anything still calling it.
--    3. set_block_anchor() — choose which of a block's sites is its anchor.
--    4. set_site_nights() — the nights a site sells, as a tick list. A site
--       joins a night pending (add_event_offer, at its defaults); leaving
--       one is refused while anyone is booked there.
--    5. set_site_night() — one night's actual spaces per type, overriding
--       the defaults, never below what is already sold.
--    6. create_gate_event() — restated from 20260918150000 with two
--       changes: the site it is made at defaults to reference_property()
--       (default_event_property() is no longer called), and every other
--       active site joins the new night pending, at its defaults.
--
--  Additive: new functions, and create_gate_event with its signature as
--  it was. No table, column or view is touched.
-- =====================================================================

-- ---------------------------------------------------------------------
--  Whether anyone is booked at a site on a night still to come. "Booked"
--  is what private.tier_sold counts as spoken for: paid, or a hold that
--  has not run out (a pay-later walk-up's hold never does). A night still
--  in progress counts as to come.
-- ---------------------------------------------------------------------
create or replace function private.site_booked_ahead(
  p_property_id uuid, p_event_id uuid default null
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from booking b
      join event e on e.id = b.event_id
     where (b.property_id = p_property_id or b.booked_property_id = p_property_id)
       and (p_event_id is null or b.event_id = p_event_id)
       and e.status <> 'cancelled'
       and coalesce(e.expected_end_at, e.starts_at) > now()
       and (b.status = 'paid'
            or (b.status = 'held'
                and (b.hold_expires_at is null or b.hold_expires_at > now())))
  );
$$;

revoke all on function private.site_booked_ahead(uuid, uuid) from public, anon, authenticated;
grant execute on function private.site_booked_ahead(uuid, uuid) to service_role;

-- Nights a site can still be added to or taken off: not over, not called off.
create or replace function private.night_is_upcoming(p_event_id uuid)
returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from event e
     where e.id = p_event_id
       and e.status not in ('closed', 'cancelled')
       and coalesce(e.expected_end_at, e.starts_at) > now()
  );
$$;

revoke all on function private.night_is_upcoming(uuid) from public, anon, authenticated;
grant execute on function private.night_is_upcoming(uuid) to service_role;

-- ---------------------------------------------------------------------
--  A host for a site: one already on the books, or a new one by name. A
--  new host's email is not needed until they sign in, so a placeholder
--  stands in until then, as create_site() has always done.
-- ---------------------------------------------------------------------
create or replace function private.site_host(p_host_id uuid, p_new_host_name text)
returns uuid
language plpgsql set search_path = public as $$
declare
  v_host uuid;
begin
  if p_host_id is not null then
    if not exists (select 1 from host where id = p_host_id) then
      raise exception 'NO_SUCH_HOST: that host does not exist' using errcode = 'check_violation';
    end if;
    return p_host_id;
  end if;
  if coalesce(trim(p_new_host_name), '') = '' then
    raise exception 'HOST_REQUIRED: pick a host or name a new one' using errcode = 'check_violation';
  end if;
  insert into host (name, email, platform_share, payout_method)
  values (trim(p_new_host_name),
          'host+' || replace(gen_random_uuid()::text, '-', '') || '@talli.co.nz',
          0.5, 'manual_bank')
  returning id into v_host;
  return v_host;
end;
$$;

-- A block for a site: one that exists, or a new one by name.
create or replace function private.site_block(p_block_id uuid, p_new_block_name text)
returns uuid
language plpgsql set search_path = public as $$
declare
  v_block uuid;
begin
  if p_block_id is not null then
    if not exists (select 1 from block where id = p_block_id and active) then
      raise exception 'NO_SUCH_AREA: that area does not exist' using errcode = 'check_violation';
    end if;
    return p_block_id;
  end if;
  if coalesce(trim(p_new_block_name), '') = '' then
    raise exception 'AREA_REQUIRED: pick an area or name a new one' using errcode = 'check_violation';
  end if;
  if exists (select 1 from block where lower(name) = lower(trim(p_new_block_name))) then
    raise exception 'AREA_EXISTS: there is already an area called %', trim(p_new_block_name)
      using errcode = 'unique_violation';
  end if;
  insert into block (name, sort_order)
  values (trim(p_new_block_name), (select coalesce(max(sort_order), 0) + 10 from block))
  returning id into v_block;
  return v_block;
end;
$$;

-- The checks every set of site details passes, whoever is writing them.
create or replace function private.check_site_fields(p_details jsonb)
returns void
language plpgsql immutable set search_path = public as $$
declare
  v_lat numeric;
  v_lng numeric;
  v_walk text;
  v_link text;
begin
  if (p_details ? 'name' and coalesce(trim(p_details->>'name'), '') = '')
     or (p_details ? 'address' and coalesce(trim(p_details->>'address'), '') = '') then
    raise exception 'SITE_DETAILS_REQUIRED: a name and an address are needed'
      using errcode = 'check_violation';
  end if;

  -- A position is both numbers or neither.
  if (p_details ? 'lat') <> (p_details ? 'lng')
     or ((p_details->>'lat') is null) <> ((p_details->>'lng') is null) then
    raise exception 'BAD_POSITION: a map position needs both numbers' using errcode = 'check_violation';
  end if;
  if (p_details->>'lat') is not null then
    begin
      v_lat := (p_details->>'lat')::numeric;
      v_lng := (p_details->>'lng')::numeric;
    exception when others then
      raise exception 'BAD_POSITION: that map position does not look right' using errcode = 'check_violation';
    end;
    if abs(v_lat) > 90 or abs(v_lng) > 180 then
      raise exception 'BAD_POSITION: that map position does not look right' using errcode = 'check_violation';
    end if;
  end if;

  v_walk := p_details->>'walk_minutes';
  if v_walk is not null and (v_walk !~ '^\d{1,3}$') then
    raise exception 'BAD_WALK: walking time is whole minutes' using errcode = 'check_violation';
  end if;

  v_link := nullif(trim(coalesce(p_details->>'site_guide_url', '')), '');
  if v_link is not null and v_link !~* '^https://' then
    raise exception 'BAD_LINK: the site guide must be an https:// link' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function private.site_host(uuid, text) from public, anon, authenticated;
revoke all on function private.site_block(uuid, text) from public, anon, authenticated;
revoke all on function private.check_site_fields(jsonb) from public, anon, authenticated;
grant execute on function private.site_host(uuid, text) to service_role;
grant execute on function private.site_block(uuid, text) to service_role;
grant execute on function private.check_site_fields(jsonb) to service_role;

-- ---------------------------------------------------------------------
--  1. Edit a site
--
--  Each key present in p_details is written; a key left out is left as it
--  is. lat and lng travel together, and null clears the position. host is
--  host_id, or new_host_name for a host not yet on the books; block is
--  block_id, or new_block_name.
-- ---------------------------------------------------------------------
create or replace function public.save_site_details(p_property_id uuid, p_details jsonb)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  d jsonb := coalesce(p_details, '{}'::jsonb);
  v_site property%rowtype;
  v_block uuid;
  v_active boolean;
  v_leaving boolean;
  v_others integer;
  v_removed integer := 0;
  v_repriced integer := 0;
  r record;
begin
  select * into v_site from property where id = p_property_id for update;
  if not found then
    raise exception 'NO_SUCH_SITE: that site does not exist' using errcode = 'check_violation';
  end if;

  perform private.check_site_fields(d);

  v_block := case when d ? 'block_id' or d ? 'new_block_name'
                  then private.site_block(nullif(d->>'block_id', '')::uuid, d->>'new_block_name')
                  else v_site.block_id end;
  v_active := case when d ? 'active' then (d->>'active')::boolean else v_site.active end;
  v_leaving := (v_block is distinct from v_site.block_id) or (v_site.active and not v_active);

  if v_leaving then
    -- 86 Paice Ave is what every price is measured from. It does not move.
    if p_property_id = reference_property() then
      raise exception 'REFERENCE_SITE: the reference site cannot be moved or switched off'
        using errcode = 'check_violation';
    end if;
    if private.site_booked_ahead(p_property_id) then
      raise exception 'SITE_HAS_BOOKINGS: people are booked here on a night still to come'
        using errcode = 'check_violation';
    end if;
    -- An anchor leaving a block that still has other active sites would
    -- leave the block pointing at a site that is not in it.
    if exists (select 1 from block where id = v_site.block_id
                                     and anchor_property_id = p_property_id) then
      select count(*) into v_others from property
       where block_id = v_site.block_id and active and id <> p_property_id;
      if v_others > 0 then
        raise exception 'SITE_IS_ANCHOR: make another site the anchor of this area first'
          using errcode = 'check_violation';
      end if;
      update block set anchor_property_id = null where id = v_site.block_id;
    end if;
  end if;

  update property set
    name           = case when d ? 'name' then trim(d->>'name') else name end,
    address        = case when d ? 'address' then trim(d->>'address') else address end,
    host_id        = case when d ? 'host_id' or d ? 'new_host_name'
                          then private.site_host(nullif(d->>'host_id', '')::uuid, d->>'new_host_name')
                          else host_id end,
    block_id       = v_block,
    lat            = case when d ? 'lat' then (d->>'lat')::numeric else lat end,
    lng            = case when d ? 'lng' then (d->>'lng')::numeric else lng end,
    walk_minutes   = case when d ? 'walk_minutes' then (d->>'walk_minutes')::integer else walk_minutes end,
    site_guide_url = case when d ? 'site_guide_url'
                          then nullif(trim(coalesce(d->>'site_guide_url', '')), '') else site_guide_url end,
    fill_notes     = case when d ? 'fill_notes'
                          then nullif(trim(coalesce(d->>'fill_notes', '')), '') else fill_notes end,
    active         = v_active
  where id = p_property_id;

  -- A site arriving in (or coming back to) a block with no anchor is it.
  if v_active and v_block is not null then
    update block set anchor_property_id = p_property_id
     where id = v_block and anchor_property_id is null;
  end if;

  -- Switched off: it comes off every night still to come. The guard above
  -- means nobody is booked on any of them.
  if v_site.active and not v_active then
    delete from event_offer o
     using event e
     where o.event_id = e.id and o.property_id = p_property_id
       and private.night_is_upcoming(e.id);
    get diagnostics v_removed = row_count;
  end if;

  -- Moved block: its price is its new block's from here on.
  if v_active and v_block is distinct from v_site.block_id then
    for r in
      select distinct o.event_id from event_offer o
       where o.property_id = p_property_id and private.night_is_upcoming(o.event_id)
    loop
      perform apply_price_offsets(r.event_id);
      v_repriced := v_repriced + 1;
    end loop;
  end if;

  return jsonb_build_object('nights_removed', v_removed, 'events_repriced', v_repriced);
end;
$function$;

-- ---------------------------------------------------------------------
--  2. A new site
-- ---------------------------------------------------------------------
create or replace function public.add_site(p_details jsonb)
 returns uuid
 language plpgsql
 set search_path to 'public'
as $function$
declare
  d jsonb := coalesce(p_details, '{}'::jsonb);
  v_block uuid;
  v_host uuid;
  v_property uuid;
begin
  if coalesce(trim(d->>'name'), '') = '' or coalesce(trim(d->>'address'), '') = '' then
    raise exception 'SITE_DETAILS_REQUIRED: a name and an address are needed'
      using errcode = 'check_violation';
  end if;
  perform private.check_site_fields(d);

  v_block := private.site_block(nullif(d->>'block_id', '')::uuid, d->>'new_block_name');
  v_host := private.site_host(nullif(d->>'host_id', '')::uuid, d->>'new_host_name');

  insert into property (host_id, name, address, active, block_id, lat, lng,
                        walk_minutes, site_guide_url, fill_notes)
  values (v_host, trim(d->>'name'), trim(d->>'address'), true, v_block,
          (d->>'lat')::numeric, (d->>'lng')::numeric,
          (d->>'walk_minutes')::integer,
          nullif(trim(coalesce(d->>'site_guide_url', '')), ''),
          nullif(trim(coalesce(d->>'fill_notes', '')), ''))
  returning id into v_property;

  -- Zero of everything until its numbers are set: a site nobody has
  -- counted has no spaces, never an assumed few.
  insert into property_tier_default (property_id, code, capacity, online)
  select v_property, c.code, 0, 0
    from (values ('standard'), ('priority'), ('valet')) as c(code)
  on conflict do nothing;

  -- The first site in an area is its anchor.
  update block set anchor_property_id = v_property
   where id = v_block and anchor_property_id is null;

  return v_property;
end;
$function$;

-- ---------------------------------------------------------------------
--  3. A block's anchor: always one of its own active sites
-- ---------------------------------------------------------------------
create or replace function public.set_block_anchor(p_block_id uuid, p_property_id uuid)
 returns void
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if not exists (select 1 from property
                  where id = p_property_id and block_id = p_block_id and active) then
    raise exception 'ANCHOR_NOT_IN_AREA: the anchor must be an active site in that area'
      using errcode = 'check_violation';
  end if;
  update block set anchor_property_id = p_property_id where id = p_block_id;
end;
$function$;

-- ---------------------------------------------------------------------
--  4. Which nights a site sells
--
--  Adding goes through add_event_offer(): pending, at the site's
--  defaults, priced from its block. Going on sale online is still the
--  separate, deliberate tap (set_offer_status). Taking a site off a night
--  is refused while anyone is booked there, and the reference site stays
--  on every night it is in, because the night's prices are measured from
--  it.
-- ---------------------------------------------------------------------
create or replace function public.set_site_nights(
  p_property_id uuid, p_add uuid[] default '{}', p_remove uuid[] default '{}')
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_event uuid;
  v_added integer := 0;
  v_removed integer := 0;
begin
  if not exists (select 1 from property where id = p_property_id) then
    raise exception 'NO_SUCH_SITE: that site does not exist' using errcode = 'check_violation';
  end if;

  foreach v_event in array coalesce(p_remove, '{}') loop
    if not exists (select 1 from event_offer where event_id = v_event and property_id = p_property_id) then
      continue;
    end if;
    if not private.night_is_upcoming(v_event) then
      raise exception 'NOT_UPCOMING: that night is over or called off' using errcode = 'check_violation';
    end if;
    if p_property_id = reference_property() then
      raise exception 'REFERENCE_SITE: the reference site stays on every night it is in'
        using errcode = 'check_violation';
    end if;
    if private.site_booked_ahead(p_property_id, v_event) then
      raise exception 'SITE_HAS_BOOKINGS: people are booked here on that night'
        using errcode = 'check_violation';
    end if;
    delete from event_offer where event_id = v_event and property_id = p_property_id;
    v_removed := v_removed + 1;
  end loop;

  foreach v_event in array coalesce(p_add, '{}') loop
    if exists (select 1 from event_offer where event_id = v_event and property_id = p_property_id) then
      continue;
    end if;
    if not private.night_is_upcoming(v_event) then
      raise exception 'NOT_UPCOMING: that night is over or called off' using errcode = 'check_violation';
    end if;
    perform add_event_offer(v_event, p_property_id);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'removed', v_removed);
end;
$function$;

-- ---------------------------------------------------------------------
--  5. One night's numbers at one site
--
--  p_tiers: [{code, capacity, online}]. Online is how many the website may
--  sell; the rest are held for the gate. A count below what is already
--  sold is refused by name rather than quietly raised: the screen shows
--  the sold figure, and a number that silently changes is worse than one
--  that says no.
-- ---------------------------------------------------------------------
create or replace function public.set_site_night(
  p_event_id uuid, p_property_id uuid, p_tiers jsonb)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_item jsonb;
  v_tier offer_tier%rowtype;
  v_cap integer;
  v_online integer;
  v_sold integer;
  v_n integer := 0;
begin
  if not exists (select 1 from event_offer where event_id = p_event_id and property_id = p_property_id) then
    raise exception 'NOT_IN_NIGHT: that site is not part of that night' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_tiers, '[]'::jsonb)) loop
    if coalesce(v_item->>'capacity', '') !~ '^\d{1,4}$' or coalesce(v_item->>'online', '') !~ '^\d{1,4}$' then
      raise exception 'BAD_COUNT: counts are whole numbers, none below zero' using errcode = 'check_violation';
    end if;
    v_cap := (v_item->>'capacity')::integer;
    v_online := (v_item->>'online')::integer;
    if v_online > v_cap then
      raise exception 'BAD_COUNT: online cannot be more than the spaces' using errcode = 'check_violation';
    end if;

    select t.* into v_tier
      from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and o.property_id = p_property_id and t.code = v_item->>'code'
       for update of t;
    if not found then
      raise exception 'NO_SUCH_TIER: that night does not sell "%" here', v_item->>'code'
        using errcode = 'check_violation';
    end if;

    v_sold := private.tier_sold(p_event_id, p_property_id, v_tier.code);
    if v_cap < v_sold then
      raise exception 'BELOW_SOLD: % % already sold for that night', v_sold, v_tier.code
        using errcode = 'check_violation';
    end if;

    update offer_tier set capacity = v_cap, gate_reserve = v_cap - v_online
     where id = v_tier.id;
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('tiers_updated', v_n);
end;
$function$;

revoke all on function public.save_site_details(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.add_site(jsonb) from public, anon, authenticated;
revoke all on function public.set_block_anchor(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_site_nights(uuid, uuid[], uuid[]) from public, anon, authenticated;
revoke all on function public.set_site_night(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_site_details(uuid, jsonb) to service_role;
grant execute on function public.add_site(jsonb) to service_role;
grant execute on function public.set_block_anchor(uuid, uuid) to service_role;
grant execute on function public.set_site_nights(uuid, uuid[], uuid[]) to service_role;
grant execute on function public.set_site_night(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------
--  6. A new night includes every active site at its defaults
--
--  Restated from 20260918150000_talli_tiers_are_counts (the newest
--  definition; 20261113100000 added a series trigger and did not restate
--  it). Two changes, both marked B3 below.
-- ---------------------------------------------------------------------
create or replace function create_gate_event(
  p_name text, p_starts_at_local text, p_venue text default 'Eden Park',
  p_status text default 'draft', p_demand_tier text default 'standard',
  p_property_id uuid default null, p_gates_open_minutes integer default -150,
  p_expected_end_minutes integer default 150, p_online_close_minutes integer default -45,
  p_tiers jsonb default null, p_timezone text default 'Pacific/Auckland'
) returns uuid
language plpgsql set search_path = public as $$
declare
  v_name     text;
  v_venue    text;
  v_tz       text;
  v_starts   timestamptz;
  v_property uuid;
  v_tiers    jsonb;
  v_item     jsonb;
  v_event    uuid;
  v_offer    uuid;
  v_zones    text[];
  v_other    uuid;
begin
  v_name := nullif(trim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'NO_NAME: the event needs a name'
      using errcode = 'check_violation';
  end if;
  if length(v_name) > 120 then
    raise exception 'LONG_NAME: that name is too long for the booking page'
      using errcode = 'check_violation';
  end if;

  v_venue := coalesce(nullif(trim(coalesce(p_venue, '')), ''), 'Eden Park');

  if coalesce(p_status, 'draft') not in
     ('draft','announced','on_sale','closed','cancelled') then
    raise exception 'BAD_STATUS: % is not an event status', p_status
      using errcode = 'check_violation';
  end if;
  if coalesce(p_demand_tier, 'standard') not in ('low','standard','high','premium') then
    raise exception 'BAD_DEMAND: % is not a demand tier', p_demand_tier
      using errcode = 'check_violation';
  end if;

  if coalesce(p_starts_at_local, '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$' then
    raise exception 'BAD_DATE: kickoff must be a date and a time'
      using errcode = 'check_violation';
  end if;
  v_tz := coalesce(nullif(trim(coalesce(p_timezone, '')), ''), 'Pacific/Auckland');
  begin
    v_starts := (replace(p_starts_at_local, 'T', ' ')::timestamp) at time zone v_tz;
  exception when others then
    raise exception 'BAD_DATE: could not read that kickoff time in %', v_tz
      using errcode = 'check_violation';
  end;

  -- B3: the reference site, which every other price is measured from.
  v_property := coalesce(p_property_id, reference_property());
  if v_property is null then
    raise exception 'NO_PROPERTY: there is no active property to sell spaces at'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from property where id = v_property and active) then
    raise exception 'NO_PROPERTY: that property is not active'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from event e
     where lower(e.name) = lower(v_name)
       and e.starts_at = v_starts
       and e.status <> 'cancelled'
  ) then
    raise exception 'DUPLICATE_EVENT: that event already exists'
      using errcode = 'unique_violation';
  end if;

  v_tiers := normalise_event_tiers(coalesce(p_tiers, '[]'::jsonb));

  insert into event (name, venue, starts_at, gates_open_at, expected_end_at,
                     online_sales_close_at, demand_tier, status)
  values (
    v_name, v_venue, v_starts,
    v_starts + make_interval(mins => coalesce(p_gates_open_minutes, -150)),
    v_starts + make_interval(mins => coalesce(p_expected_end_minutes, 150)),
    case when p_online_close_minutes is null then null
         else v_starts + make_interval(mins => p_online_close_minutes) end,
    coalesce(p_demand_tier, 'standard'),
    coalesce(p_status, 'draft')
  )
  returning id into v_event;

  insert into event_offer (event_id, property_id)
  values (v_event, v_property)
  returning id into v_offer;

  for v_item in select * from jsonb_array_elements(v_tiers) loop
    v_zones := case
                 when v_item -> 'zone_codes' is null
                   or jsonb_typeof(v_item -> 'zone_codes') = 'null' then null
                 else array(select jsonb_array_elements_text(v_item -> 'zone_codes'))
               end;

    insert into offer_tier (
      event_offer_id, code, label, price_cents, zone_codes, bay_kind,
      guarantees_clear_exit, arrival_from, arrival_until, departure_by,
      sort_order, active, capacity, gate_reserve
    ) values (
      v_offer,
      v_item ->> 'code',
      v_item ->> 'label',
      (v_item ->> 'price_cents')::integer,
      v_zones,
      v_item ->> 'bay_kind',
      (v_item ->> 'guarantees_clear_exit')::boolean,
      v_starts + make_interval(mins => (v_item ->> 'arrival_from_minutes')::integer),
      v_starts + make_interval(mins => (v_item ->> 'arrival_until_minutes')::integer),
      (select case when d.m is null then null
                   else v_starts + make_interval(mins => d.m) end
         from (select coalesce(
                 (v_item ->> 'departure_by_minutes')::integer,
                 default_departure_minutes(v_item ->> 'code',
                                           coalesce(p_expected_end_minutes, 150))
               ) as m) d),
      (v_item ->> 'sort_order')::integer,
      true,
      (v_item ->> 'capacity')::integer,
      (v_item ->> 'gate_reserve')::integer
    );
  end loop;

  -- B3: every other active site joins the night, pending, at its own
  -- defaults and its block's prices. Selling online at each is still the
  -- deliberate tap on the Sites page.
  for v_other in
    select p.id from property p
     where p.active and p.id <> v_property
     order by p.created_at
  loop
    perform add_event_offer(v_event, v_other);
  end loop;

  return v_event;
end;
$$;
