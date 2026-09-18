-- =====================================================================
--  Talli Parking — the count is not a public endpoint
--
--  20260918150000 gave the booking page its numbers through tier_sold(),
--  a SECURITY DEFINER function, because v_tier_availability runs as the
--  invoker and anon cannot see the booking table. That much was right.
--  Putting it in `public` was not: everything in `public` is an API
--  endpoint, so the function became callable at /rest/v1/rpc/tier_sold
--  by anyone, and Supabase's linter says so under
--  anon_security_definer_function_executable.
--
--  Nothing leaks through it — it takes an event, a property and a tier
--  code and returns one number that v_tier_availability already
--  publishes to the same reader. But this repository has spent two
--  migrations (20260821096000, 20260821097000) taking SECURITY DEFINER
--  *off* things that faced anon, and leaving a new one on the API for
--  the sake of a count would undo the position rather than argue with
--  it.
--
--  So the function moves to a schema PostgREST does not serve. The view
--  still calls it, anon may still execute it through the view, and
--  there is no longer a URL for it. Same numbers, no endpoint.
-- =====================================================================

create schema if not exists private;

comment on schema private is
  'Things the database needs and the API must not serve. PostgREST exposes '
  'public and graphql_public only, so nothing here has a URL.';

-- anon must still be able to run what the view calls, since the view
-- runs as its reader. Usage on the schema is not a way in on its own:
-- every object in here is granted separately, or not at all.
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.tier_sold(
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

comment on function private.tier_sold(uuid, uuid, text) is
  'Spaces of a tier currently spoken for: paid bookings plus live holds. '
  'SECURITY DEFINER so v_tier_availability can be read by anon; in private '
  'so it is not an endpoint of its own.';

revoke execute on function private.tier_sold(uuid, uuid, text) from public;
grant execute on function private.tier_sold(uuid, uuid, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
--  The three callers, repointed. Bodies are unchanged apart from the
--  schema on the call.
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
                     - private.tier_sold(eo.event_id, eo.property_id, t.code)
                     - t.gate_reserve)
  end::integer                               as spots_left,
  case
    when t.manually_sold_out then 0
    else greatest(0, coalesce(t.capacity, 0)
                     - private.tier_sold(eo.event_id, eo.property_id, t.code))
  end::integer                               as spots_left_gate,
  t.manually_sold_out,
  t.price_updated_at,
  t.gate_reserve,
  coalesce(t.capacity, 0)::integer           as capacity,
  private.tier_sold(eo.event_id, eo.property_id, t.code) as sold
from offer_tier t
join event_offer eo on eo.id = t.event_offer_id
join event e on e.id = eo.event_id
where t.active;

comment on view v_tier_availability is
  'One row per tier on sale: the price, the count, and what is left of it.';

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

  v_sold := private.tier_sold(p_event_id, p_property_id, p_tier_code);

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

  v_sold := private.tier_sold(p_event_id, p_property_id, p_tier_code);
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

-- And the endpoint goes. Dropped last, once nothing points at it.
drop function if exists public.tier_sold(uuid, uuid, text);
