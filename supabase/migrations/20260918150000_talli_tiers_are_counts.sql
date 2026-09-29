-- =====================================================================
--  Talli Parking — a tier is a number of spaces, not a set of bays
--
--  Andrew: "I think we have over complicated things which isn't very
--  productisable." He is right, and this is the thing that was over
--  complicated.
--
--  The yard was modelled bay by bay: zones, individual spaces, which bay
--  blocks which, which tier may reach which kind. All of it true of 86
--  Paice Ave and none of it true of the next car park, which is what
--  makes it unproductisable. It also produced a Tonight tab with four
--  zone cards nobody thinks in.
--
--  A tier is now three numbers and a price:
--
--      capacity      how many spaces of this type there are tonight
--      gate_reserve  how many of those are held for walk-ups
--      sold          how many bookings exist against it
--
--  and everything else falls out:
--
--      left at the gate = capacity - sold
--      left online      = capacity - sold - gate_reserve
--
--  Defaults, as given:
--
--      Standard   10 spaces, 6 online   (4 held)
--      Priority   16 spaces, 3 online  (13 held)
--      Valet       6 spaces, 3 online   (3 held)
--
--  WHAT THIS COSTS, said plainly, because it was built this morning and
--  is being retired this afternoon: the running order of 20260918130000
--  and the place-the-car-on-arrival of 20260918140000 both go. There are
--  no bays to order or to place into. Where a car actually goes is the
--  marshal's call at the window again, which is how it was always
--  decided in practice.
--
--  Writing a space off is now a tap on the tier: "I lost one in the back
--  yard, so Standard goes from 10 to 9." Andrew's words: "I know which
--  bays are which."
--
--  NOTHING IS DROPPED. bay, zone, bay_allocation and the views over them
--  all stay exactly as they are, holding the history of every booking
--  already placed. They simply stop deciding whether a space can be
--  sold. If this turns out to be the wrong trade, the way back is to
--  point hold_booking at them again, not to restore a backup.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. The number of spaces, per tier, per night.
--
--  Nullable with no default on purpose: null means "nobody has said",
--  and the backfill below is what says it. A tier created later without
--  a capacity is caught by the guard in hold_booking rather than
--  silently selling nothing or selling forever.
-- ---------------------------------------------------------------------
alter table offer_tier
  add column if not exists capacity integer;

alter table offer_tier
  drop constraint if exists offer_tier_capacity_check;
alter table offer_tier
  add constraint offer_tier_capacity_check
  check (capacity is null or (capacity >= 0 and capacity <= 500));

comment on column offer_tier.capacity is
  'Spaces of this type on sale tonight. The whole inventory model: bays and '
  'zones no longer decide what can be sold, only what was historically placed.';

-- ---------------------------------------------------------------------
--  2. The numbers asked for, on every night not yet finished.
--
--  A past event keeps whatever it sold; its record is not edited.
-- ---------------------------------------------------------------------
update offer_tier t
   set capacity = case t.code
                    when 'standard' then 10
                    when 'priority' then 16
                    when 'valet'    then 6
                    else coalesce(t.capacity, 0)
                  end,
       gate_reserve = case t.code
                        when 'standard' then 4
                        when 'priority' then 13
                        when 'valet'    then 3
                        else t.gate_reserve
                      end
  from event_offer o, event e
 where o.id = t.event_offer_id
   and e.id = o.event_id
   and t.active
   and e.expected_end_at > now();

-- Past nights keep their history but still need a number, or the view
-- would read them as unsellable-and-unknown rather than simply over.
update offer_tier t set capacity = coalesce(t.capacity, 0)
 where t.capacity is null;

-- A tier that was hand-marked sold out under the bay model has no button to
-- un-mark it any more: the Tonight tab now derives sold-out from the count.
-- Clear the flag on every night still to come so nothing is stuck off sale
-- with no way back. The column stays, and is still honoured, for anything
-- that sets it directly.
update offer_tier t
   set manually_sold_out = false
  from event_offer o, event e
 where o.id = t.event_offer_id
   and e.id = o.event_id
   and t.manually_sold_out
   and e.expected_end_at > now();

