-- =====================================================================
--  Talli Parking — Standard is everything that is not Valet and not one
--  of the three bays with a clear run to the street
--
--  Stated plainly by Andrew: all of the back yard is Standard, the valet
--  lane is Valet, three front-lawn bays are Priority, and the rest of
--  the lawn is Standard too.
--
--  The database had not agreed since 20260831100000 took 'near_road' and
--  'quick_getaway' off sale. That migration said out loud what it was
--  costing and then left it costing it:
--
--    * Lawn back row 1-3 — boxed in by the street row, so Priority
--      cannot have them (it promises a free exit) and Standard could not
--      reach them (its zone list was the back yard alone). Three real
--      bays no tier could sell.
--    * Double-park behind Back yard 1-7 — seven positions sellable only
--      with a departure deadline, and none of the three tiers carried
--      one. Seven more.
--
--  Ten of forty-four sellable spaces, unsellable. This puts them back.
--
--  Afterwards, at 86 Paice Ave:
--
--    Priority   Lawn street row 1-3       a clear run to the road
--    Valet      the valet lane            keys held
--    Standard   Back yard 1-7             the home ground
--               Lawn back row 1-3         boxed in behind Priority
--               Double-park behind 1-7    boxes somebody in
--               any squeeze opened tonight
--
--  Two costs, both deliberate, both said plainly.
--
--  Standard now carries a return deadline, because the database will not
--  sell a double-park position without one. The deadline belongs to the
--  tier and not to the bay, so every Standard buyer is told "back at
--  your car by X" — including the ten parked where they box nobody in.
--  Moving the promise onto the booking that actually gets a stacked bay
--  would mean springing it after they have paid, which is worse.
--
--  And Standard is no longer allowed a plain clear-exit bay at all, via
--  a new bay_kind. It is the only way to keep the three street-row bays
--  for Priority: they and the double-park positions are structurally
--  identical — both block somebody, neither is blocked — so nothing
--  already in the schema told them apart.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. A fourth bay_kind: everything except a plain clear run.
--
--  free_exit       nothing behind you                    (Priority)
--  may_be_blocked  something can park in behind you
--  no_clear_exit   anything but a plain free-exit bay     (Standard)
--  any             take what is going                    (Valet)
--
--  no_clear_exit is the promise read backwards. Standard is sold as
--  "expect to wait for the drive to clear", so it should never be handed
--  the one thing Priority is sold on. It still takes the stack (which
--  blocks others rather than being blocked) and any spare opened on the
--  night, or the "+1" tap would have nothing to give it.
-- ---------------------------------------------------------------------
alter table offer_tier drop constraint if exists offer_tier_bay_kind_check;
alter table offer_tier add constraint offer_tier_bay_kind_check
  check (bay_kind in ('free_exit', 'may_be_blocked', 'no_clear_exit', 'any'));

-- ---------------------------------------------------------------------
--  2. Standard reaches the lawn, and stops short of Priority's three.
--
--  zone_codes is read as a running order now, not a set — see the
--  allocator below. Back yard leads because that is where a Standard car
--  belongs; the lawn is the spillover, not the first choice.
-- ---------------------------------------------------------------------
update offer_tier t
   set zone_codes = array['back_yard', 'front_lawn'],
       bay_kind   = 'no_clear_exit'
 where t.code = 'standard' and t.active;

-- ---------------------------------------------------------------------
--  3. Standard gets a deadline, so the stack is sellable.
--
--  Half an hour after the night is expected to end, not a fixed offset
--  from kickoff: these fixtures run from two and a half hours to eight,
--  and one number cannot mean the right thing at both.
--
--  Only nights that have not finished. What a past event promised is its
--  record, and a record does not get edited.
-- ---------------------------------------------------------------------
update offer_tier t
   set departure_by = e.expected_end_at + interval '30 minutes'
  from event_offer o, event e
 where o.id = t.event_offer_id
   and e.id = o.event_id
   and t.code = 'standard'
   and t.active
   and t.departure_by is null
   and e.expected_end_at > now();

