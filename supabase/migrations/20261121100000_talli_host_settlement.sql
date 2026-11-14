-- =====================================================================
--  Host settlement (plan B7, § 3.11).
--
--  Per night and per block, from the night's totals:
--
--    Parking pool = parking takings less refunds, not counting extras or
--                   card surcharges. 30% Talli, 20% wardens, 50% hosts.
--    A host's part of the 50% = their spaces provided ÷ the block's.
--                   Spaces provided = the spaces a site was confirmed for
--                   that night, filled or not, less spaces recorded as
--                   lost (B5's lost_space).
--    Extras pool  = extras takings less refunds. 10% wardens, 90% Talli.
--    Card surcharges are Talli's, outside both pools.
--
--  Arrival order, where a car was placed, and what price that buyer paid
--  change nothing a host is owed: takings are pooled for the block, and
--  the hosts' half is shared by spaces, never by cars.
--
--  Rounding (Andrew, 14 Nov 2026): the wardens' amount and the hosts'
--  pool are each rounded down to the cent; the hosts' pool is shared by
--  largest remainders, so the host lines add up to it exactly; Talli has
--  what is left. Every block's shares add up to its takings to the cent.
--
--  What this adds:
--
--    1. settlement_setting — the percentages, as basis points. Settings,
--       not constants: the values in force are stored with each settled
--       night.
--    2. booking.refunded_cents — what Stripe has given back on a booking
--       still paid (a partial refund). A full refund was, and still is,
--       status 'refunded', which counts for nothing on its night. Refunds
--       come out of parking first, then extras, then the surcharge.
--    3. host.payout_notes, and save_host_details() for a real email.
--    4. night_site_spaces — "spaces provided" per site, snapshotted when
--       the night closes (a trigger on event.status), so a later change
--       to a site's defaults cannot rewrite a settled night.
--    5. warden_allocation — Andrew's split of the wardens' amount, with
--       who set it. Must add up to the amount.
--    6. night_settlement — a settled night and block: the percentages in
--       force, the figures as settled, who settled it. Can be reopened.
--    7. settlement_report(), save_warden_allocation(), settle_night(),
--       reopen_settlement(), save_settlement_setting().
--
--  booking.host_earnings_cents, booking.platform_fee_cents and
--  host.platform_share are not read by anything here. The booking paths
--  that write the first two at hold time are left as they are, columns
--  and all: nothing reads them for money any more.
--
--  Additive: new tables, new columns, new functions. Nothing restated.
-- =====================================================================

-- ------------------------------------------------------ 1. the percentages

create table if not exists settlement_setting (
  id                  boolean primary key default true check (id),
  talli_parking_bps   integer not null default 3000 check (talli_parking_bps between 0 and 10000),
  warden_parking_bps  integer not null default 2000 check (warden_parking_bps between 0 and 10000),
  host_parking_bps    integer not null default 5000 check (host_parking_bps between 0 and 10000),
  warden_extras_bps   integer not null default 1000 check (warden_extras_bps between 0 and 10000),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references host_user(id) on delete set null,
  constraint settlement_parking_adds_up
    check (talli_parking_bps + warden_parking_bps + host_parking_bps = 10000)
);

comment on table settlement_setting is
  'How a block''s takings are split (plan B7), in basis points. Parking: '
  'Talli / wardens / hosts, adding up to 10000. Extras: wardens, Talli has '
  'the rest. One row. Each settled night keeps its own copy.';

insert into settlement_setting (id) values (true) on conflict (id) do nothing;

alter table settlement_setting enable row level security;
revoke all on settlement_setting from public, anon, authenticated;
grant all on settlement_setting to service_role;

-- ------------------------------------------------------ 2. partial refunds

alter table booking add column if not exists refunded_cents integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'booking'::regclass
                    and conname = 'booking_refunded_cents_check') then
    alter table booking add constraint booking_refunded_cents_check
      check (refunded_cents >= 0);
  end if;
end $$;

comment on column booking.refunded_cents is
  'Money given back on this booking so far, in cents (plan B7). Set by '
  'stripe-webhook from charge.amount_refunded. A full refund also makes the '
  'booking ''refunded''. Settlement takes it off parking, then extras, then '
  'the card surcharge, on the night the booking was for.';

