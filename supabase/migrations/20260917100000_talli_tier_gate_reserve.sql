-- =====================================================================
--  Talli Parking — the walk-up reserve, per tier and per night
--
--  There has always been a reserve: bays online may not sell down into,
--  so the marshal still has stock in hand when someone drives up with
--  cash (20260814121108). It lived on `zone`, which made it a property
--  setting — one number for 86 Paice Ave, for every event it will ever
--  hold. Two things follow from that, and both are wrong:
--
--    * It cannot be tuned for a night. Standard nearly sold out for the
--      Warriors game is a reason to release two held spaces online for
--      the Warriors game, not to lower the reserve for every fixture
--      after it.
--    * It is not the unit anyone thinks in. The reserve is per zone;
--      what is nearly sold out is Standard. They line up today by
--      accident — Standard is the back yard — and would stop lining up
--      the moment a tier spanned two zones or two tiers shared one.
--
--  So the live reserve moves to offer_tier, which is already per event
--  and already where price and "call it sold out" live. Same screen,
--  same card, same round trip.
--
--    zone.gate_reserve        the house default, used when a night is
--                             created and never read again after that
--    offer_tier.gate_reserve  tonight's actual hold, editable at the gate
--
--  Nothing changes on day one: every tier on every event that already
--  exists is backfilled with the hold it has right now.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. The column.
--
--  Capped rather than unbounded. A reserve larger than the yard is not
--  a reserve, it is "take it off sale", and there is already a button
--  for that which says so in words.
-- ---------------------------------------------------------------------
alter table offer_tier
  add column if not exists gate_reserve integer not null default 0;

alter table offer_tier
  drop constraint if exists offer_tier_gate_reserve_check;
alter table offer_tier
  add constraint offer_tier_gate_reserve_check
  check (gate_reserve >= 0 and gate_reserve <= 200);

comment on column offer_tier.gate_reserve is
  'Spaces of this tier held back from online sale for walk-ups, this event only. '
  'Seeded from zone.gate_reserve when the event is created, then set at the gate.';

comment on column zone.gate_reserve is
  'The house default walk-up reserve for this zone. Read when an event is '
  'created, to seed offer_tier.gate_reserve. What actually holds a space back '
  'on the night is that per-event number, not this one.';

-- ---------------------------------------------------------------------
--  2. Backfill, so the change is invisible until somebody uses it.
--
--  The old sum: for each zone the tier can sell from, hold back that
--  zone's reserve. Add them up and that is the tier's hold. Only zones
--  that online can reach count — a reserve on a zone online could never
--  sell from was never holding anything back from it.
--
--  As the data stands this puts 2 on Standard and 0 on everything else,
--  which is exactly what the old view was doing.
-- ---------------------------------------------------------------------
update offer_tier t set gate_reserve = least(200, coalesce((
  select sum(z.gate_reserve)
    from event_offer o
    join zone z on z.property_id = o.property_id and z.active
   where o.id = t.event_offer_id
     and z.reservable_in_advance
     and (t.zone_codes is null or z.code = any (t.zone_codes))
), 0));