-- ---------------------------------------------------------------------
--  4. Availability understands the new kind.
--
--  Unchanged but for the bay_kind arm, in both counts.
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
                when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                            or i.requires_early_departure
                                            or i.is_flex)
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
              when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                          or i.requires_early_departure
                                          or i.is_flex)
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
--  5. The allocator: the new kind, and a running order that hands out
--     the plainest space first.
--
--  The ordering gained two keys and the reason for both is the same — a
--  tier that can now reach four kinds of space should take the least
--  costly one first:
--
--    * kind of space, across the whole property and before any zone is
--      considered: an ordinary bay, then a spare somebody opened
--      tonight, then a position that boxes a stranger in. Boxing
--      somebody in is a last resort everywhere, not a last resort within
--      whichever zone happened to sort first.
--
--    * then the tier's own zone list, read as a running order, so
--      Standard fills the back yard before it starts on the lawn.
--      exit_rank would have done the opposite — the lawn is nearer the
--      road, so it sorts first — and Standard would have eaten the lawn
--      while the back yard sat empty.
--
--  For Priority and Valet nothing moves: both see one kind of space in
--  one zone, so the new keys are constant across everything they can
--  reach.
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
             when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                         or i.requires_early_departure
                                         or i.is_flex)
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
             when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                         or i.requires_early_departure
                                         or i.is_flex)
             else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       case when i.reservable_in_advance then 1 else 0 end,
       case when v_tier.guarantees_clear_exit and i.blocker_bay_id is null then 0 else 1 end,
       -- Ordinary bay, then a spare opened tonight, then the stack.
       case when i.requires_early_departure then 2 when i.is_flex then 1 else 0 end,
       -- Then the tier's zone list, in the order it names them.
       coalesce(array_position(v_tier.zone_codes, i.zone_code), 99),
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
                  when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                              or i.requires_early_departure
                                              or i.is_flex)
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
--  6. A night made from the gate screen starts the same way.
--
--  Per-code defaults, the convention this function already used for zone
--  lists. A template that names its own bay_kind, zone_codes or
--  departure_by_minutes still wins over every one of them.
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

    -- Defaulted per code, like the zone list below and for the same
    -- reason: Priority is sold on a clear run to the road, and Standard
    -- is sold on waiting, so Standard must not be handed the one thing
    -- Priority is sold on.
    v_kind := lower(trim(coalesce(v_item ->> 'bay_kind',
                case v_code
                  when 'priority' then 'free_exit'
                  when 'standard' then 'no_clear_exit'
                  else 'any'
                end)));
    if v_kind not in ('free_exit', 'may_be_blocked', 'no_clear_exit', 'any') then
      raise exception 'BAD_BAY_KIND: % must be free_exit, may_be_blocked, no_clear_exit or any', v_code
        using errcode = 'check_violation';
    end if;

    -- Null zone list = fulfil from anywhere on the property. An empty list
    -- would mean "nowhere", which is never what anyone meant.
    v_zones := v_item -> 'zone_codes';
    if v_zones is null or jsonb_typeof(v_zones) <> 'array' or jsonb_array_length(v_zones) = 0 then
      -- Standard names two, in the order it should fill them: the back
      -- yard is where a Standard car belongs and the lawn is the
      -- spillover.
      v_zones := case v_code
                   when 'valet'    then '["valet"]'::jsonb
                   when 'priority' then '["front_lawn","berm"]'::jsonb
                   when 'standard' then '["back_yard","front_lawn"]'::jsonb
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

-- Standard's deadline when the template did not name one: half an hour
-- after the night is expected to end. Computed from the event rather
-- than from kickoff, because these fixtures run from two and a half
-- hours to eight and one offset cannot suit both.
create or replace function default_departure_minutes(
  p_code text,
  p_expected_end_minutes integer
) returns integer
language sql
immutable
set search_path to 'public'
as $function$
  select case when p_code = 'standard'
              then coalesce(p_expected_end_minutes, 150) + 30
         end;
$function$;

-- ---------------------------------------------------------------------
--  7. Creating a night applies that default.
--
--  Identical to the function 20260917100000 left behind but for the
--  departure line.
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
      -- The template's number if it named one; otherwise the per-code
      -- default, which is what makes Standard's double-park positions
      -- sellable at all. Null for a tier that needs no deadline.
      (select case when d.m is null then null
                   else v_starts + make_interval(mins => d.m) end
         from (select coalesce(
                 (v_item ->> 'departure_by_minutes')::integer,
                 default_departure_minutes(v_item ->> 'code',
                                           coalesce(p_expected_end_minutes, 150))
               ) as m) d),
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
