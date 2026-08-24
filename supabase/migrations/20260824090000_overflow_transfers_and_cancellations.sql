-- =====================================================================
--  Talli Parking — cancelling a booking, and sending a car somewhere else
--
--  Two jobs the gate screen could not do before.
--
--  1. Cancel a booking, with or without money going back. Rare, and bad
--     to do by accident, so it is audited: every cancellation writes a row
--     saying who lost their space, why, and what was refunded.
--
--  2. Send a car to an overflow AREA THAT IS NOT OURS TO PARK. This is not
--     the same thing as moving someone onto our own verge — that is
--     reassign_booking and it stays as it is. A transfer hands the car to
--     another address: the space here goes back on sale, they park there,
--     and we book a referral fee for the introduction.
--
--     The two ideas are deliberately kept apart:
--       booking.accepts_street_parking  — "I don't mind an overflow spot"
--       booking_transfer                — "this car actually went to X"
--     Agreeing to the first has never been permission for the second, so a
--     transfer always records a fresh, explicit yes.
--
--  Every destination carries its own limit, because the whole point of an
--  overflow is that it is somebody else's driveway and they decide how many
--  cars they will take tonight.
-- =====================================================================

-- ------------------------------------------------------- the destinations

create table if not exists public.overflow_site (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  address            text,
  walk_minutes       integer check (walk_minutes >= 0),
  contact_name       text,
  contact_phone      text,

  -- What the driver pays when they get there. Only used for the sentence
  -- said on the driveway: "it's $10, five minutes further out."
  their_price_cents  integer check (their_price_cents >= 0),

  -- What we earn for the introduction. Snapshotted onto each transfer, so
  -- changing the deal later does not rewrite last month's nights.
  referral_fee_cents integer not null default 0 check (referral_fee_cents >= 0),

  -- true  — they take the money at their gate, so what was paid here
  --         normally goes back.
  -- false — we run it ourselves (the berm), the money stays put.
  customer_pays_site boolean not null default true,

  -- The standing limit. How many cars they will take on an ordinary night.
  default_spots      integer not null default 0 check (default_spots >= 0),

  notes              text,
  active             boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now()
);

comment on table public.overflow_site is
  'Places a car can be sent instead of parking here. Ours or somebody else''s.';

alter table public.overflow_site enable row level security;

-- Tonight only. A neighbour who normally takes three cars has people over
-- and will take one, or none at all.
create table if not exists public.event_overflow_limit (
  event_id  uuid not null references public.event(id) on delete cascade,
  site_id   uuid not null references public.overflow_site(id) on delete cascade,
  spots     integer check (spots >= 0),          -- null falls back to default_spots
  open      boolean not null default true,
  note      text,
  updated_at timestamptz not null default now(),
  primary key (event_id, site_id)
);

alter table public.event_overflow_limit enable row level security;

-- ---------------------------------------------------------- the transfers

create table if not exists public.booking_transfer (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null references public.booking(id) on delete cascade,
  event_id           uuid not null references public.event(id),
  site_id            uuid not null references public.overflow_site(id),
  transferred_at     timestamptz not null default now(),
  undone_at          timestamptz,
  reason             text,
  referral_fee_cents integer not null default 0 check (referral_fee_cents >= 0),
  refund_cents       integer not null default 0 check (refund_cents >= 0),
  stripe_refund_id   text,
  -- Was the overflow box already ticked when they booked? Kept apart from
  -- the yes given at the gate, which is the one that authorises the move.
  had_prior_consent  boolean not null default false,
  previous_status    text not null,
  created_at         timestamptz not null default now()
);

alter table public.booking_transfer enable row level security;

-- A car can only be in one other driveway at a time.
create unique index if not exists booking_transfer_one_live
  on public.booking_transfer (booking_id) where undone_at is null;

create index if not exists booking_transfer_event_site
  on public.booking_transfer (event_id, site_id) where undone_at is null;

-- ------------------------------------------------------- the cancellations

create table if not exists public.booking_cancellation (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references public.booking(id) on delete cascade,
  event_id         uuid not null references public.event(id),
  cancelled_at     timestamptz not null default now(),
  previous_status  text not null,
  reason           text,
  refund_cents     integer not null default 0 check (refund_cents >= 0),
  refund_method    text not null default 'none'
                     check (refund_method in ('none','stripe','cash','bank_transfer','other')),
  stripe_refund_id text,
  note             text
);

