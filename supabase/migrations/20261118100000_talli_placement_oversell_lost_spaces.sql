-- =====================================================================
--  Talli Parking — where a car goes, Standard into Priority at the gate,
--  and spaces lost on the night (plan B5)
--
--  Plan § 3.5 and § 3.10:
--
--    * Where a car goes is decided when it arrives. The warden's own site
--      is the default and it can be any site in the block. A Standard car
--      is placed, in order: a free Standard space here; a free Standard
--      space at another site in the block; a Priority space here; a
--      Priority space at another site in the block. Never Valet.
--    * Overselling is for walk-ups, and only Standard. Each Standard sold
--      past its count takes a Priority space, in the same order. Priority
--      and Valet are never sold past their own counts, and the website
--      still stops selling Standard at its count.
--    * A space lost on the night (bad parking, blocked, the host's own
--      car) is recorded against a site and type. It takes no money, is
--      not a booking, can be undone, and reduces availability everywhere.
--
--  How:
--
--    1. booking.space_code — the type of space the car is in, when that is
--       not the type it was sold as. Only ever 'priority' on a Standard
--       booking. Null means "the type it was sold as", which is every
--       booking made before this migration.
--    2. lost_space — its own table, with who and when, and undone_at.
--    3. private.tier_sold counts what takes a space of that type at that
--       site: the cars in one (by space, not by what was sold), plus the
--       spaces lost. Every check that reads it — hold_booking online and
--       at the gate, edit_booking_at_gate, v_tier_availability and so the
--       booking page — follows without being restated.
--    4. v_tier_availability: `sold` stays the cars, and gains `lost` and
--       `overflow_in` on the end.
--    5. propose_space(), place_booking(), check_in_placed(), and
--       sell_at_gate() restated to spill Standard into Priority.
--    6. record_lost_space() and undo_lost_space().
--
--  hold_booking is deliberately not restated: online selling is unchanged.
--  Additive: one column, one table, new functions, restated ones keep
--  their signatures.
-- =====================================================================

-- --------------------------------------------------- 1. the space a car is in

alter table booking add column if not exists space_code text;

comment on column booking.space_code is
  'The type of space this car takes, when it is not the type it was sold '
  'as: a Standard car placed in, or sold into, a Priority space (plan B5). '
  'Null means the same as tier_code. Counted by private.tier_sold.';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'booking'::regclass
                    and conname = 'booking_space_code_check') then
    alter table booking add constraint booking_space_code_check
      check (space_code is null or (tier_code = 'standard' and space_code = 'priority'));
  end if;
end $$;

-- A booking whose type is changed on its edit sheet takes a space of the
-- new type: whatever it was standing in for is over. Only when the same
-- statement did not set space_code itself, which is how sell_at_gate
-- records a spill.
create or replace function private.space_follows_tier()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.tier_code is distinct from old.tier_code
     and new.space_code is not distinct from old.space_code then
    new.space_code := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists booking_space_follows_tier on booking;
create trigger booking_space_follows_tier
  before update of tier_code on booking
  for each row execute function private.space_follows_tier();

-- ------------------------------------------------------ 2. lost spaces

create table if not exists lost_space (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references event(id) on delete cascade,
  property_id  uuid not null references property(id) on delete restrict,
  tier_code    text not null,
  reason       text not null
               check (reason in ('bad_parking', 'blocked', 'host_car', 'other')),
  note         text,
  recorded_by  uuid references host_user(id) on delete set null,
  recorded_at  timestamptz not null default now(),
  undone_at    timestamptz,
  undone_by    uuid references host_user(id) on delete set null
);

comment on table lost_space is
  'A space that could not be used on the night (plan B5): a car parked '
  'across two, a driveway blocked, the host''s own car. Not a booking and '
  'takes no money. Counted against availability by private.tier_sold until '
  'undone. B7 takes it off the host''s spaces provided.';

create index if not exists lost_space_open
  on lost_space (event_id, property_id, tier_code) where undone_at is null;