-- ---------------------------------------------------------------------
--  3. What counts as a space taken.
--
--  A booking holds one space while it is paid, or while it is an unpaid
--  hold that has not run out. Cancelled, refunded, expired and
--  transferred all give the space back — transferred especially, because
--  sending a car to a neighbour's site is done precisely to free the
--  space here.
--
--  The bay model needed expire_stale_holds() to be run by somebody
--  before an abandoned checkout stopped occupying a bay, and nothing
--  ran it. Counting the hold's own expiry means a dead hold frees its
--  space by the clock, with no sweep to forget.
-- ---------------------------------------------------------------------
--  SECURITY DEFINER on purpose. v_tier_availability is read straight off
--  PostgREST by the booking page as anon, and anon cannot see the booking
--  table. This returns one number for one tier of one night and nothing
--  about anybody — the same number spots_left has always exposed.
create or replace function tier_sold(
  p_event_id uuid, p_property_id uuid, p_tier_code text
) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer
    from booking b
   where b.event_id = p_event_id
     and b.property_id = p_property_id
     and b.tier_code = p_tier_code
     and (b.status = 'paid'
          or (b.status = 'held'
              and (b.hold_expires_at is null or b.hold_expires_at > now())));
$$;

comment on function tier_sold(uuid, uuid, text) is
  'Spaces of a tier currently spoken for: paid bookings plus live holds.';

-- ---------------------------------------------------------------------
--  4. Availability is arithmetic now.
--
--      spots_left_gate  capacity - sold
--      spots_left       capacity - sold - gate_reserve   (what the website
--                                                         may sell)
--
--  Column order is unchanged and capacity/sold are appended, so every
--  existing reader — booking.js, the gate screen, the edge function —
--  keeps working without being touched.
-- ---------------------------------------------------------------------
create or replace view v_tier_availability
with (security_invoker = true) as
select
  t.id                                       as offer_tier_id,
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
  case
    when t.manually_sold_out then 0
    when e.online_sales_close_at is not null and now() > e.online_sales_close_at then 0
    else greatest(0, coalesce(t.capacity, 0)
                     - tier_sold(eo.event_id, eo.property_id, t.code)
                     - t.gate_reserve)
  end::integer                               as spots_left,
  case
    when t.manually_sold_out then 0
    else greatest(0, coalesce(t.capacity, 0)
                     - tier_sold(eo.event_id, eo.property_id, t.code))
  end::integer                               as spots_left_gate,
  t.manually_sold_out,
  t.price_updated_at,
  t.gate_reserve,
  coalesce(t.capacity, 0)::integer           as capacity,
  tier_sold(eo.event_id, eo.property_id, t.code) as sold
from offer_tier t
join event_offer eo on eo.id = t.event_offer_id
join event e on e.id = eo.event_id
where t.active;

comment on view v_tier_availability is
  'One row per tier on sale: the price, the count, and what is left of it.';

-- ---------------------------------------------------------------------
--  5. Selling is a count, not a bay.
--
--  The unique constraint on bay_allocation used to be what stopped two
--  customers buying the same space. With no allocation there is nothing
--  to collide on, so the tier row itself is taken for update: two
--  checkouts for the last Standard queue behind each other and the
--  second one reads a count that already includes the first.
--
--  Gone with the bays: CONSENT_REQUIRED. There is no berm bay to refuse
--  someone any more, so accepts_street_parking is recorded on the
--  booking and no longer gates the sale.
-- ---------------------------------------------------------------------
create or replace function hold_booking(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_email text,
  p_name text default null, p_phone text default null, p_rego text default null,
  p_hold_minutes integer default 30, p_channel text default 'online',
  p_accepts_street boolean default false, p_payment_method text default 'stripe',
  p_low_clearance boolean default false
) returns uuid
language plpgsql set search_path = public as $$
declare
  v_tier    offer_tier%rowtype;
  v_close   timestamptz;
  v_share   numeric(5,4);
  v_platform int;
  v_booking_id uuid;
  v_sold    integer;
  v_online  integer;
