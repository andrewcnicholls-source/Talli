-- =====================================================================
--  Talli Parking — making a new event from the gate screen
--
--  Up to now an event only existed because a migration wrote one. That is
--  fine for a seeded fixture list and useless the week Eden Park announces
--  a game nobody planned for: the person who needs the event is standing in
--  a driveway with a phone, not opening a SQL editor.
--
--  So three things land here.
--
--  1. event_template — the shape of a night, kept so it never has to be
--     retyped. A template is not an event: it carries no date. It carries
--     the venue, the demand tier, the tier menu with its prices, and the
--     timings AS OFFSETS from kickoff, because "gates open two and a half
--     hours before" is the thing that is actually true every time.
--
--  2. create_gate_event() — one call that writes the event, its offer
--     against a property, and its tiers. Everything the booking page and
--     the gate screen need, or nothing: it is one transaction, so a
--     half-made event with no tiers cannot exist.
--
--  3. set_event_status() — draft, announced, on sale, closed, cancelled,
--     changeable from the phone. The status is what decides whether the
--     public site will sell the night at all, and it was the one lever
--     with no way to pull it outside the dashboard.
--
--  Prices here are a starting point, never a commitment. Everything a
--  template sets is editable in the modal before the event is written, and
--  everything the event ends up with is still editable on the night
--  through set_tier_price / set_tier_sold_out.
-- =====================================================================