alter table lost_space enable row level security;
revoke all on lost_space from public, anon, authenticated;
grant all on lost_space to service_role;

-- ----------------------------------------------------- 3. the counts

-- Cars taking a space of this type here: by the space they are in, not
-- by what they were sold as.
create or replace function private.tier_cars(p_event_id uuid, p_property_id uuid, p_tier_code text)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  select count(*)::integer
    from booking b
   where b.event_id = p_event_id
     and b.property_id = p_property_id
     and coalesce(b.space_code, b.tier_code) = p_tier_code
     and (b.status = 'paid'
          or (b.status = 'held'
              and (b.hold_expires_at is null or b.hold_expires_at > now())));
$function$;

create or replace function private.tier_lost(p_event_id uuid, p_property_id uuid, p_tier_code text)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  select count(*)::integer
    from lost_space l
   where l.event_id = p_event_id
     and l.property_id = p_property_id
     and l.tier_code = p_tier_code
     and l.undone_at is null;
$function$;

-- Standard cars standing in this type's spaces.
create or replace function private.tier_overflow_in(p_event_id uuid, p_property_id uuid, p_tier_code text)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  select count(*)::integer
    from booking b
   where b.event_id = p_event_id
     and b.property_id = p_property_id
     and b.space_code = p_tier_code
     and b.space_code is distinct from b.tier_code
     and (b.status = 'paid'
          or (b.status = 'held'
              and (b.hold_expires_at is null or b.hold_expires_at > now())));
$function$;

-- What is no longer free: the cars in a space of this type, and the
-- spaces lost. Every availability check reads this, so a Standard car in
-- a Priority space, or a lost space, comes off everywhere at once.
create or replace function private.tier_sold(p_event_id uuid, p_property_id uuid, p_tier_code text)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  select private.tier_cars(p_event_id, p_property_id, p_tier_code)
       + private.tier_lost(p_event_id, p_property_id, p_tier_code);
$function$;

-- ---------------------------------------------- 4. v_tier_availability

-- Restated from 20260918160000_talli_the_count_is_not_an_endpoint. The
-- availability columns follow tier_sold. `sold` is the cars only, as the
-- gate screen has always shown it; lost spaces and Standard cars in this
-- type's spaces are their own columns, on the end.
create or replace view v_tier_availability
with (security_invoker = true)
as
 select t.id as offer_tier_id,
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
                             - private.tier_sold(eo.event_id, eo.property_id, t.code)
                             - t.gate_reserve)
        end as spots_left,
        case
            when t.manually_sold_out then 0
            else greatest(0, coalesce(t.capacity, 0)
                             - private.tier_sold(eo.event_id, eo.property_id, t.code))
        end as spots_left_gate,
    t.manually_sold_out,
    t.price_updated_at,
    t.gate_reserve,
    coalesce(t.capacity, 0) as capacity,
    private.tier_cars(eo.event_id, eo.property_id, t.code) as sold,
    private.tier_lost(eo.event_id, eo.property_id, t.code) as lost,
    private.tier_overflow_in(eo.event_id, eo.property_id, t.code) as overflow_in
   from offer_tier t
     join event_offer eo on eo.id = t.event_offer_id
     join event e on e.id = eo.event_id
  where t.active;

alter view v_tier_availability set (security_invoker = true);

-- ------------------------------------------------ 5. placing a car

-- Free spaces of one type at one site tonight. A booking can be named so
-- the space it is already in counts as free for it. When selling, a type
-- marked sold out has nothing free; when placing a car that is already
-- sold, the spaces are still there and it does.
create or replace function private.space_free(
  p_event_id uuid, p_property_id uuid, p_code text,
  p_booking_id uuid default null, p_selling boolean default false)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce((
    select case when p_selling and t.manually_sold_out then 0
                else coalesce(t.capacity, 0)
                     - private.tier_sold(p_event_id, p_property_id, p_code)
                     + (select count(*)::integer from booking b
                         where b.id = p_booking_id
                           and b.event_id = p_event_id
                           and b.property_id = p_property_id
                           and coalesce(b.space_code, b.tier_code) = p_code
                           and b.status in ('paid', 'held'))
           end
      from offer_tier t
      join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and o.property_id = p_property_id
       and t.code = p_code and t.active
     limit 1), 0);