-- ---------------------------------------------------------------------
--  3. Availability reads the tier's own reserve.
--
--  spots_left is what the booking page may sell and what the gate screen
--  labels "online". spots_left_gate is the physical truth and ignores the
--  reserve entirely — that is the whole point of holding one.
--
--  The online count is now one flat count of matching bays minus the
--  hold, rather than a per-zone subtraction summed up. Same number for
--  every tier that exists, and a straight answer to the question the
--  gate screen asks: how many of these may I still sell online.
--
--  NB: create or replace view resets reloptions, so security_invoker is
--  re-asserted below. New columns may only be appended; gate_reserve
--  goes last for that reason.
-- ---------------------------------------------------------------------
create or replace view v_tier_availability as
select
  t.id as offer_tier_id,
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
     when t.manually_sold_out then 0
     when e.online_sales_close_at is not null and now() > e.online_sales_close_at then 0
     else greatest(0, (
       select count(*)
         from v_bay_inventory i
        where i.event_id = eo.event_id and i.property_id = eo.property_id
          and i.available
          and i.reservable_in_advance
          and (t.zone_codes is null or i.zone_code = any (t.zone_codes))
          and case t.bay_kind
                when 'free_exit'      then i.blocker_bay_id is null
                when 'may_be_blocked' then i.blocker_bay_id is not null
                else true
              end
          and (t.departure_by is not null or not i.requires_early_departure)
          and (not t.guarantees_clear_exit or i.blocker_bay_id is null
               or not exists (select 1 from bay_allocation a2
                               where a2.event_id = i.event_id
                                 and a2.bay_id = i.blocker_bay_id))
     ) - t.gate_reserve)
   end)::integer as spots_left,
  (case when t.manually_sold_out then 0 else (
     select count(*)
       from v_bay_inventory i
      where i.event_id = eo.event_id and i.property_id = eo.property_id
        and i.available
        and (t.zone_codes is null or i.zone_code = any (t.zone_codes))
        and case t.bay_kind
              when 'free_exit'      then i.blocker_bay_id is null
              when 'may_be_blocked' then i.blocker_bay_id is not null
              else true
            end
        and (t.departure_by is not null or not i.requires_early_departure)
        and (not t.guarantees_clear_exit or i.blocker_bay_id is null
             or not exists (select 1 from bay_allocation a2
                             where a2.event_id = i.event_id
                               and a2.bay_id = i.blocker_bay_id)))
   end)::integer as spots_left_gate,
  t.manually_sold_out,
  t.price_updated_at,
  t.gate_reserve
from offer_tier t
join event_offer eo on eo.id = t.event_offer_id
join event e on e.id = eo.event_id
where t.active;

alter view v_tier_availability set (security_invoker = true);