begin
  -- for update of t: the lock is on the tier row, not the joined event.
  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active
     for update of t;
  if not found then
    raise exception 'No active tier "%" for that event and property', p_tier_code;
  end if;

  -- Null is "nobody has said how many", which is not the same as zero and
  -- must not be read as either "none" or "unlimited".
  if v_tier.capacity is null then
    raise exception 'NO_CAPACITY: nobody has set how many "%" spaces there are tonight', p_tier_code
      using errcode = 'check_violation';
  end if;

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

  v_sold := tier_sold(p_event_id, p_property_id, p_tier_code);

  if v_sold >= v_tier.capacity then
    raise exception 'SOLD_OUT: no "%" spaces left at that property', p_tier_code
      using errcode = 'check_violation';
  end if;

  if p_channel <> 'gate' then
    v_online := v_tier.capacity - v_sold - v_tier.gate_reserve;
    if v_online <= 0 then
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

  return v_booking_id;
end;
$$;

-- ---------------------------------------------------------------------
--  6. Ticking in is ticking in.
--
--  20260918140000 made check-in pick a bay and shuffle other cars into
--  better ones. There are no bays to pick, and where a car actually goes
--  is the marshal's call standing in the driveway, which is how it was
--  decided before the database had an opinion.
-- ---------------------------------------------------------------------
create or replace function check_in_booking(p_booking_id uuid)
returns void
language plpgsql set search_path = public as $$
begin
  update booking set checked_in_at = coalesce(checked_in_at, now())
   where id = p_booking_id and status in ('paid', 'held');
end;
$$;

-- ---------------------------------------------------------------------
--  7. Writing a space off, or finding one.
--
--  Andrew: "I know which bays are which, so if I lose a spot in the back
--  yard, I'll know already which type I need to take away from." So the
--  screen asks for the type and the number, and nothing asks about bays.
--
--  The floor is what is already sold. Taking the total below that would
--  claim spaces that have people attached to them.
-- ---------------------------------------------------------------------
create or replace function adjust_tier_capacity(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_delta integer
) returns integer
language plpgsql set search_path = public as $$
declare
  v_id   uuid;
  v_now  integer;
  v_sold integer;
  v_next integer;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'NO_CHANGE: delta must not be zero'
      using errcode = 'check_violation';
  end if;
  if abs(p_delta) > 10 then
    raise exception 'BAD_DELTA: move the count by ten or fewer at a time'
      using errcode = 'check_violation';
  end if;

  select t.id, coalesce(t.capacity, 0) into v_id, v_now
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active
     for update of t;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  v_sold := tier_sold(p_event_id, p_property_id, p_tier_code);
  v_next := least(500, v_now + p_delta);

  if v_next < v_sold then
    raise exception 'ALREADY_SOLD: % "%" space(s) are already spoken for',
      v_sold, p_tier_code
      using errcode = 'check_violation';
  end if;

  update offer_tier
     set capacity = v_next,
         -- A reserve larger than the count is a number nobody can read.
         gate_reserve = least(gate_reserve, v_next)
   where id = v_id;

  return v_next;
end;
$$;

-- The same clamp from the other side: holding back more than there are.
create or replace function adjust_tier_reserve(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_delta integer
) returns integer
language plpgsql set search_path = public as $$
declare
  v_id  uuid;
  v_now integer;
  v_cap integer;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'NO_CHANGE: delta must not be zero'
      using errcode = 'check_violation';
  end if;
  if abs(p_delta) > 10 then
    raise exception 'BAD_DELTA: move the reserve by ten or fewer at a time'
      using errcode = 'check_violation';
  end if;

  select t.id, t.gate_reserve, coalesce(t.capacity, 0) into v_id, v_now, v_cap
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active
     for update of t;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  v_now := greatest(0, least(v_cap, v_now + p_delta));

  update offer_tier set gate_reserve = v_now where id = v_id;

  return v_now;