alter table public.booking_cancellation enable row level security;

-- A booking that has been sent elsewhere is neither still ours nor gone.
alter table public.booking drop constraint if exists booking_status_check;
alter table public.booking add constraint booking_status_check
  check (status = any (array['held','paid','cancelled','expired','refunded','no_show','transferred']));

-- ----------------------------------------------------------------- views

-- Tonight, per destination: the limit, how many have gone, what is left.
create or replace view public.v_overflow_site_status as
  select
    e.id                                        as event_id,
    s.id                                        as site_id,
    s.code,
    s.name,
    s.address,
    s.walk_minutes,
    s.contact_name,
    s.contact_phone,
    s.their_price_cents,
    s.referral_fee_cents,
    s.customer_pays_site,
    s.notes,
    s.sort_order,
    coalesce(l.spots, s.default_spots)::integer as spots,
    coalesce(l.open, true)                      as open,
    coalesce(t.sent, 0)::integer                as sent,
    greatest(coalesce(l.spots, s.default_spots) - coalesce(t.sent, 0), 0)::integer as spots_left,
    coalesce(t.referral_cents, 0)::integer      as referral_cents,
    coalesce(t.refund_cents, 0)::integer        as refunded_cents,
    (l.event_id is not null)                    as limit_set_tonight
  from public.event e
  cross join public.overflow_site s
  left join public.event_overflow_limit l
    on l.event_id = e.id and l.site_id = s.id
  left join lateral (
    select count(*)                       as sent,
           sum(bt.referral_fee_cents)     as referral_cents,
           sum(bt.refund_cents)           as refund_cents
      from public.booking_transfer bt
     where bt.event_id = e.id and bt.site_id = s.id and bt.undone_at is null
  ) t on true
  where s.active;

-- The arrivals list, now carrying where a car went if it went anywhere, and
-- saying plainly whether its bay is in a consent zone rather than leaving the
-- screen to guess from the label.
-- Columns are inserted in the middle, so this is a drop and rebuild.
-- Nothing else in the schema selects from it.
drop view if exists public.v_gate_list;
create view public.v_gate_list as
  select
    b.event_id,
    e.name as event_name,
    b.id as booking_id,
    b.customer_name,
    b.customer_phone,
    b.customer_email,
    b.vehicle_rego,
    b.tier_code,
    i.zone_label,
    i.bay_label,
    i.exit_class,
    coalesce(i.requires_consent, false) as in_consent_zone,
    b.arrival_from,
    b.arrival_until,
    b.must_depart_by,
    b.accepts_street_parking,
    b.channel,
    b.payment_method,
    b.status,
    b.checked_in_at,
    (b.checked_in_at is not null) as arrived,
    b.amount_cents,
    b.notes,
    b.stripe_payment_intent_id is not null as refundable_by_card,
    tr.site_id        as transfer_site_id,
    tr.site_name      as transfer_site_name,
    tr.transferred_at as transferred_at,
    coalesce(tr.refund_cents, 0)::integer as transfer_refund_cents,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', ba.code, 'name', ba.name, 'qty', ba.qty,
               'handed', (ba.handed_over_at is not null)) order by ba.code)
        from booking_addon ba where ba.booking_id = b.id), '[]'::jsonb) as addons,
    b.addons_cents,
    (select count(*)::integer from booking_addon ba
      where ba.booking_id = b.id and ba.handed_over_at is null) as addons_pending
  from booking b
  join event e on e.id = b.event_id
  left join bay_allocation a on a.booking_id = b.id and a.role = 'occupied'
  left join v_bay_inventory i on i.bay_id = a.bay_id and i.event_id = b.event_id
  left join lateral (
    select bt.site_id, os.name as site_name, bt.transferred_at, bt.refund_cents
      from public.booking_transfer bt
      join public.overflow_site os on os.id = bt.site_id
     where bt.booking_id = b.id and bt.undone_at is null
     limit 1
  ) tr on true
  where b.status = any (array['paid','held','transferred']);

-- Nothing here is public. The gate function reads it under the service role.
revoke all on public.overflow_site, public.event_overflow_limit,
              public.booking_transfer, public.booking_cancellation,
              public.v_overflow_site_status
  from anon, authenticated;