$function$;

-- Where a car of this type should go, standing at p_property_id. One row,
-- or none when there is no room anywhere it may go.
--
--   Standard: a Standard space here; a Standard space elsewhere in the
--   block; a Priority space here; a Priority space elsewhere in the block.
--   Never Valet. Elsewhere, the anchor first, then the most room.
--
--   Any other type: its own type, here. Priority and Valet never spill.
create or replace function propose_space(
  p_event_id uuid, p_property_id uuid, p_tier_code text,
  p_booking_id uuid default null, p_selling boolean default false)
returns table (property_id uuid, space_code text, free integer)
language sql
stable
set search_path to 'public'
as $function$
  with here as (
    select p.id, p.block_id from property p where p.id = p_property_id
  ),
  sites as (
    -- This site, and when it is in a block, every active site in the
    -- block that is part of this night.
    select o.property_id as id,
           (o.property_id = p_property_id) as is_here,
           coalesce(o.property_id = bl.anchor_property_id, false) as is_anchor,
           pr.name
      from event_offer o
      join property pr on pr.id = o.property_id
      left join block bl on bl.id = pr.block_id
      cross join here
     where o.event_id = p_event_id
       -- Another site only once it is confirmed for the night: a site
       -- still pending has not said it will take cars.
       and (o.property_id = p_property_id
            or (here.block_id is not null and pr.block_id = here.block_id and pr.active
                and o.status = 'confirmed'))
  ),
  options as (
    select s.id, c.code, s.is_here, s.is_anchor, s.name,
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
     where p_tier_code = 'standard' or s.is_here
  )
  select id, code, free
    from options
   where free > 0
   order by rank, is_anchor desc, free desc, name
   limit 1;
$function$;

-- Put a car in a space: this site, this type of space. A Standard car may
-- go into a Priority space; nothing goes into a type it was not sold as
-- otherwise. The space must be free, unless it is the one the car is
-- already counted in. Ticks it in, and records who.
create or replace function place_booking(
  p_booking_id uuid, p_property_id uuid, p_space_code text default null,
  p_by uuid default null)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  b        booking%rowtype;
  v_space  text;
  v_was    text;
  v_block  uuid;
  v_target uuid;
begin
  select * into b from booking where id = p_booking_id for update;
  if not found or b.status not in ('paid', 'held') then
    raise exception 'NO_BOOKING: no such booking at the gate tonight'
      using errcode = 'check_violation';
  end if;

  v_space := coalesce(p_space_code, b.tier_code);
  v_was := coalesce(b.space_code, b.tier_code);
  if v_space <> b.tier_code and not (b.tier_code = 'standard' and v_space = 'priority') then
    raise exception 'WRONG_SPACE: a % booking cannot go in a % space', b.tier_code, v_space
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from event_offer o
                  where o.event_id = b.event_id and o.property_id = p_property_id) then
    raise exception 'SITE_NOT_IN_EVENT: that site is not part of this event'
      using errcode = 'check_violation';
  end if;

  -- Any site in the block it was booked into.
  select pr.block_id into v_block from property pr
   where pr.id = coalesce(b.booked_property_id, b.property_id);
  select pr.block_id into v_target from property pr where pr.id = p_property_id;
  if p_property_id <> b.property_id and p_property_id <> coalesce(b.booked_property_id, b.property_id)
     and (v_block is null or v_target is distinct from v_block) then
    raise exception 'NOT_IN_BLOCK: that site is not in the block this car was booked into'
      using errcode = 'check_violation';
  end if;

  if not (p_property_id = b.property_id and v_space = v_was) then
    -- Take the tier row's lock, as hold_booking does, so two phones
    -- placing the last space take turns.
    perform 1 from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = b.event_id and o.property_id = p_property_id
       and t.code = v_space and t.active
       for update of t;
    if private.space_free(b.event_id, p_property_id, v_space, b.id, false) <= 0 then
      raise exception 'NO_ROOM: no % space free at that site', v_space
        using errcode = 'check_violation';
    end if;
  end if;

  update booking set
    property_id   = p_property_id,
    space_code    = nullif(v_space, b.tier_code),
    checked_in_at = coalesce(checked_in_at, now()),
    checked_in_by = coalesce(checked_in_by, p_by)
  where id = b.id
  returning * into b;

  return jsonb_build_object(
    'booking_id', b.id,
    'property_id', b.property_id,
    'space_code', coalesce(b.space_code, b.tier_code),
    'tier_code', b.tier_code);