-- Stripe reports the running total refunded on a charge, so this sets the
-- figure rather than adding to it, and replaying an event changes nothing.
create or replace function public.record_refund(p_booking_id uuid, p_refunded_cents integer)
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare v integer;
begin
  if p_refunded_cents is null or p_refunded_cents < 0 then
    raise exception 'BAD_AMOUNT: a refund is a number of cents' using errcode = 'check_violation';
  end if;
  update booking
     set refunded_cents = least(p_refunded_cents,
                                amount_cents + addons_cents + surcharge_cents)
   where id = p_booking_id
  returning refunded_cents into v;
  return v;
end;
$function$;

revoke all on function public.record_refund(uuid, integer) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, integer) to service_role;

-- ------------------------------------------------------ 3. host details

alter table host add column if not exists payout_notes text;

comment on column host.payout_notes is
  'How this host is paid: bank account, who to ask (plan B7). For Andrew''s '
  'eyes on the settlement screen. Not used by any payment.';

-- A real email, a phone and payout notes. Absent keys are left alone; an
-- empty phone or notes clears it. create_site and add_site write a
-- placeholder host+…@talli.co.nz until this is done.
create or replace function public.save_host_details(p_host_id uuid, p_details jsonb)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(p_details ->> 'email'), '');
  h host%rowtype;
begin
  select * into h from host where id = p_host_id;
  if not found then
    raise exception 'NO_HOST: no such host' using errcode = 'check_violation';
  end if;
  if p_details ? 'email' then
    if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'BAD_EMAIL: that is not an email address' using errcode = 'check_violation';
    end if;
  end if;

  update host set
    email        = case when p_details ? 'email' then lower(v_email) else email end,
    phone        = case when p_details ? 'phone'
                        then nullif(btrim(p_details ->> 'phone'), '') else phone end,
    payout_notes = case when p_details ? 'payout_notes'
                        then nullif(btrim(p_details ->> 'payout_notes'), '') else payout_notes end
   where id = p_host_id
  returning * into h;

  return jsonb_build_object('host_id', h.id, 'name', h.name, 'email', h.email,
                            'phone', h.phone, 'payout_notes', h.payout_notes);
end;
$function$;