-- ---------------------------------------------------------------------
--  The shape of a night, minus the date.
-- ---------------------------------------------------------------------
create table if not exists event_template (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  -- What to prefill the event's own name with. Usually blank: "Auckland v
  -- Waikato" is not a property of the template, it is a property of Saturday.
  event_name   text,
  venue        text not null default 'Eden Park',
  demand_tier  text not null default 'standard'
               check (demand_tier in ('low','standard','high','premium')),
  -- What a new event made from this template starts life as. 'draft' by
  -- default: an event goes on sale because someone said so, not because a
  -- template did.
  status       text not null default 'draft'
               check (status in ('draft','announced','on_sale','closed','cancelled')),
  property_id  uuid references property(id) on delete set null,

  -- All relative to kickoff, in minutes. Positive is after.
  gates_open_minutes   integer not null default -150
                       check (gates_open_minutes between -1440 and 1440),
  expected_end_minutes integer not null default 150
                       check (expected_end_minutes between -1440 and 1440),
  -- Null = online sales never close on their own; the gate keeps selling.
  online_close_minutes integer
                       check (online_close_minutes between -1440 and 1440),

  -- [{code,label,price_cents,zone_codes,bay_kind,guarantees_clear_exit,
  --   arrival_from_minutes,arrival_until_minutes,departure_by_minutes,
  --   sort_order}]
  tiers        jsonb not null default '[]'::jsonb,

  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table event_template is
  'The shape of a night without its date. Timings are minutes from kickoff.';
comment on column event_template.tiers is
  'The tier menu as JSON. Same fields as offer_tier, with times as minute offsets from kickoff.';

-- Two templates called the same thing is a typo every time.
create unique index if not exists event_template_name_once
  on event_template (lower(name));

-- Written only by the gate-ops function under the service role. Nothing in
-- here is customer data, but nothing in here is public either: it is the
-- price list for events that have not been announced.
alter table event_template enable row level security;
grant select, insert, update, delete on event_template to service_role;

-- ---------------------------------------------------------------------
--  One validator, used by both the template save and the event create, so
--  a template cannot hold a shape the event create would then refuse.
--
--  Returns the tiers normalised: codes lowercased, defaults filled in,
--  ordered. Raises on anything that would produce a tier nobody could buy.
-- ---------------------------------------------------------------------
create or replace function normalise_event_tiers(p_tiers jsonb)
returns jsonb
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_item  jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_codes text[] := array[]::text[];
  v_code  text;
  v_label text;
  v_price integer;
  v_from  integer;
  v_until integer;
  v_depart integer;
  v_kind  text;
  v_zones jsonb;
  v_n     integer := 0;
begin
  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'BAD_TIERS: the tier list must be an array'
      using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_tiers) = 0 then
    raise exception 'NO_TIERS: an event needs at least one thing to sell'
      using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_tiers) > 12 then
    raise exception 'TOO_MANY_TIERS: twelve options is already more than anyone reads'
      using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_tiers) loop
    v_n := v_n + 1;

    v_code := lower(trim(coalesce(v_item ->> 'code', '')));
    if v_code !~ '^[a-z][a-z0-9_]{0,30}$' then
      raise exception 'BAD_TIER_CODE: "%" is not a usable tier code — letters, digits and underscores', v_code
        using errcode = 'check_violation';
    end if;
    if v_code = any (v_codes) then
      raise exception 'DUPLICATE_TIER: "%" is listed twice', v_code
        using errcode = 'check_violation';
    end if;
    v_codes := v_codes || v_code;

    -- A tier with no label of its own gets a readable one rather than a
    -- code shown to a customer.
    v_label := nullif(trim(coalesce(v_item ->> 'label', '')), '');
    if v_label is null then
      v_label := initcap(replace(v_code, '_', ' '));
    end if;
    if length(v_label) > 160 then
      raise exception 'LONG_LABEL: "%" is too long for the booking page', v_code
        using errcode = 'check_violation';
    end if;

    -- The same bounds set_tier_price enforces on the night. A price typed
    -- on a wet phone is wrong in the same ways whenever it is typed.
    v_price := (v_item ->> 'price_cents')::integer;
    if v_price is null or v_price < 100 or v_price > 50000 then
      raise exception 'BAD_PRICE: % must be priced between $1 and $500', v_code
        using errcode = 'check_violation';
    end if;

    v_from   := coalesce((v_item ->> 'arrival_from_minutes')::integer, -150);
    v_until  := coalesce((v_item ->> 'arrival_until_minutes')::integer, -10);
    v_depart := (v_item ->> 'departure_by_minutes')::integer;
    if v_from < -1440 or v_from > 1440 or v_until < -1440 or v_until > 1440 then
      raise exception 'BAD_WINDOW: % arrives more than a day either side of kickoff', v_code
        using errcode = 'check_violation';
    end if;
    if v_until <= v_from then
      raise exception 'BAD_WINDOW: % closes its arrival window before it opens', v_code
        using errcode = 'check_violation';
    end if;

    v_kind := lower(trim(coalesce(v_item ->> 'bay_kind', 'any')));
    if v_kind not in ('free_exit', 'may_be_blocked', 'any') then
      raise exception 'BAD_BAY_KIND: % must be free_exit, may_be_blocked or any', v_code
        using errcode = 'check_violation';
    end if;

    -- Null zone list = fulfil from anywhere on the property. An empty list
    -- would mean "nowhere", which is never what anyone meant.
    v_zones := v_item -> 'zone_codes';
    if v_zones is null or jsonb_typeof(v_zones) <> 'array' or jsonb_array_length(v_zones) = 0 then
      v_zones := case v_code
                   when 'valet'    then '["valet"]'::jsonb
                   when 'priority' then '["front_lawn","berm"]'::jsonb
                   when 'standard' then '["back_yard"]'::jsonb
                   else null
                 end;
    end if;

    v_out := v_out || jsonb_build_object(
      'code', v_code,
      'label', v_label,
      'price_cents', v_price,
      'zone_codes', v_zones,
      'bay_kind', v_kind,
      'guarantees_clear_exit', coalesce((v_item ->> 'guarantees_clear_exit')::boolean, false),
      'arrival_from_minutes', v_from,
      'arrival_until_minutes', v_until,
      'departure_by_minutes', v_depart,
      'sort_order', coalesce((v_item ->> 'sort_order')::integer, v_n)
    );
  end loop;

  return v_out;
end;
$function$;

-- ---------------------------------------------------------------------
--  Where a new event is sold from, when nobody said.
--
--  86 Paice Ave, in practice: the active property with the most zones you
--  can actually promise in advance. The neighbour's berm has none, so it
--  can never win this by accident.
-- ---------------------------------------------------------------------
create or replace function default_event_property()
returns uuid
language sql
stable
set search_path to 'public'
as $function$
  select p.id
    from property p
    left join zone z on z.property_id = p.id and z.active
   where p.active
   group by p.id, p.name
   order by count(z.id) filter (where z.reservable_in_advance) desc,
            count(z.id) desc,
            p.name
   limit 1;