end;
$function$;

-- Tick in, standing at p_property_id: the car goes where propose_space
-- says. When there is no room anywhere it may go, it is ticked in where
-- it was already counted and `no_room` says so — the car is in front of
-- the warden either way, and the count stays honest.
create or replace function check_in_placed(
  p_booking_id uuid, p_property_id uuid, p_by uuid default null)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  b       booking%rowtype;
  v_here  uuid;
  v_home  uuid;
  v_place record;
  v_out   jsonb;
begin
  select * into b from booking where id = p_booking_id;
  if not found or b.status not in ('paid', 'held') then
    raise exception 'NO_BOOKING: no such booking at the gate tonight'
      using errcode = 'check_violation';
  end if;

  -- A warden standing in another block from the one this car was booked
  -- into: propose nothing there, tick it in where it is.
  select block_id into v_here from property where id = p_property_id;
  select block_id into v_home from property
   where id = coalesce(b.booked_property_id, b.property_id);

  if p_property_id is not null
     and (p_property_id = coalesce(b.booked_property_id, b.property_id)
          or (v_here is not null and v_here = v_home)) then
    select * into v_place
      from propose_space(b.event_id, p_property_id, b.tier_code, b.id, false);
    if found then
      v_out := place_booking(b.id, v_place.property_id, v_place.space_code, p_by);
      return v_out || jsonb_build_object('no_room', false);
    end if;
  end if;

  perform check_in_booking_at(b.id, null, p_by);
  return jsonb_build_object(
    'booking_id', b.id,
    'property_id', b.property_id,
    'space_code', coalesce(b.space_code, b.tier_code),
    'tier_code', b.tier_code,
    'no_room', p_property_id is not null);
end;
$function$;

-- ----------------------------------------- sell_at_gate, with the spill

