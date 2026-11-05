-- =====================================================================
--  Talli Parking — blocks, wardens, and where the car actually went
--
--  From the design (Nov 2026):
--
--     Talli becomes a managed network of driveways. A *block* is a cluster
--     of nearby houses one warden can cover (~15 cars), with an anchor
--     address. Customers book "70 Gribblehurst St or within 100m"; the
--     warden decides the driveway on the night, and hosts are paid for the
--     cars that actually parked on their site.
--
--  What this migration adds:
--
--   1. `block`, and `property.block_id`. Every existing property joins a
--      "Paice Ave" block, so nothing changes for the current site.
--      (The existing `zone` table is an area *within* a property and is
--      untouched — a block is the other way up.)
--
--   2. `host.is_operator` marks Talli itself. A host_user with scope
--      'all' is a super admin; scope 'blocks' (a warden) sees only the
--      blocks granted in `staff_block_access`, which Andrew can switch off.
--
--   3. `event_offer.status` — pending / confirmed / paused. Nothing sells
--      online at a site until it is confirmed for that event. Existing
--      offers are confirmed, so the live site carries on as it is.
--
--   4. On `booking`: booked_property_id (where the system put them),
--      checked_in_by and cash_collected_by (which warden). property_id
--      keeps meaning "where the car is" and is updated at check-in.
--
--   5. hold_booking() refuses a booking with no number plate, and refuses
--      online sales at an unconfirmed site.
--
--   6. check_in_booking_at() records the site and the warden. Moving a car
--      to another property is allowed over capacity (with a warning in
--      the app). The original check_in_booking(uuid) stays for sell_at_gate.
--
--   7. pick_block_property() chooses the property for an online booking
--      in a block: the event's anchor if it has room, else the site with
--      the most room. v_block_tier_availability is what the booking page
--      reads: one row per block per type.
--
--  Nothing here drops anything: every change is additive, so it can be
--  applied to production without a destructive-statement prompt.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Blocks
-- ---------------------------------------------------------------------
create table if not exists block (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  anchor_property_id uuid references property(id) on delete set null,
  lat                numeric(9,6),
  lng                numeric(9,6),
  active             boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now()
);

comment on table block is
  'A cluster of nearby properties one warden can cover. What customers book '
  'and what wardens are given access to. Not the same as zone (an area '
  'within one property).';

alter table property
  add column if not exists block_id      uuid references block(id) on delete set null,
  add column if not exists lat           numeric(9,6),
  add column if not exists lng           numeric(9,6),
  add column if not exists site_guide_url text,
  add column if not exists fill_notes    text;

comment on column property.site_guide_url is
  'Annotated photo of where to park, for the warden (and for unmanaged bookings later).';

-- Every property that exists today belongs to the Paice Ave block.
insert into block (name, anchor_property_id, sort_order)
select 'Paice Ave',
       (select id from property where name = '86 Paice Ave' order by created_at limit 1),
       0
where not exists (select 1 from block where name = 'Paice Ave');

update property
   set block_id = (select id from block where name = 'Paice Ave')
 where block_id is null;

alter table block enable row level security;
create policy "public read active blocks" on block
  for select to anon, authenticated using (active);
grant select on block to anon, authenticated;
grant all on block to service_role;

-- ---------------------------------------------------------------------
--  2. Who is the operator, and which blocks a warden may work
-- ---------------------------------------------------------------------
alter table host add column if not exists is_operator boolean not null default false;

update host set is_operator = true
 where id = (select host_id from property where name = '86 Paice Ave'
             order by created_at limit 1);

-- 'all' sees every block (Andrew); 'blocks' sees only what
-- staff_block_access grants. A warden with every grant switched off sees
-- nothing — it never falls back to 'all'.
alter table host_user
  add column if not exists scope text not null default 'all'
  constraint host_user_scope_check check (scope in ('all', 'blocks'));

create table if not exists staff_block_access (
  host_user_id uuid not null references host_user(id) on delete cascade,
  block_id     uuid not null references block(id) on delete cascade,
  active       boolean not null default true,
  granted_at   timestamptz not null default now(),
  primary key (host_user_id, block_id)
);

comment on table staff_block_access is
  'Which blocks a warden may see and work on the gate screen. Set active = '
  'false to switch access off without losing the record.';

alter table staff_block_access enable row level security;
revoke all on staff_block_access from anon, authenticated;
grant all on staff_block_access to service_role;

-- ---------------------------------------------------------------------
--  3. A site is not on sale until it is confirmed for the event
-- ---------------------------------------------------------------------
alter table event_offer
  add column if not exists status text not null default 'confirmed'
  constraint event_offer_status_check check (status in ('pending', 'confirmed', 'paused'));

-- ---------------------------------------------------------------------
--  4. Where the car went, and who put it there
-- ---------------------------------------------------------------------
alter table booking
  add column if not exists booked_property_id uuid references property(id) on delete set null,
  add column if not exists checked_in_by      uuid references host_user(id) on delete set null,
  add column if not exists cash_collected_by  uuid references host_user(id) on delete set null;

update booking set booked_property_id = property_id where booked_property_id is null;

comment on column booking.property_id is
  'Where the car is: set at booking, updated at check-in if the warden puts it elsewhere.';
comment on column booking.booked_property_id is
  'Where the system put the booking before the night. Never changed by check-in.';

-- ---------------------------------------------------------------------
--  5. hold_booking: a plate is required; online needs a confirmed site
-- ---------------------------------------------------------------------
create or replace function public.hold_booking(
  p_event_id uuid, p_property_id uuid, p_tier_code text, p_email text,
  p_name text default null, p_phone text default null, p_rego text default null,
  p_hold_minutes integer default 30, p_channel text default 'online',
  p_accepts_street boolean default false, p_payment_method text default 'stripe',
  p_low_clearance boolean default false)
 returns uuid
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_tier    offer_tier%rowtype;
  v_close   timestamptz;
  v_share   numeric(5,4);
  v_platform int;
  v_booking_id uuid;
  v_sold    integer;
  v_online  integer;
  v_offer_status text;