-- ---------------------------------------------------------------------
--  4. Set the reserve. One round trip from a phone, like the price.
--
--  Not clamped to what is physically there. Holding back more spaces
--  than the tier has left is a legitimate thing to type at 6:30pm — it
--  means "stop selling this online, I will decide at the window" — and
--  spots_left floors at zero either way.
-- ---------------------------------------------------------------------
create or replace function set_tier_reserve(
  p_event_id    uuid,
  p_property_id uuid,
  p_tier_code   text,
  p_reserve     integer
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if p_reserve is null or p_reserve < 0 or p_reserve > 200 then
    raise exception 'BAD_RESERVE: hold back between 0 and 200 spaces'
      using errcode = 'check_violation';
  end if;

  select t.id into v_id
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  update offer_tier set gate_reserve = p_reserve where id = v_id;

  return p_reserve;
end;
$function$;

-- ---------------------------------------------------------------------
--  5. The allocator honours the same number.
--
--  The old test was per bay and per zone, and ran inside the loop that
--  picks one: count the matching bays in this bay's zone, and refuse if
--  that count is down to the zone's reserve. Now the question is asked
--  once, before anything is written, against the same predicate the view
--  counts with — so "3 online" on the gate screen means exactly three
--  more online sales, and the fourth is told the reserve is holding it.
--
--  Everything else about the allocation is unchanged.
-- ---------------------------------------------------------------------
create or replace function hold_booking(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_email text,
  p_name text default null, p_phone text default null, p_rego text default null,
  p_hold_minutes integer default 30, p_channel text default 'online',
  p_accepts_street boolean default false, p_payment_method text default 'stripe',
  p_low_clearance boolean default false
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_tier offer_tier%rowtype; v_close timestamptz; v_share numeric(5,4);
  v_platform int; v_booking_id uuid; v_bay record; v_got_bay boolean := false;
  v_sellable_online bigint;
begin
  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;
  if not found then
    raise exception 'No active tier "%" for that event and property', p_tier_code;
  end if;

  -- Called gone at the gate, by eye, before the bay count agrees. That call
  -- wins: it is usually made because the yard is physically fuller than the
  -- plan thinks.
  if v_tier.manually_sold_out then
    raise exception 'SOLD_OUT: tier "%" has been marked sold out for this event', p_tier_code
      using errcode = 'check_violation';
  end if;

  if p_channel = 'online' then
    select e.online_sales_close_at into v_close from event e where e.id = p_event_id;
    if v_close is not null and now() > v_close then
      raise exception 'ONLINE_SALES_CLOSED: online sales for this event closed at %', v_close
        using errcode = 'check_violation';
    end if;
  end if;

  -- The walk-up reserve. The marshal standing at the window is the reason
  -- it exists, so the gate itself is never held back by it.
  if p_channel <> 'gate' and v_tier.gate_reserve > 0 then
    select count(*) into v_sellable_online
      from v_bay_inventory i
     where i.event_id = p_event_id and i.property_id = p_property_id
       and i.available
       and i.reservable_in_advance
       and (v_tier.zone_codes is null or i.zone_code = any (v_tier.zone_codes))
       and case v_tier.bay_kind
             when 'free_exit'      then i.blocker_bay_id is null
             when 'may_be_blocked' then i.blocker_bay_id is not null
             else true
           end
       and (v_tier.departure_by is not null or not i.requires_early_departure)
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                            where a2.event_id = p_event_id
                              and a2.bay_id = i.blocker_bay_id));

    if v_sellable_online <= v_tier.gate_reserve then
      raise exception
        'HELD_FOR_GATE: the last % space(s) of tier "%" are held for walk-ups',
        v_tier.gate_reserve, p_tier_code
        using errcode = 'check_violation';
    end if;
  end if;

  select h.platform_share into v_share
    from property pr join host h on h.id = pr.host_id where pr.id = p_property_id;
  v_platform := round(v_tier.price_cents * v_share);

  insert into booking (
    event_id, property_id, tier_code, customer_email, customer_name,
    customer_phone, vehicle_rego, vehicle_low_clearance, amount_cents,
    arrival_from, arrival_until, must_depart_by,
    platform_fee_cents, host_earnings_cents,
    channel, payment_method, accepts_street_parking, status, hold_expires_at
  ) values (
    p_event_id, p_property_id, v_tier.code, p_email, p_name,
    p_phone, p_rego, coalesce(p_low_clearance, false), v_tier.price_cents,
    v_tier.arrival_from, v_tier.arrival_until, v_tier.departure_by,
    v_platform, v_tier.price_cents - v_platform,
    p_channel, p_payment_method, p_accepts_street, 'held',
    now() + make_interval(mins => p_hold_minutes)
  ) returning id into v_booking_id;

  for v_bay in
    select i.bay_id, i.blocker_bay_id
      from v_bay_inventory i
     where i.event_id = p_event_id and i.property_id = p_property_id and i.available
       and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
       and (p_channel = 'gate' or i.reservable_in_advance)
       and (not i.requires_consent or p_accepts_street)
       and (v_tier.departure_by is not null or not i.requires_early_departure)
       and case v_tier.bay_kind
             when 'free_exit'      then i.blocker_bay_id is null
             when 'may_be_blocked' then i.blocker_bay_id is not null
             else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       case when i.reservable_in_advance then 1 else 0 end,
       case when v_tier.guarantees_clear_exit and i.blocker_bay_id is null then 0 else 1 end,
       -- A spare only opened because the yard was tight is the last thing to
       -- hand out; keep it for the car that would otherwise be turned away.
       case when i.is_flex then 1 else 0 end,
       i.exit_rank, i.bay_label
  loop
    begin
      insert into bay_allocation (event_id, bay_id, booking_id, role)
      values (p_event_id, v_bay.bay_id, v_booking_id, 'occupied');
      if v_tier.guarantees_clear_exit and v_bay.blocker_bay_id is not null then
        insert into bay_allocation (event_id, bay_id, booking_id, role)
        values (p_event_id, v_bay.blocker_bay_id, v_booking_id, 'blocked_reserve');
      end if;
      v_got_bay := true;
      exit;
    exception when unique_violation then continue;
    end;
  end loop;

  if not v_got_bay then
    if not p_accepts_street and exists (
         select 1 from v_bay_inventory i
          where i.event_id = p_event_id and i.property_id = p_property_id
            and i.available and i.requires_consent
            and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
            and (p_channel = 'gate' or i.reservable_in_advance)
            and (v_tier.departure_by is not null or not i.requires_early_departure)
            and case v_tier.bay_kind
                  when 'free_exit'      then i.blocker_bay_id is null
                  when 'may_be_blocked' then i.blocker_bay_id is not null
                  else true end)
    then
      raise exception 'CONSENT_REQUIRED: space is available for tier "%", but only in a zone the customer must opt into first', p_tier_code
        using errcode = 'check_violation';
    end if;

    raise exception 'SOLD_OUT: no bay available for tier "%" at that property', p_tier_code
      using errcode = 'check_violation';
  end if;

  return v_booking_id;