revoke all on function public.save_host_details(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_host_details(uuid, jsonb) to service_role;

-- ------------------------------------------------------ 4. spaces provided

create table if not exists night_site_spaces (
  event_id          uuid not null references event(id) on delete cascade,
  property_id       uuid not null references property(id) on delete restrict,
  block_id          uuid references block(id) on delete restrict,
  host_id           uuid references host(id) on delete restrict,
  confirmed_spaces  integer not null check (confirmed_spaces >= 0),
  lost_spaces       integer not null check (lost_spaces >= 0),
  provided          integer generated always as (greatest(confirmed_spaces - lost_spaces, 0)) stored,
  taken_at          timestamptz not null default now(),
  primary key (event_id, property_id)
);

comment on table night_site_spaces is
  'Spaces each site provided on a night (plan B7): confirmed for the night, '
  'less lost. Taken when the night is closed or cancelled, with the site''s '
  'block and host as they were, so a later change to a site cannot rewrite '
  'a settled night. Retaken if the night is closed again, except for a '
  'block already settled.';

alter table night_site_spaces enable row level security;
revoke all on night_site_spaces from public, anon, authenticated;
grant all on night_site_spaces to service_role;

-- What each site provides as things stand: the spaces of every type on
-- sale at a site confirmed for the night, less those lost and not undone.
create or replace function private.site_spaces_now(p_event_id uuid)
returns table (property_id uuid, block_id uuid, host_id uuid,
               confirmed_spaces integer, lost_spaces integer)
language sql
stable security definer
set search_path to 'public'
as $function$
  select o.property_id, p.block_id, p.host_id,
         coalesce((select sum(greatest(coalesce(t.capacity, 0), 0))
                     from offer_tier t
                    where t.event_offer_id = o.id and t.active), 0)::integer,
         (select count(*) from lost_space l
           where l.event_id = o.event_id and l.property_id = o.property_id
             and l.undone_at is null)::integer
    from event_offer o
    join property p on p.id = o.property_id
   where o.event_id = p_event_id
     and o.status = 'confirmed';
$function$;

revoke all on function private.site_spaces_now(uuid) from public, anon, authenticated;
grant execute on function private.site_spaces_now(uuid) to service_role;

-- ------------------------------------------------------ 5 & 6. allocation, settled nights

create table if not exists warden_allocation (
  event_id      uuid not null references event(id) on delete cascade,
  block_id      uuid not null references block(id) on delete restrict,
  host_user_id  uuid not null references host_user(id) on delete restrict,
  amount_cents  integer not null check (amount_cents >= 0),
  set_by        uuid references host_user(id) on delete set null,
  set_at        timestamptz not null default now(),
  primary key (event_id, block_id, host_user_id)
);

comment on table warden_allocation is
  'Andrew''s split of a block''s wardens'' amount for a night (plan B7), and '
  'who set it. Saved whole, and only when it adds up to the amount.';

alter table warden_allocation enable row level security;
revoke all on warden_allocation from public, anon, authenticated;
grant all on warden_allocation to service_role;

create table if not exists night_settlement (
  event_id            uuid not null references event(id) on delete cascade,
  block_id            uuid not null references block(id) on delete restrict,
  is_settled          boolean not null default true,
  talli_parking_bps   integer not null,
  warden_parking_bps  integer not null,
  host_parking_bps    integer not null,
  warden_extras_bps   integer not null,
  figures             jsonb not null,
  settled_at          timestamptz not null default now(),
  settled_by          uuid references host_user(id) on delete set null,
  reopened_at         timestamptz,
  reopened_by         uuid references host_user(id) on delete set null,
  primary key (event_id, block_id)
);

comment on table night_settlement is
  'A night and block that Andrew has settled (plan B7): the percentages in '
  'force and the figures as they stood, frozen. Reopening sets is_settled '
  'false and keeps who settled it until it is settled again.';

alter table night_settlement enable row level security;
revoke all on night_settlement from public, anon, authenticated;
grant all on night_settlement to service_role;

create or replace function private.block_settled(p_event_id uuid, p_block_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from night_settlement s
                  where s.event_id = p_event_id and s.block_id = p_block_id and s.is_settled);
$function$;

revoke all on function private.block_settled(uuid, uuid) from public, anon, authenticated;
grant execute on function private.block_settled(uuid, uuid) to service_role;

-- The snapshot. Every site of every block not yet settled is (re)taken;
-- a settled block keeps the spaces it was settled on.
create or replace function public.snapshot_night_spaces(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v integer;
begin
  delete from night_site_spaces n
   where n.event_id = p_event_id
     and not private.block_settled(p_event_id, n.block_id);

  insert into night_site_spaces (event_id, property_id, block_id, host_id,
                                 confirmed_spaces, lost_spaces)
  select p_event_id, s.property_id, s.block_id, s.host_id, s.confirmed_spaces, s.lost_spaces
    from private.site_spaces_now(p_event_id) s
   where not private.block_settled(p_event_id, s.block_id)
  on conflict (event_id, property_id) do nothing;

  get diagnostics v = row_count;
  return v;
end;
$function$;

revoke all on function public.snapshot_night_spaces(uuid) from public, anon, authenticated;
grant execute on function public.snapshot_night_spaces(uuid) to service_role;

-- When a night closes (or is cancelled), however it gets there: the
-- Event tab's set_event_status, the dashboard, or SQL.
create or replace function private.snapshot_on_close()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status in ('closed', 'cancelled')
     and new.status is distinct from old.status then
    perform public.snapshot_night_spaces(new.id);
  end if;
  return new;
end;
$function$;

drop trigger if exists event_snapshot_on_close on event;
create trigger event_snapshot_on_close
  after update of status on event
  for each row execute function private.snapshot_on_close();

-- ------------------------------------------------------ 7. the arithmetic

-- Each booking that took money on the night, by block, with refunds taken
-- off parking first, then extras, then the surcharge. A free walk-up took
-- nothing; a fully refunded booking gave it all back.
create or replace function private.settlement_lines(p_event_id uuid)
returns table (booking_id uuid, block_id uuid, channel text, payment_method text,
               status text, parking_cents bigint, extras_cents bigint,
               surcharge_cents bigint, refund_cents bigint,
               parking_net bigint, extras_net bigint, surcharge_net bigint,
               cash_collected_by uuid, checked_in_by uuid)
language sql
stable security definer
set search_path to 'public'
as $function$
  with b as (
    select bk.id, p.block_id, bk.channel, bk.payment_method, bk.status,
           bk.cash_collected_by, bk.checked_in_by,
           case when bk.payment_method = 'free' then 0 else bk.amount_cents end::bigint     as g_park,
           case when bk.payment_method = 'free' then 0 else bk.addons_cents end::bigint     as g_ext,
           case when bk.payment_method = 'free' then 0 else bk.surcharge_cents end::bigint  as g_sur,
           bk.refunded_cents::bigint as r
      from booking bk
      join property p on p.id = coalesce(bk.booked_property_id, bk.property_id)
     where bk.event_id = p_event_id
       and bk.status in ('paid', 'no_show', 'refunded')
  ), r as (
    select b.*,
           case when b.status = 'refunded' then b.g_park + b.g_ext + b.g_sur
                else least(b.r, b.g_park + b.g_ext + b.g_sur) end as refund
      from b
  )
  select r.id, r.block_id, r.channel, r.payment_method, r.status,
         r.g_park, r.g_ext, r.g_sur, r.refund,
         r.g_park - least(r.refund, r.g_park),
         r.g_ext  - least(greatest(r.refund - r.g_park, 0), r.g_ext),
         r.g_sur  - least(greatest(r.refund - r.g_park - r.g_ext, 0), r.g_sur),
         r.cash_collected_by, r.checked_in_by
    from r;
$function$;

revoke all on function private.settlement_lines(uuid) from public, anon, authenticated;
grant execute on function private.settlement_lines(uuid) to service_role;

-- One block's figures for one night, at the given percentages. The spaces
-- are the snapshot when there is one, and the night as it stands when
-- the night has not closed yet.
create or replace function private.block_figures(
  p_event_id uuid, p_block_id uuid,
  p_talli_parking_bps integer, p_warden_parking_bps integer,
  p_host_parking_bps integer, p_warden_extras_bps integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_park      bigint;
  v_ext       bigint;
  v_sur       bigint;
  v_gross     bigint;
  v_refunds   bigint;
  v_w_park    bigint;
  v_hosts     bigint;
  v_w_ext     bigint;
  v_total_sp  bigint;
  v_hosts_out bigint;
  v_snapshot  boolean;
  v_lines     jsonb;
  v_host_rows jsonb;
  v_cash      jsonb;
begin
  select coalesce(sum(parking_net), 0), coalesce(sum(extras_net), 0),
         coalesce(sum(surcharge_net), 0),
         coalesce(sum(parking_cents + extras_cents + surcharge_cents), 0),
         coalesce(sum(refund_cents), 0)
    into v_park, v_ext, v_sur, v_gross, v_refunds
    from private.settlement_lines(p_event_id) where block_id = p_block_id;

  -- Takings by channel and payment type.
  select coalesce(jsonb_agg(jsonb_build_object(
           'channel', channel, 'payment_method', payment_method, 'bookings', n,
           'parking_cents', park, 'extras_cents', ext, 'surcharge_cents', sur,
           'refund_cents', refund, 'net_cents', park + ext + sur - refund)
           order by channel, payment_method), '[]'::jsonb)
    into v_lines
    from (select channel, payment_method, count(*) as n,
                 sum(parking_cents) as park, sum(extras_cents) as ext,
                 sum(surcharge_cents) as sur, sum(refund_cents) as refund
            from private.settlement_lines(p_event_id)
           where block_id = p_block_id
           group by channel, payment_method) g;

  -- The pools. Wardens and hosts round down; Talli has the rest.
  v_w_park := (v_park * p_warden_parking_bps) / 10000;
  v_hosts  := (v_park * p_host_parking_bps) / 10000;
  v_w_ext  := (v_ext * p_warden_extras_bps) / 10000;

  -- Spaces provided, per site, then per host.
  v_snapshot := exists (select 1 from night_site_spaces
                         where event_id = p_event_id and block_id = p_block_id);

  with sites as (
    select n.property_id, n.host_id, n.confirmed_spaces, n.lost_spaces, n.provided::bigint as provided
      from night_site_spaces n
     where v_snapshot and n.event_id = p_event_id and n.block_id = p_block_id
    union all
    select s.property_id, s.host_id, s.confirmed_spaces, s.lost_spaces,
           greatest(s.confirmed_spaces - s.lost_spaces, 0)::bigint
      from private.site_spaces_now(p_event_id) s
     where not v_snapshot and s.block_id = p_block_id
  ), hosts as (
    select s.host_id, sum(s.provided)::bigint as spaces,
           jsonb_agg(jsonb_build_object('property_id', s.property_id, 'name', p.name,
                     'confirmed', s.confirmed_spaces, 'lost', s.lost_spaces,
                     'provided', s.provided) order by p.name) as sites
      from sites s join property p on p.id = s.property_id
     group by s.host_id
  ), total as (
    select coalesce(sum(spaces), 0)::bigint as t from hosts
  ), shares as (
    select h.host_id, h.spaces, h.sites,
           case when t.t > 0 then (v_hosts * h.spaces) / t.t else 0 end as base,
           case when t.t > 0 then (v_hosts * h.spaces) % t.t else 0 end as rem
      from hosts h, total t
  ), ranked as (
    select sh.*, row_number() over (order by sh.rem desc, ho.name, sh.host_id) as rn,
           ho.name, ho.email, ho.payout_notes
      from shares sh left join host ho on ho.id = sh.host_id
  ), leftover as (
    select case when (select t from total) > 0
                then v_hosts - coalesce((select sum(base) from shares), 0)::bigint else 0 end as cents
  )
  select (select t from total),
         coalesce(jsonb_agg(jsonb_build_object(
           'host_id', r.host_id, 'name', r.name, 'email', r.email,
           'payout_notes', r.payout_notes, 'spaces', r.spaces,
           'amount_cents', r.base + case when r.rn <= l.cents then 1 else 0 end,
           'sites', r.sites) order by r.name, r.host_id), '[]'::jsonb),
         coalesce(sum(r.base + case when r.rn <= l.cents then 1 else 0 end), 0)
    into v_total_sp, v_host_rows, v_hosts_out
    from ranked r, leftover l;

  -- Cash each person collected, whatever the pools say: what they are
  -- holding at the end of the night.
  select coalesce(jsonb_agg(jsonb_build_object(
           'host_user_id', c.who, 'email', hu.email, 'bookings', c.n, 'cents', c.cents)
           order by hu.email), '[]'::jsonb)
    into v_cash
    from (select cash_collected_by as who, count(*) as n,
                 sum(parking_net + extras_net + surcharge_net) as cents
            from private.settlement_lines(p_event_id)
           where block_id = p_block_id and payment_method = 'cash'
             and status <> 'refunded'
           group by cash_collected_by) c
    left join host_user hu on hu.id = c.who;

  return jsonb_build_object(
    'gross_cents',     v_gross,
    'refund_cents',    v_refunds,
    'net_cents',       v_park + v_ext + v_sur,
    'parking_cents',   v_park,
    'extras_cents',    v_ext,
    'surcharge_cents', v_sur,
    'takings',         v_lines,
    'parking_pool',    jsonb_build_object(
                         'talli_cents', v_park - v_w_park - v_hosts,
                         'wardens_cents', v_w_park,
                         'hosts_cents', v_hosts),
    'extras_pool',     jsonb_build_object(
                         'talli_cents', v_ext - v_w_ext,
                         'wardens_cents', v_w_ext),
    'wardens_cents',   v_w_park + v_w_ext,
    'hosts_cents',     v_hosts_out,
    -- Everything not owed to a warden or a host: Talli's 30%, the rounding,
    -- 90% of extras, every surcharge, and the hosts' half if no site
    -- provided a space at all.
    'talli_cents',     (v_park + v_ext + v_sur) - (v_w_park + v_w_ext) - v_hosts_out,
    'spaces',          v_total_sp,
    'spaces_source',   case when v_snapshot then 'snapshot' else 'now' end,
    'no_spaces',       v_total_sp = 0 and v_hosts > 0,
    'hosts',           v_host_rows,
    'cash',            v_cash,
    'percent',         jsonb_build_object(
                         'talli_parking_bps', p_talli_parking_bps,
                         'warden_parking_bps', p_warden_parking_bps,
                         'host_parking_bps', p_host_parking_bps,
                         'warden_extras_bps', p_warden_extras_bps));
end;
$function$;

revoke all on function private.block_figures(uuid, uuid, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function private.block_figures(uuid, uuid, integer, integer, integer, integer)
  to service_role;

-- A block's figures at the percentages in force now.
create or replace function private.block_figures_now(p_event_id uuid, p_block_id uuid)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select private.block_figures(p_event_id, p_block_id, s.talli_parking_bps,
           s.warden_parking_bps, s.host_parking_bps, s.warden_extras_bps)
    from settlement_setting s where s.id;
$function$;

revoke all on function private.block_figures_now(uuid, uuid) from public, anon, authenticated;
grant execute on function private.block_figures_now(uuid, uuid) to service_role;

-- The blocks with anything on a night: a site confirmed, a snapshot, a
-- booking, a settlement.
create or replace function private.night_blocks(p_event_id uuid)
returns setof uuid
language sql
stable security definer
set search_path to 'public'
as $function$
  select distinct block_id from (
    select s.block_id from private.site_spaces_now(p_event_id) s
    union all select n.block_id from night_site_spaces n where n.event_id = p_event_id
    union all select l.block_id from private.settlement_lines(p_event_id) l
    union all select ns.block_id from night_settlement ns where ns.event_id = p_event_id
  ) x where block_id is not null;
$function$;

revoke all on function private.night_blocks(uuid) from public, anon, authenticated;
grant execute on function private.night_blocks(uuid) to service_role;

-- ------------------------------------------------------ the report

create or replace function public.settlement_report(p_event_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  e   event%rowtype;
  v_blocks jsonb;
begin
  select * into e from event where id = p_event_id;
  if not found then
    raise exception 'NO_EVENT: no such night' using errcode = 'check_violation';
  end if;

  select coalesce(jsonb_agg(x order by x ->> 'sort', x ->> 'name'), '[]'::jsonb)
    into v_blocks
    from (
      select jsonb_build_object(
        'block_id', b.id, 'name', b.name, 'sort', lpad(b.sort_order::text, 6, '0'),
        'settled', coalesce(ns.is_settled, false),
        'settled_at', ns.settled_at, 'settled_by', sb.email,
        'reopened_at', ns.reopened_at, 'reopened_by', rb.email,
        -- Settled: the figures as they were settled. Otherwise, as they stand.
        'figures', case when ns.is_settled then ns.figures
                        else private.block_figures_now(e.id, b.id) end,
        -- Settled, and the night's money has moved since (a late refund):
        -- what it would come to now, so the difference is not missed.
        'now_net_cents', case when ns.is_settled
                              then (private.block_figures_now(e.id, b.id) ->> 'net_cents')::bigint end,
        'allocation', (select coalesce(jsonb_agg(jsonb_build_object(
                          'host_user_id', a.host_user_id, 'email', hu.email,
                          'amount_cents', a.amount_cents, 'set_by', setter.email, 'set_at', a.set_at)
                          order by hu.email), '[]'::jsonb)
                         from warden_allocation a
                         join host_user hu on hu.id = a.host_user_id
                         left join host_user setter on setter.id = a.set_by
                        where a.event_id = e.id and a.block_id = b.id),
        -- Who worked the block that night, as a starting point: checked a
        -- car in, took the money, recorded a lost space. Then anyone with
        -- the block switched on, and anyone already allocated.
        'people', (select coalesce(jsonb_agg(jsonb_build_object(
                      'host_user_id', hu.id, 'email', hu.email,
                      'worked', p.worked) order by p.worked desc, hu.email), '[]'::jsonb)
                     from (select who, bool_or(worked) as worked from (
                             select l.checked_in_by as who, true as worked
                               from private.settlement_lines(e.id) l where l.block_id = b.id
                             union all
                             select l.cash_collected_by, true
                               from private.settlement_lines(e.id) l where l.block_id = b.id
                             union all
                             select bk.checked_in_by, true
                               from booking bk join property pp on pp.id = bk.property_id
                              where bk.event_id = e.id and pp.block_id = b.id
                             union all
                             select ls.recorded_by, true
                               from lost_space ls join property pp on pp.id = ls.property_id
                              where ls.event_id = e.id and pp.block_id = b.id
                             union all
                             select g.host_user_id, false
                               from staff_block_access g
                              where g.block_id = b.id and g.active
                             union all
                             select a.host_user_id, false
                               from warden_allocation a
                              where a.event_id = e.id and a.block_id = b.id
                           ) w where who is not null group by who) p
                     join host_user hu on hu.id = p.who)
      ) as x
      from private.night_blocks(e.id) nb(block_id)
      join block b on b.id = nb.block_id
      left join night_settlement ns on ns.event_id = e.id and ns.block_id = b.id
      left join host_user sb on sb.id = ns.settled_by
      left join host_user rb on rb.id = ns.reopened_by
    ) q;

  return jsonb_build_object(
    'event_id', e.id, 'name', e.name, 'starts_at', e.starts_at, 'status', e.status,
    'settings', (select to_jsonb(s) - 'id' from settlement_setting s where s.id),
    'blocks', v_blocks);
end;
$function$;

revoke all on function public.settlement_report(uuid) from public, anon, authenticated;
grant execute on function public.settlement_report(uuid) to service_role;

-- ------------------------------------------------------ allocating the wardens' amount

-- p_lines: [{host_user_id, amount_cents}]. Replaces the whole allocation,
-- and only when it adds up to the wardens' amount as it stands.
create or replace function public.save_warden_allocation(
  p_event_id uuid, p_block_id uuid, p_lines jsonb, p_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_amount bigint;
  v_sum    bigint := 0;
  v_line   jsonb;
  v_cents  integer;
begin
  if private.block_settled(p_event_id, p_block_id) then
    raise exception 'NIGHT_SETTLED: this night is settled for that block. Reopen it first.'
      using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'BAD_AMOUNT: the allocation is a list' using errcode = 'check_violation';
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if (v_line ->> 'amount_cents') !~ '^[0-9]{1,9}$' then
      raise exception 'BAD_AMOUNT: each amount is a whole number of cents'
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from host_user
                    where id::text = v_line ->> 'host_user_id') then
      raise exception 'UNKNOWN_PERSON: that person is not on the books'
        using errcode = 'check_violation';
    end if;
    v_sum := v_sum + (v_line ->> 'amount_cents')::bigint;
  end loop;

  v_amount := (private.block_figures_now(p_event_id, p_block_id) ->> 'wardens_cents')::bigint;
  if v_sum <> v_amount then
    raise exception 'ALLOCATION_NOT_EQUAL: the allocation comes to % cents; the wardens'' amount is % cents',
      v_sum, v_amount using errcode = 'check_violation';
  end if;

  delete from warden_allocation where event_id = p_event_id and block_id = p_block_id;
  insert into warden_allocation (event_id, block_id, host_user_id, amount_cents, set_by)
  select p_event_id, p_block_id, (l ->> 'host_user_id')::uuid,
         sum((l ->> 'amount_cents')::integer), p_by
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
   group by (l ->> 'host_user_id')::uuid
  having sum((l ->> 'amount_cents')::integer) > 0;

  return jsonb_build_object('wardens_cents', v_amount, 'allocated_cents', v_sum);
end;
$function$;

revoke all on function public.save_warden_allocation(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_warden_allocation(uuid, uuid, jsonb, uuid) to service_role;

-- ------------------------------------------------------ settling

create or replace function public.settle_night(p_event_id uuid, p_block_id uuid, p_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  e        event%rowtype;
  s        settlement_setting%rowtype;
  v_fig    jsonb;
  v_alloc  bigint;
  v_alloc_lines jsonb;
begin
  select * into e from event where id = p_event_id for update;
  if not found then
    raise exception 'NO_EVENT: no such night' using errcode = 'check_violation';
  end if;
  if e.status not in ('closed', 'cancelled') then
    raise exception 'NIGHT_NOT_CLOSED: close the night before settling it'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from private.night_blocks(p_event_id) b where b = p_block_id) then
    raise exception 'NO_BLOCK: that block has nothing on this night' using errcode = 'check_violation';
  end if;
  if private.block_settled(p_event_id, p_block_id) then
    raise exception 'NIGHT_SETTLED: this night is already settled for that block'
      using errcode = 'check_violation';
  end if;

  -- A night closed before this migration has no snapshot yet: take it now.
  if not exists (select 1 from night_site_spaces
                  where event_id = p_event_id and block_id = p_block_id) then
    perform public.snapshot_night_spaces(p_event_id);
  end if;

  select * into s from settlement_setting where id;
  v_fig := private.block_figures(p_event_id, p_block_id, s.talli_parking_bps,
             s.warden_parking_bps, s.host_parking_bps, s.warden_extras_bps);

  select coalesce(sum(amount_cents), 0),
         coalesce(jsonb_agg(jsonb_build_object('host_user_id', a.host_user_id,
                    'email', hu.email, 'amount_cents', a.amount_cents) order by hu.email), '[]'::jsonb)
    into v_alloc, v_alloc_lines
    from warden_allocation a join host_user hu on hu.id = a.host_user_id
   where a.event_id = p_event_id and a.block_id = p_block_id;

  if v_alloc <> (v_fig ->> 'wardens_cents')::bigint then
    raise exception 'ALLOCATION_NOT_EQUAL: allocate the wardens'' % cents before settling (% allocated)',
      v_fig ->> 'wardens_cents', v_alloc using errcode = 'check_violation';
  end if;

  v_fig := v_fig || jsonb_build_object('allocation', v_alloc_lines);

  insert into night_settlement (event_id, block_id, is_settled, talli_parking_bps,
         warden_parking_bps, host_parking_bps, warden_extras_bps, figures,
         settled_at, settled_by)
  values (p_event_id, p_block_id, true, s.talli_parking_bps, s.warden_parking_bps,
          s.host_parking_bps, s.warden_extras_bps, v_fig, now(), p_by)
  on conflict (event_id, block_id) do update set
    is_settled = true,
    talli_parking_bps = excluded.talli_parking_bps,
    warden_parking_bps = excluded.warden_parking_bps,
    host_parking_bps = excluded.host_parking_bps,
    warden_extras_bps = excluded.warden_extras_bps,
    figures = excluded.figures,
    settled_at = excluded.settled_at,
    settled_by = excluded.settled_by,
    reopened_at = null,
    reopened_by = null;

  return v_fig;
end;
$function$;

revoke all on function public.settle_night(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_night(uuid, uuid, uuid) to service_role;

create or replace function public.reopen_settlement(p_event_id uuid, p_block_id uuid, p_by uuid default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update night_settlement
     set is_settled = false, reopened_at = now(), reopened_by = p_by
   where event_id = p_event_id and block_id = p_block_id and is_settled;
  if not found then
    raise exception 'NOT_SETTLED: that night is not settled for that block'
      using errcode = 'check_violation';
  end if;
  return true;
end;
$function$;

revoke all on function public.reopen_settlement(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reopen_settlement(uuid, uuid, uuid) to service_role;

-- ------------------------------------------------------ changing the percentages

-- Whole percentages or basis points, as {talli_parking_bps, ...}. Settled
-- nights keep the values they were settled at.
create or replace function public.save_settlement_setting(p_details jsonb, p_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  s settlement_setting%rowtype;
  k text;
begin
  select * into s from settlement_setting where id for update;
  foreach k in array array['talli_parking_bps', 'warden_parking_bps',
                           'host_parking_bps', 'warden_extras_bps'] loop
    if p_details ? k and coalesce(p_details ->> k, '') !~ '^[0-9]{1,5}$' then
      raise exception 'BAD_PERCENT: % is a whole number of basis points', k
        using errcode = 'check_violation';
    end if;
  end loop;

  s.talli_parking_bps  := coalesce((p_details ->> 'talli_parking_bps')::integer, s.talli_parking_bps);
  s.warden_parking_bps := coalesce((p_details ->> 'warden_parking_bps')::integer, s.warden_parking_bps);
  s.host_parking_bps   := coalesce((p_details ->> 'host_parking_bps')::integer, s.host_parking_bps);
  s.warden_extras_bps  := coalesce((p_details ->> 'warden_extras_bps')::integer, s.warden_extras_bps);

  if s.talli_parking_bps + s.warden_parking_bps + s.host_parking_bps <> 10000 then
    raise exception 'SPLIT_NOT_100: Talli, wardens and hosts must add up to 100%%'
      using errcode = 'check_violation';
  end if;
  if greatest(s.talli_parking_bps, s.warden_parking_bps, s.host_parking_bps,
              s.warden_extras_bps) > 10000 then
    raise exception 'BAD_PERCENT: no share is more than 100%%' using errcode = 'check_violation';
  end if;

  update settlement_setting set
    talli_parking_bps = s.talli_parking_bps, warden_parking_bps = s.warden_parking_bps,
    host_parking_bps = s.host_parking_bps, warden_extras_bps = s.warden_extras_bps,
    updated_at = now(), updated_by = p_by
   where id
  returning * into s;

  return to_jsonb(s) - 'id';
end;
$function$;

revoke all on function public.save_settlement_setting(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_settlement_setting(jsonb, uuid) to service_role;