begin
  -- Every car is found by its plate on the night. No plate, no booking.
  if coalesce(trim(p_rego), '') = '' then
    raise exception 'PLATE_REQUIRED: a number plate is needed for every booking'
      using errcode = 'check_violation';
  end if;

  -- for update of t: the lock is on the tier row, not the joined event.
  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active
     for update of t;
  if not found then
    raise exception 'No active tier "%" for that event and property', p_tier_code;
  end if;

  select o.status into v_offer_status from event_offer o
   where o.event_id = p_event_id and o.property_id = p_property_id;

  if p_channel <> 'gate' and v_offer_status <> 'confirmed' then
    raise exception 'SITE_NOT_CONFIRMED: that site is not on sale online for this event'
      using errcode = 'check_violation';
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
    event_id, property_id, booked_property_id, tier_code, customer_email, customer_name,
    customer_phone, vehicle_rego, vehicle_low_clearance, amount_cents,
    arrival_from, arrival_until, must_depart_by,
    platform_fee_cents, host_earnings_cents,
    channel, payment_method, accepts_street_parking, status, hold_expires_at
  ) values (
    p_event_id, p_property_id, p_property_id, v_tier.code, p_email, p_name,
    p_phone, upper(trim(p_rego)), coalesce(p_low_clearance, false), v_tier.price_cents,
    v_tier.arrival_from, v_tier.arrival_until, v_tier.departure_by,
    v_platform, v_tier.price_cents - v_platform,
    p_channel, p_payment_method, p_accepts_street, 'held',
    now() + make_interval(mins => p_hold_minutes)
  ) returning id into v_booking_id;

  return v_booking_id;
end;
$function$;

-- ---------------------------------------------------------------------
--  6. check_in_booking: record the site and the warden
-- ---------------------------------------------------------------------
create or replace function public.check_in_booking_at(
  p_booking_id uuid,
  p_property_id uuid default null,
  p_by uuid default null)
 returns void
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_current uuid;
begin
  select property_id into v_current from booking
   where id = p_booking_id and status in ('paid', 'held');
  if not found then
    return;
  end if;

  -- The site must be part of this event. Bay allocations at the old site
  -- are left as they are: since tiers became counts, bays no longer decide
  -- availability, and the allocation is a record of the plan, not the night.
  if p_property_id is not null and p_property_id <> v_current then
    if not exists (
      select 1 from event_offer o join booking b on b.event_id = o.event_id
       where b.id = p_booking_id and o.property_id = p_property_id
    ) then
      raise exception 'SITE_NOT_IN_EVENT: that site is not part of this event'
        using errcode = 'check_violation';
    end if;
  end if;

  update booking
     set checked_in_at = coalesce(checked_in_at, now()),
         property_id   = coalesce(p_property_id, property_id),
         checked_in_by = coalesce(checked_in_by, p_by)
   where id = p_booking_id;
end;
$function$;

-- ---------------------------------------------------------------------
--  7. Choosing a site within a block, and what the booking page reads
-- ---------------------------------------------------------------------
create or replace function public.pick_block_property(
  p_event_id uuid, p_block_id uuid, p_tier_code text)
 returns uuid
 language sql
 stable
 set search_path to 'public'
as $function$
  select a.property_id
    from v_tier_availability a
    join property p on p.id = a.property_id and p.active
    join event_offer o on o.event_id = a.event_id and o.property_id = a.property_id
    join block bl on bl.id = p.block_id
   where a.event_id = p_event_id
     and p.block_id = p_block_id
     and a.code = p_tier_code
     and o.status = 'confirmed'
     and a.spots_left > 0
   order by (a.property_id = bl.anchor_property_id) desc,
            a.spots_left desc,
            p.name
   limit 1;
$function$;

create or replace view v_block_tier_availability
with (security_invoker = true) as
select a.event_id,
       bl.id                    as block_id,
       bl.name                  as block_name,
       anchor.address           as anchor_address,
       anchor.name              as anchor_name,
       bl.lat, bl.lng,
       a.code,
       -- One label, price and window per type: the anchor's if it sells it,
       -- otherwise the first site's. Prices are set collectively per block.
       (array_agg(a.label         order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as label,
       (array_agg(a.price_cents   order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as price_cents,
       (array_agg(a.arrival_from  order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as arrival_from,
       (array_agg(a.arrival_until order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as arrival_until,
       min(a.sort_order)        as sort_order,
       sum(a.spots_left)::integer as spots_left,
       bl.sort_order            as block_sort
  from v_tier_availability a
  join property p     on p.id = a.property_id and p.active
  join block bl       on bl.id = p.block_id and bl.active
  join event_offer o  on o.event_id = a.event_id and o.property_id = a.property_id
  left join property anchor on anchor.id = bl.anchor_property_id
 where o.status = 'confirmed'
 group by a.event_id, bl.id, bl.name, anchor.address, anchor.name, bl.lat, bl.lng,
          a.code, bl.sort_order;

comment on view v_block_tier_availability is
  'One row per event, block and type of space: what the booking page sells. '
  'spots_left is the online count summed over the block''s confirmed sites.';

grant select on v_block_tier_availability to anon, authenticated;
revoke all on function public.pick_block_property(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pick_block_property(uuid, uuid, text) to service_role;
revoke all on function public.check_in_booking_at(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.check_in_booking_at(uuid, uuid, uuid) to service_role;