$function$;

-- ---------------------------------------------------------------------
--  Make the night.
--
--  The date arrives as the wall-clock time someone typed plus the zone it
--  was typed in, never as an instant. A phone in another timezone — a
--  staging session, someone away for the weekend — must not silently book
--  a 7:05pm kickoff for 7:05pm somewhere else.
-- ---------------------------------------------------------------------
create or replace function create_gate_event(
  p_name                 text,
  p_starts_at_local      text,
  p_venue                text default 'Eden Park',
  p_status               text default 'draft',
  p_demand_tier          text default 'standard',
  p_property_id          uuid default null,
  p_gates_open_minutes   integer default -150,
  p_expected_end_minutes integer default 150,
  p_online_close_minutes integer default -45,
  p_tiers                jsonb default null,
  p_timezone             text default 'Pacific/Auckland'
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
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

  -- "2026-09-12T19:05" or "2026-09-12 19:05:00", read in the zone it was
  -- typed in. Anything else is a bug in the caller, not a date.
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

  v_property := coalesce(p_property_id, default_event_property());
  if v_property is null then
    raise exception 'NO_PROPERTY: there is no active property to sell spaces at'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from property where id = v_property and active) then
    raise exception 'NO_PROPERTY: that property is not active'
      using errcode = 'check_violation';
  end if;

  -- Same night, same name, twice is a double-tap on a slow connection, not
  -- two events. Refuse rather than leave a duplicate to be found later.
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
      sort_order, active
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
      case when v_item ->> 'departure_by_minutes' is null then null
           else v_starts + make_interval(mins => (v_item ->> 'departure_by_minutes')::integer) end,
      (v_item ->> 'sort_order')::integer,
      true
    );
  end loop;

  return v_event;
end;
$function$;