-- Restated from 20261010100000_talli_price_one_car. What is new: a
-- Standard walk-up goes where propose_space sends it. When that is a
-- Priority space, the booking is held against the Priority count (so
-- hold_booking's lock and checks do the work) and then recorded as the
-- Standard sale it is, at the Standard price of the site it was sold at.
create or replace function sell_at_gate(
  p_event_id uuid, p_property_id uuid, p_tier_code text,
  p_payment_method text default 'cash', p_rego text default null,
  p_name text default null, p_phone text default null, p_email text default null,
  p_accepts_street boolean default false, p_low_clearance boolean default false,
  p_price_cents integer default null)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id     uuid;
  v_email  text;
  v_place  record;
  v_target uuid := p_property_id;
  v_space  text := p_tier_code;
  v_std    offer_tier%rowtype;
  v_share  numeric(5,4);
begin
  if p_payment_method = 'stripe' then
    raise exception 'BAD_METHOD: a gate sale cannot be paid online'
      using errcode = 'check_violation';
  end if;

  v_email := coalesce(p_email, 'gate+' || replace(gen_random_uuid()::text,'-','') || '@talli.co.nz');

  -- Only Standard spills. Marked sold out means stop selling it, here and
  -- everywhere it might have spilled to; hold_booking says so by name.
  if p_tier_code = 'standard' then
    select t.* into v_std
      from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and o.property_id = p_property_id
       and t.code = 'standard' and t.active;
    if found and not v_std.manually_sold_out then
      select * into v_place from propose_space(p_event_id, p_property_id, 'standard', null, true);
      if found then
        v_target := v_place.property_id;
        v_space := v_place.space_code;
      end if;
    end if;
  end if;

  v_id := hold_booking(
    p_event_id, v_target, v_space, v_email,
    p_name, p_phone, p_rego, 5, 'gate', p_accepts_street, p_payment_method,
    p_low_clearance);

  if v_space <> p_tier_code then
    -- Sold as Standard, at the Standard price, in a Priority space.
    select h.platform_share into v_share
      from property pr join host h on h.id = pr.host_id where pr.id = v_target;
    update booking set
      tier_code           = 'standard',
      space_code          = v_space,
      amount_cents        = v_std.price_cents,
      arrival_from        = v_std.arrival_from,
      arrival_until       = v_std.arrival_until,
      must_depart_by      = v_std.departure_by,
      platform_fee_cents  = round(v_std.price_cents * coalesce(v_share, 0)),
      host_earnings_cents = v_std.price_cents - round(v_std.price_cents * coalesce(v_share, 0))
    where id = v_id;
  end if;

  if p_price_cents is not null then
    perform set_booking_price_at_gate(v_id, p_price_cents);
  end if;

  if p_payment_method = 'unpaid' then
    update booking set hold_expires_at = null where id = v_id;
  else
    perform confirm_booking(v_id, null);
  end if;

  perform check_in_booking(v_id);
  return v_id;
end;
$function$;

-- --------------------------------------------------- 6. lost spaces

create or replace function record_lost_space(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_reason text,
  p_note text default null, p_by uuid default null)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if p_reason is null or p_reason not in ('bad_parking', 'blocked', 'host_car', 'other') then
    raise exception 'BAD_REASON: say why the space was lost'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and o.property_id = p_property_id
       and t.code = p_tier_code and t.active) then
    raise exception 'NO_TIER: that site has no % spaces tonight', p_tier_code
      using errcode = 'check_violation';
  end if;

  insert into lost_space (event_id, property_id, tier_code, reason, note, recorded_by)
  values (p_event_id, p_property_id, p_tier_code, p_reason,
          nullif(trim(coalesce(p_note, '')), ''), p_by)
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function undo_lost_space(p_id uuid, p_by uuid default null)
returns boolean
language plpgsql
set search_path to 'public'
as $function$
begin
  update lost_space set undone_at = now(), undone_by = p_by
   where id = p_id and undone_at is null;
  return found;
end;
$function$;

-- --------------------------------------------------------- who may call

-- gate-ops, under the service role, and nobody else. The warden's scope
-- is checked there, before any of these is called.
revoke all on function propose_space(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
revoke all on function place_booking(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function check_in_placed(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function record_lost_space(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function undo_lost_space(uuid, uuid) from public, anon, authenticated;
grant execute on function propose_space(uuid, uuid, text, uuid, boolean) to service_role;
grant execute on function place_booking(uuid, uuid, text, uuid) to service_role;
grant execute on function check_in_placed(uuid, uuid, uuid) to service_role;
grant execute on function record_lost_space(uuid, uuid, text, text, text, uuid) to service_role;
grant execute on function undo_lost_space(uuid, uuid) to service_role;

-- The counts behind v_tier_availability, which the booking page reads as
-- anon. The same grant tier_sold has always had: numbers, never rows.
grant execute on function private.tier_cars(uuid, uuid, text) to anon, authenticated, service_role;
grant execute on function private.tier_lost(uuid, uuid, text) to anon, authenticated, service_role;
grant execute on function private.tier_overflow_in(uuid, uuid, text) to anon, authenticated, service_role;

revoke all on function private.space_free(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function private.space_free(uuid, uuid, text, uuid, boolean) to service_role;