end;
$$;

-- Counting is public because the count already is. Changing the night is
-- the gate screen's job, and the gate screen comes through the edge
-- function as the service role.
revoke execute on function tier_sold(uuid, uuid, text) from public;
grant execute on function tier_sold(uuid, uuid, text)
  to anon, authenticated, service_role;

revoke execute on function adjust_tier_capacity(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function adjust_tier_capacity(uuid, uuid, text, integer)
  to service_role;

-- ---------------------------------------------------------------------
--  8. What a new night starts with.
--
--      Standard   10 spaces, 4 held back   →  6 online
--      Priority   16 spaces, 13 held back  →  3 online
--      Valet       6 spaces, 3 held back   →  3 online
--
--  The defaults live here rather than in the templates on purpose. The
--  templates carry price and wording, which is what changes between a
--  Warriors game and a school gala; the yard is the same yard. Putting
--  them in the templates is also what bit us last time: an explicit
--  value in the JSON beats a default in the function, so every new event
--  quietly reverted. A template that omits capacity gets these.
-- ---------------------------------------------------------------------
create or replace function normalise_event_tiers(p_tiers jsonb)
returns jsonb
language plpgsql immutable set search_path = public as $$
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
  v_cap     integer;
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

    v_label := nullif(trim(coalesce(v_item ->> 'label', '')), '');
    if v_label is null then
      v_label := initcap(replace(v_code, '_', ' '));
    end if;
    if length(v_label) > 160 then
      raise exception 'LONG_LABEL: "%" is too long for the booking page', v_code
        using errcode = 'check_violation';
    end if;

    v_price := (v_item ->> 'price_cents')::integer;
    if v_price is null or v_price < 100 or v_price > 50000 then
      raise exception 'BAD_PRICE: % must be priced between $1 and $500', v_code
        using errcode = 'check_violation';
    end if;

    v_from   := coalesce((v_item ->> 'arrival_from_minutes')::integer, -150);
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

    -- Kept so an older template still loads and so the history of what a
    -- tier once meant is not thrown away. Nothing reads them to decide a
    -- sale any more.
    v_kind := lower(trim(coalesce(v_item ->> 'bay_kind', 'any')));
    if v_kind not in ('free_exit', 'may_be_blocked', 'no_clear_exit', 'any') then
      raise exception 'BAD_BAY_KIND: % must be free_exit, may_be_blocked, no_clear_exit or any', v_code
        using errcode = 'check_violation';
    end if;
    v_zones := v_item -> 'zone_codes';
    if v_zones is null or jsonb_typeof(v_zones) <> 'array' or jsonb_array_length(v_zones) = 0 then
      v_zones := null;
    end if;

    v_cap := coalesce(
               (v_item ->> 'capacity')::integer,
               case v_code
                 when 'standard' then 10
                 when 'priority' then 16
                 when 'valet'    then 6
                 else 0
               end);
    if v_cap < 0 or v_cap > 500 then
      raise exception 'BAD_CAPACITY: % must have between 0 and 500 spaces', v_code
        using errcode = 'check_violation';
    end if;

    v_reserve := coalesce(
                   (v_item ->> 'gate_reserve')::integer,
                   case v_code
                     when 'standard' then 4
                     when 'priority' then 13
                     when 'valet'    then 3
                     else 0
                   end);
    if v_reserve < 0 or v_reserve > 200 then
      raise exception 'BAD_RESERVE: % must hold back between 0 and 200 spaces', v_code
        using errcode = 'check_violation';
    end if;
    -- Holding back more than exists reads as a broken screen, not a policy.
    v_reserve := least(v_reserve, v_cap);

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
      'capacity', v_cap,
      'gate_reserve', v_reserve,
      'sort_order', coalesce((v_item ->> 'sort_order')::integer, v_n)
    );
  end loop;

  return v_out;
end;
$$;

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

  return v_event;
end;
$$;