end;
$function$;

-- ---------------------------------------------------------------------
--  6. A night made from here starts with a reserve.
--
--  normalise_event_tiers carries an optional gate_reserve through, so a
--  template can say "big game: hold four Standard back". Left out, it
--  stays null and create_gate_event falls back to the zone defaults —
--  the same sum the backfill above used, so a new event and an old one
--  start the night holding back the same spaces.
-- ---------------------------------------------------------------------
create or replace function normalise_event_tiers(p_tiers jsonb)
returns jsonb
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_item    jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_codes   text[] := array[]::text[];
  v_code    text;
  v_label   text;
  v_price   integer;
  v_from    integer;
  v_until   integer;
  v_depart  integer;
  v_kind    text;
  v_zones   jsonb;
  v_reserve integer;
  v_n       integer := 0;
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
    -- Valet and priority are parked for you at the front, so they can take
    -- a car at kickoff. Standard is double-parked in the back yard and has
    -- to close while there is still someone to build the stack.
    v_until  := coalesce(
                  (v_item ->> 'arrival_until_minutes')::integer,
                  case v_code
                    when 'valet'    then 0
                    when 'priority' then 0
                    when 'standard' then -30
                    else -10
                  end);
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

    -- Null, not 0: "nobody said" and "hold nothing back" are different
    -- answers, and only the first one should pick up the zone default.
    v_reserve := (v_item ->> 'gate_reserve')::integer;
    if v_reserve is not null and (v_reserve < 0 or v_reserve > 200) then
      raise exception 'BAD_RESERVE: % must hold back between 0 and 200 spaces', v_code
        using errcode = 'check_violation';
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
      'gate_reserve', v_reserve,
      'sort_order', coalesce((v_item ->> 'sort_order')::integer, v_n)
    );
  end loop;

  return v_out;
end;
$function$;

-- ---------------------------------------------------------------------
--  7. Creating a night seeds the reserve.
--
--  Identical to the function it replaces but for the two gate_reserve
--  lines in the insert: whatever the template asked for, and failing
--  that the sum of the zone defaults the tier can sell from — the same
--  expression the backfill in step 2 used, so a night made tonight and
--  a night made last month start out holding back the same spaces.
-- ---------------------------------------------------------------------
create or replace function create_gate_event(
  p_name                text,
  p_starts_at_local     text,
  p_venue               text default 'Eden Park',
  p_status              text default 'draft',
  p_demand_tier         text default 'standard',
  p_property_id         uuid default null,
  p_gates_open_minutes  integer default -150,
  p_expected_end_minutes integer default 150,
  p_online_close_minutes integer default -45,
  p_tiers               jsonb default null,
  p_timezone            text default 'Pacific/Auckland'
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
      sort_order, active, gate_reserve
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
      true,
      least(200, coalesce(
        (v_item ->> 'gate_reserve')::integer,
        (select sum(z.gate_reserve)
           from zone z
          where z.property_id = v_property and z.active
            and z.reservable_in_advance
            and (v_zones is null or z.code = any (v_zones))),
        0))
    );
  end loop;

  return v_event;
end;
$function$;