-- ------------------------------------------------------------------ rpcs

-- Send a car somewhere else. Frees the bay, records the introduction, and
-- refuses to go past the destination's limit for tonight.
create or replace function public.transfer_booking_to_site(
  p_booking_id        uuid,
  p_site_id           uuid,
  p_reason            text    default null,
  p_refund_cents      integer default 0,
  p_consent_confirmed boolean default false,
  p_stripe_refund_id  text    default null
) returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_b booking%rowtype;
  v_s overflow_site%rowtype;
  v_spots integer;
  v_open boolean;
  v_sent integer;
  v_paid integer;
  v_id uuid;
begin
  select * into v_b from booking where id = p_booking_id for update;
  if not found then
    raise exception 'NO_SUCH_BOOKING: that booking is gone' using errcode = 'no_data_found';
  end if;

  if v_b.status not in ('paid','held') then
    raise exception 'NOT_TRANSFERABLE: this booking is %, so there is nothing to send',
      v_b.status using errcode = 'check_violation';
  end if;

  if exists (select 1 from booking_transfer
              where booking_id = p_booking_id and undone_at is null) then
    raise exception 'ALREADY_TRANSFERRED: this car has already been sent somewhere'
      using errcode = 'unique_violation';
  end if;

  select * into v_s from overflow_site where id = p_site_id and active;
  if not found then
    raise exception 'NO_SUCH_SITE: that overflow area is not switched on'
      using errcode = 'no_data_found';
  end if;

  -- Ticking "I don't mind an overflow spot" when booking is not agreement to
  -- drive to a different address. Somebody has to have asked, just now.
  if not coalesce(p_consent_confirmed, false) then
    raise exception 'CONSENT_REQUIRED: nobody has agreed to send this car to %', v_s.name
      using errcode = 'check_violation';
  end if;

  select coalesce(l.spots, v_s.default_spots), coalesce(l.open, true)
    into v_spots, v_open
    from (select 1) x
    left join event_overflow_limit l
      on l.event_id = v_b.event_id and l.site_id = v_s.id;

  if not v_open then
    raise exception 'SITE_CLOSED: % is closed tonight', v_s.name
      using errcode = 'check_violation';
  end if;

  select count(*) into v_sent from booking_transfer
   where event_id = v_b.event_id and site_id = v_s.id and undone_at is null;

  if v_sent >= v_spots then
    raise exception 'SITE_FULL: % will take % tonight and % have gone',
      v_s.name, v_spots, v_sent using errcode = 'check_violation';
  end if;

  v_paid := coalesce(v_b.amount_cents, 0) + coalesce(v_b.addons_cents, 0);
  if coalesce(p_refund_cents, 0) > v_paid then
    raise exception 'REFUND_TOO_BIG: they only paid %', v_paid using errcode = 'check_violation';
  end if;

  -- The space goes straight back on sale. That is the whole reason to do this
  -- when there is a queue at the gate.
  delete from bay_allocation where booking_id = p_booking_id;

  insert into booking_transfer (
    booking_id, event_id, site_id, reason, referral_fee_cents,
    refund_cents, stripe_refund_id, had_prior_consent, previous_status)
  values (
    p_booking_id, v_b.event_id, v_s.id, nullif(btrim(coalesce(p_reason, '')), ''),
    v_s.referral_fee_cents, coalesce(p_refund_cents, 0), p_stripe_refund_id,
    coalesce(v_b.accepts_street_parking, false), v_b.status)
  returning id into v_id;

  update booking set status = 'transferred' where id = p_booking_id;

  return v_id;
end;
$$;

-- They came back, or the neighbour changed their mind. Put the car back in
-- the yard if there is anywhere to put it.
create or replace function public.undo_booking_transfer(p_booking_id uuid)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_t booking_transfer%rowtype;
  v_b booking%rowtype;
  v_bay uuid;