-- ---------------------------------------------------------------------
--  Keep the shape, drop the date.
--
--  Passing p_id updates that template; leaving it null makes a new one, or
--  overwrites the one already using that name — saving "NPC night" twice
--  means the second one, not two of them.
-- ---------------------------------------------------------------------
create or replace function save_event_template(
  p_name                 text,
  p_id                   uuid default null,
  p_event_name           text default null,
  p_venue                text default 'Eden Park',
  p_status               text default 'draft',
  p_demand_tier          text default 'standard',
  p_property_id          uuid default null,
  p_gates_open_minutes   integer default -150,
  p_expected_end_minutes integer default 150,
  p_online_close_minutes integer default -45,
  p_tiers                jsonb default null
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_name  text;
  v_tiers jsonb;
  v_id    uuid;
begin
  v_name := nullif(trim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'NO_NAME: the template needs a name'
      using errcode = 'check_violation';
  end if;
  if length(v_name) > 80 then
    raise exception 'LONG_NAME: keep the template name short enough to pick from a list'
      using errcode = 'check_violation';
  end if;
  if coalesce(p_status, 'draft') not in
     ('draft','announced','on_sale','closed','cancelled') then
    raise exception 'BAD_STATUS: % is not an event status', p_status
      using errcode = 'check_violation';
  end if;
  if coalesce(p_demand_tier, 'standard') not in ('low','standard','high','premium') then
    raise exception 'BAD_DEMAND: % is not a demand tier', p_demand_tier
      using errcode = 'check_violation';
  end if;

  v_tiers := normalise_event_tiers(coalesce(p_tiers, '[]'::jsonb));

  v_id := coalesce(p_id, (select id from event_template where lower(name) = lower(v_name)));

  if v_id is null then
    insert into event_template (
      name, event_name, venue, demand_tier, status, property_id,
      gates_open_minutes, expected_end_minutes, online_close_minutes, tiers,
      sort_order
    ) values (
      v_name, nullif(trim(coalesce(p_event_name, '')), ''),
      coalesce(nullif(trim(coalesce(p_venue, '')), ''), 'Eden Park'),
      coalesce(p_demand_tier, 'standard'), coalesce(p_status, 'draft'), p_property_id,
      coalesce(p_gates_open_minutes, -150), coalesce(p_expected_end_minutes, 150),
      p_online_close_minutes, v_tiers,
      coalesce((select max(sort_order) + 1 from event_template), 100)
    )
    returning id into v_id;
  else
    update event_template set
      name                 = v_name,
      event_name           = nullif(trim(coalesce(p_event_name, '')), ''),
      venue                = coalesce(nullif(trim(coalesce(p_venue, '')), ''), 'Eden Park'),
      demand_tier          = coalesce(p_demand_tier, 'standard'),
      status               = coalesce(p_status, 'draft'),
      property_id          = p_property_id,
      gates_open_minutes   = coalesce(p_gates_open_minutes, -150),
      expected_end_minutes = coalesce(p_expected_end_minutes, 150),
      online_close_minutes = p_online_close_minutes,
      tiers                = v_tiers,
      active               = true,
      updated_at           = now()
     where id = v_id;

    if not found then
      raise exception 'NO_TEMPLATE: no template with that id'
        using errcode = 'check_violation';
    end if;
  end if;

  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------
--  Draft → announced → on sale → closed, from the phone.
--
--  This is the lever that decides whether the public site sells the night
--  at all, so it says what it did rather than returning a bare true.
-- ---------------------------------------------------------------------
create or replace function set_event_status(
  p_event_id uuid,
  p_status   text
) returns text
language plpgsql
set search_path to 'public'
as $function$
declare v_before text;
begin
  if coalesce(p_status, '') not in
     ('draft','announced','on_sale','closed','cancelled') then
    raise exception 'BAD_STATUS: % is not an event status', p_status
      using errcode = 'check_violation';
  end if;

  select status into v_before from event where id = p_event_id;
  if v_before is null then
    raise exception 'NO_EVENT: no such event'
      using errcode = 'check_violation';
  end if;

  update event set status = p_status where id = p_event_id;
  return p_status;
end;
$function$;

-- ---------------------------------------------------------------------
--  Three templates to start from.
--
--  The tier menu is the one that has actually been running — Standard,
--  Priority exit, Valet — at three price points, because the difference
--  between a Tuesday club game and a Bledisloe is the price and nothing
--  else. Prices are a starting point: the modal edits them before the
--  event exists, and the gate screen edits them on the night.
--
--  Seeded only where a template of that name does not already exist, so
--  re-running this never overwrites a template somebody has since tuned.
-- ---------------------------------------------------------------------
insert into event_template
  (name, venue, demand_tier, status, gates_open_minutes, expected_end_minutes,
   online_close_minutes, sort_order, tiers)
select v.name, 'Eden Park', v.demand_tier, 'draft', -150, 150, -45, v.sort_order,
  jsonb_build_array(
    jsonb_build_object(
      'code', 'valet',
      'label', 'Valet — hand us your keys and we''ll park it for you',
      'price_cents', v.valet,
      'zone_codes', '["valet"]'::jsonb,
      'bay_kind', 'any',
      'guarantees_clear_exit', false,
      'arrival_from_minutes', -150,
      'arrival_until_minutes', -5,
      'departure_by_minutes', null,
      'sort_order', 1),
    jsonb_build_object(
      'code', 'priority',
      'label', 'Priority exit — near the road, nobody parked in behind you',
      'price_cents', v.priority,
      'zone_codes', '["front_lawn","berm"]'::jsonb,
      'bay_kind', 'free_exit',
      'guarantees_clear_exit', false,
      'arrival_from_minutes', -150,
      'arrival_until_minutes', -10,
      'departure_by_minutes', null,
      'sort_order', 2),
    jsonb_build_object(
      'code', 'standard',
      'label', 'Standard — best value, expect to wait for the drive to clear',
      'price_cents', v.standard,
      'zone_codes', '["back_yard"]'::jsonb,
      'bay_kind', 'any',
      'guarantees_clear_exit', false,
      'arrival_from_minutes', -150,
      'arrival_until_minutes', -10,
      'departure_by_minutes', null,
      'sort_order', 3)
  )
from (values
  ('Club rugby night',        'standard', 1000, 1200, 1500, 10),
  ('Big match',               'high',     2000, 2500, 3000, 20),
  ('Test match or concert',   'premium',  3000, 3500, 4000, 30)
) as v(name, demand_tier, standard, priority, valet, sort_order)
where not exists (
  select 1 from event_template t where lower(t.name) = lower(v.name)
);