begin
  select * into v_t from booking_transfer
   where booking_id = p_booking_id and undone_at is null for update;
  if not found then
    raise exception 'NO_TRANSFER: this car has not been sent anywhere'
      using errcode = 'no_data_found';
  end if;

  select * into v_b from booking where id = p_booking_id for update;

  update booking_transfer set undone_at = now() where id = v_t.id;
  update booking set status = v_t.previous_status where id = p_booking_id;

  -- Best free bay going: somewhere they did not have to agree to first,
  -- and out of the valet lane, which is a key-holding arrangement.
  select i.bay_id into v_bay
    from v_bay_inventory i
   where i.event_id = v_t.event_id
     and i.available
     and not i.keys_held
     and (not i.requires_consent or coalesce(v_b.accepts_street_parking, false))
   order by i.requires_consent, i.exit_rank desc, i.bay_label
   limit 1;

  if v_bay is not null then
    perform reassign_booking(p_booking_id, v_bay);
  end if;

  return v_bay;
end;
$$;

-- Cancel, with or without money going back. Always leaves a paper trail.
create or replace function public.cancel_booking_admin(
  p_booking_id       uuid,
  p_reason           text    default null,
  p_refund_cents     integer default 0,
  p_refund_method    text    default 'none',
  p_stripe_refund_id text    default null,
  p_note             text    default null
) returns text
language plpgsql
set search_path to 'public'
as $$
declare
  v_b booking%rowtype;
  v_paid integer;
  v_status text;
begin
  select * into v_b from booking where id = p_booking_id for update;
  if not found then
    raise exception 'NO_SUCH_BOOKING: that booking is gone' using errcode = 'no_data_found';
  end if;

  if v_b.status in ('cancelled','refunded','expired') then
    raise exception 'ALREADY_GONE: this booking is already %', v_b.status
      using errcode = 'check_violation';
  end if;

  v_paid := coalesce(v_b.amount_cents, 0) + coalesce(v_b.addons_cents, 0);
  if coalesce(p_refund_cents, 0) > v_paid then
    raise exception 'REFUND_TOO_BIG: they only paid %', v_paid using errcode = 'check_violation';
  end if;

  -- If the car had been sent to a neighbour, that slot comes back to them.
  update booking_transfer set undone_at = now()
   where booking_id = p_booking_id and undone_at is null;

  delete from bay_allocation where booking_id = p_booking_id;

  v_status := case when coalesce(p_refund_cents, 0) > 0 then 'refunded' else 'cancelled' end;

  update booking
     set status = v_status,
         hold_expires_at = null,
         checked_in_at = null
   where id = p_booking_id;

  insert into booking_cancellation (
    booking_id, event_id, previous_status, reason,
    refund_cents, refund_method, stripe_refund_id, note)
  values (
    p_booking_id, v_b.event_id, v_b.status,
    nullif(btrim(coalesce(p_reason, '')), ''),
    coalesce(p_refund_cents, 0), coalesce(p_refund_method, 'none'),
    p_stripe_refund_id, nullif(btrim(coalesce(p_note, '')), ''));

  return v_status;
end;
$$;

-- Tonight's limit for one destination. Nothing here touches the standing
-- arrangement in overflow_site.default_spots.
create or replace function public.set_event_overflow_limit(
  p_event_id uuid,
  p_site_id  uuid,
  p_spots    integer default null,
  p_open     boolean default null,
  p_note     text    default null
) returns integer
language plpgsql
set search_path to 'public'
as $$
declare
  v_default integer;
  v_spots integer;
  v_open boolean;
begin
  select default_spots into v_default from overflow_site where id = p_site_id and active;
  if not found then
    raise exception 'NO_SUCH_SITE: that overflow area is not switched on'
      using errcode = 'no_data_found';
  end if;

  select coalesce(l.spots, v_default), coalesce(l.open, true)
    into v_spots, v_open
    from (select 1) x
    left join event_overflow_limit l
      on l.event_id = p_event_id and l.site_id = p_site_id;

  v_spots := coalesce(p_spots, v_spots);
  v_open  := coalesce(p_open, v_open);

  if v_spots < 0 or v_spots > 200 then
    raise exception 'BAD_LIMIT: a limit of % is not a real number of cars', v_spots
      using errcode = 'check_violation';
  end if;

  insert into event_overflow_limit (event_id, site_id, spots, open, note, updated_at)
  values (p_event_id, p_site_id, v_spots, v_open, p_note, now())
  on conflict (event_id, site_id) do update
    set spots = excluded.spots,
        open = excluded.open,
        note = coalesce(excluded.note, event_overflow_limit.note),
        updated_at = now();

  return v_spots;
end;
$$;
