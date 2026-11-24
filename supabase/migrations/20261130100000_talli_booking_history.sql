-- =====================================================================
--  Booking history, and a name for everyone at the gate.
--
--  Andrew, after a night when Max mentioned a booking with a plate and a
--  name, no phone, no email, "not sure it got paid": nobody could say
--  whether it was Max's walk-up from ten minutes before or one Andrew had
--  made days earlier for someone who paid by bank transfer. The booking
--  knew when it was made; nothing knew who made it, and the screen showed
--  neither.
--
--  So every booking now carries its own history, in booking_change:
--
--    * the lines that were already written there (details, payment, type,
--      price) — unchanged, but now with who;
--    * created, paid, cancelled, expired, refunded, no_show, checked_in
--      and moved — written by a trigger on booking, in the same
--      transaction as the change, so no path that touches a booking can
--      forget to say so.
--
--  WHO is private.current_actor(): the x-talli-actor request header,
--  which gate-ops sets from the caller it has already verified against
--  the auth server and host_user. Every function that writes a booking
--  is service-role only, so a browser cannot reach one to forge it, and
--  a header naming nobody on the books is read as nobody — never as an
--  error that stops a sale. With no person, the line says what did it:
--  the customer online, Stripe, or the system (a hold running out).
--
--  And a person is shown by name: host_user.name, filled here from the
--  email for everyone already on the books (max.smith@ → Max Smith),
--  asked for when a warden is invited, and correctable from People.
-- =====================================================================

-- ------------------------------------------------------------ 1. names

create or replace function private.name_from_email(p_email text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  with lp as (select split_part(coalesce(p_email, ''), '@', 1) as s),
  words as (
    select string_agg(initcap(w), ' ' order by n) as name
      from lp, regexp_split_to_table(regexp_replace(lp.s, '[0-9]+', '', 'g'), '[._+-]+')
           with ordinality as t(w, n)
     where w <> ''
  )
  select coalesce(nullif(words.name, ''), nullif(lp.s, ''), coalesce(p_email, ''))
    from lp, words
$$;

alter table host_user add column if not exists name text;
update host_user set name = private.name_from_email(email)
 where coalesce(btrim(name), '') = '';

-- Adding a host is still one insert with an email (CLAUDE.md, "Who may
-- open the gate screen"): a row that arrives without a name gets the one
-- its email gives, rather than being refused.
create or replace function private.host_user_name()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if coalesce(btrim(new.name), '') = '' then
    new.name := private.name_from_email(new.email);
  end if;
  return new;
end;
$$;

drop trigger if exists host_user_name on host_user;
create trigger host_user_name before insert or update of name, email on host_user
  for each row execute function private.host_user_name();
alter table host_user alter column name set not null;
alter table host_user drop constraint if exists host_user_name_check;
alter table host_user add constraint host_user_name_check check (btrim(name) <> '');

comment on column host_user.name is
  'What the gate screen calls this person — in booking history, and on People. '
  'Filled from the email for people already on the books; asked for on invite.';

-- ------------------------------------------------------------ 2. who

create or replace function private.current_actor()
returns uuid
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_raw text;
  v_id  uuid;
begin
  begin
    v_raw := nullif(current_setting('request.headers', true), '')::json->>'x-talli-actor';
  exception when others then
    return null;
  end;
  if v_raw is null
     or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select id into v_id from host_user where id = v_raw::uuid;
  return v_id;
end;
$$;

comment on function private.current_actor() is
  'The host_user gate-ops says made this request (header x-talli-actor), or null. '
  'Never raises: a bad header names nobody.';

-- ------------------------------------------------- 3. booking_change

alter table booking_change
  add column if not exists by_host_user uuid references host_user(id) on delete set null,
  add column if not exists by_label text;
alter table booking_change alter column before drop not null;
alter table booking_change alter column after  drop not null;

alter table booking_change drop constraint if exists booking_change_kind_check;
alter table booking_change add constraint booking_change_kind_check
  check (kind in ('created', 'paid', 'details', 'payment', 'tier', 'price',
                  'checked_in', 'moved', 'cancelled', 'expired', 'refunded', 'no_show'));

-- Every booking made before today gets the line that says it was made,
-- at the time it was. Who made it was never written down, and is not
-- guessed: both by_ columns stay empty, which the screen reads as
-- "not recorded".
insert into booking_change (booking_id, kind, before, after, created_at)
select b.id, 'created', null,
       jsonb_build_object('channel', b.channel, 'payment_method', b.payment_method,
         'status', b.status, 'tier_code', b.tier_code,
         'property_id', b.property_id, 'amount_cents', b.amount_cents),
       b.created_at
  from booking b
 where not exists (select 1 from booking_change c
                    where c.booking_id = b.id and c.kind = 'created');

-- From here on, every line says who — the lines the gate functions
-- already write included, with no change to them.
alter table booking_change alter column by_host_user set default private.current_actor();

create or replace function private.booking_change_who()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.by_host_user is null and new.by_label is null then
    new.by_label := 'System';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_change_who on booking_change;
create trigger booking_change_who before insert on booking_change
  for each row execute function private.booking_change_who();

comment on table booking_change is
  'The history of a booking: made, paid, edited, moved, checked in, ended. '
  'One row per thing that happened; who did it is by_host_user, or by_label '
  'when it was not a person at the gate. Lines from one transaction share created_at.';

-- ---------------------------------------- 4. the lines a booking writes

create or replace function private.booking_history_line()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_who uuid := private.current_actor();
  v_kind text;
  v_label text;
begin
  if tg_op = 'INSERT' then
    insert into booking_change (booking_id, kind, before, after, by_host_user, by_label)
    values (new.id, 'created', null,
      jsonb_build_object('channel', new.channel, 'payment_method', new.payment_method,
        'status', new.status, 'tier_code', new.tier_code,
        'property_id', new.property_id, 'amount_cents', new.amount_cents),
      v_who,
      case when v_who is not null then null
           when new.channel = 'online' then 'Customer online'
           else 'System' end);
    return new;
  end if;

  if new.status is distinct from old.status
     and new.status in ('paid', 'cancelled', 'expired', 'refunded', 'no_show') then
    v_kind := new.status;
    v_label := case when v_who is not null then null
                    when new.status in ('paid', 'refunded')
                         and new.payment_method = 'stripe' then 'Stripe'
                    else 'System' end;
    insert into booking_change (booking_id, kind, before, after, by_host_user, by_label)
    values (new.id, v_kind,
      jsonb_build_object('status', old.status, 'payment_method', old.payment_method),
      jsonb_build_object('status', new.status, 'payment_method', new.payment_method),
      v_who, v_label);
  end if;

  if old.checked_in_at is null and new.checked_in_at is not null then
    insert into booking_change (booking_id, kind, before, after, by_host_user, by_label)
    values (new.id, 'checked_in', null,
      jsonb_build_object('property_id', new.property_id),
      v_who, case when v_who is null then 'System' end);
  end if;

  if new.property_id is distinct from old.property_id
     or new.space_code is distinct from old.space_code then
    insert into booking_change (booking_id, kind, before, after, by_host_user, by_label)
    values (new.id, 'moved',
      jsonb_build_object('property_id', old.property_id, 'space_code', old.space_code),
      jsonb_build_object('property_id', new.property_id, 'space_code', new.space_code),
      v_who, case when v_who is null then 'System' end);
  end if;

  return new;
end;
$$;

drop trigger if exists booking_history_line on booking;
create trigger booking_history_line after insert or update on booking
  for each row execute function private.booking_history_line();

-- ------------------- 5. cancel_unpaid_gate_booking, without its own line
--  Restated from 20260929100000_talli_pay_later_and_edit_bookings. The
--  trigger's "cancelled" line now says it, with who; its own "payment"
--  line would say it twice.
create or replace function cancel_unpaid_gate_booking(p_booking_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare b booking%rowtype;
begin
  select * into b from booking where id = p_booking_id for update;
  if not found then
    raise exception 'NO_BOOKING: no such booking' using errcode = 'check_violation';
  end if;
  if b.status <> 'held' or b.payment_method <> 'unpaid' then
    raise exception 'NOT_UNPAID: only an unpaid walk-up can be cancelled from here'
      using errcode = 'check_violation';
  end if;

  update booking set status = 'cancelled', hold_expires_at = null
  where id = b.id;
end;
$$;

revoke execute on function cancel_unpaid_gate_booking(uuid)
  from public, anon, authenticated;
grant execute on function cancel_unpaid_gate_booking(uuid) to service_role;

-- --------------------------------------------------- 6. reading it

create or replace function public.booking_history(p_booking_id uuid)
returns table (at timestamptz, kind text, before jsonb, after jsonb,
               by_name text, by_label text)
language sql
stable
set search_path to 'public'
as $$
  select c.created_at, c.kind, c.before, c.after, hu.name, c.by_label
    from booking_change c
    left join host_user hu on hu.id = c.by_host_user
   where c.booking_id = p_booking_id
   order by c.created_at,
            -- Within one moment, in the order it happened.
            array_position(array['created','paid','payment','details','tier','price',
                                 'moved','checked_in','cancelled','expired',
                                 'refunded','no_show'], c.kind),
            c.id
$$;

comment on function public.booking_history(uuid) is
  'One booking''s history, oldest first, with the name of whoever did each thing.';

revoke all on function public.booking_history(uuid) from public, anon, authenticated;
grant execute on function public.booking_history(uuid) to service_role;

-- ------------------------------------------- 7. invite with a name
--  Restated from 20261122100000_talli_warden_access, with p_name.

drop function if exists public.invite_warden(text, uuid[], uuid);

create or replace function public.invite_warden(
  p_email text, p_name text, p_block_ids uuid[], p_by uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_name     text := btrim(coalesce(p_name, ''));
  v_blocks   uuid[] := array(select distinct x from unnest(coalesce(p_block_ids, '{}')) x
                              where x is not null);
  v_operator uuid;
  v_id       uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'BAD_EMAIL: that is not an email address' using errcode = 'check_violation';
  end if;
  if v_name = '' then
    raise exception 'NO_NAME: say what to call them' using errcode = 'check_violation';
  end if;
  if cardinality(v_blocks) = 0 then
    raise exception 'NO_BLOCKS_CHOSEN: choose at least one area for the warden'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(v_blocks) x
              where not exists (select 1 from block b where b.id = x and b.active)) then
    raise exception 'UNKNOWN_BLOCK: one of those areas is not on the books'
      using errcode = 'check_violation';
  end if;
  -- One person, one row (host_user_email_key). Someone already on the
  -- books is changed from their own line, never re-invited over the top.
  if exists (select 1 from host_user where lower(email) = v_email) then
    raise exception 'ALREADY_ON_BOOKS: % already has a line on the People list', v_email
      using errcode = 'unique_violation';
  end if;

  select id into v_operator from host where is_operator order by created_at limit 1;
  if v_operator is null then
    raise exception 'NO_OPERATOR_HOST: no host is marked as the operator'
      using errcode = 'check_violation';
  end if;

  insert into host_user (host_id, email, name, role, scope, active, invited_by)
  values (v_operator, v_email, v_name, 'staff', 'blocks', true, p_by)
  returning id into v_id;

  insert into staff_block_access (host_user_id, block_id, active)
  select v_id, x, true from unnest(v_blocks) x;

  return jsonb_build_object('host_user_id', v_id, 'email', v_email, 'name', v_name);
end;
$function$;

comment on function public.invite_warden(text, text, uuid[], uuid) is
  'Plan B8: an unclaimed warden invitation (scope blocks), with their name and a grant per area. Never makes an operator.';

revoke all on function public.invite_warden(text, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.invite_warden(text, text, uuid[], uuid) to service_role;

-- ------------------------------------------------- 8. correct a name
--  Anyone on the People list, operators included: a name is only what
--  the screen calls them, and the guess from an email can be wrong.

create or replace function public.rename_staff(p_host_user_id uuid, p_name text)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    raise exception 'NO_NAME: say what to call them' using errcode = 'check_violation';
  end if;
  update host_user set name = v_name where id = p_host_user_id;
  if not found then
    raise exception 'NO_PERSON: nobody on the books by that id' using errcode = 'check_violation';
  end if;
  return jsonb_build_object('id', p_host_user_id, 'name', v_name);
end;
$$;

revoke all on function public.rename_staff(uuid, text) from public, anon, authenticated;
grant execute on function public.rename_staff(uuid, text) to service_role;

-- ---------------------------------------------- 9. staff_list, with names
--  Restated from 20261122100000_talli_warden_access, adding name.

create or replace function public.staff_list()
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name)
                       order by b.sort_order, b.name)
        from block b where b.active), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'host_user_id', hu.id,
               'name',         hu.name,
               'email',        hu.email,
               'scope',        hu.scope,
               'active',       hu.active,
               'host_name',    h.name,
               'invited_at',   hu.invited_at,
               'claimed',      hu.user_id is not null,
               'claimed_at',   hu.claimed_at,
               'last_seen_at', hu.last_seen_at,
               'invited_by',   inv.email,
               'invited_by_name', inv.name,
               'blocks', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'block_id', g.block_id, 'name', b.name, 'active', g.active)
                          order by b.sort_order, b.name)
                   from staff_block_access g join block b on b.id = g.block_id
                  where g.host_user_id = hu.id), '[]'::jsonb))
             -- Operators first, then wardens; the switched-off last.
             order by (hu.scope = 'all') desc, hu.active desc, lower(hu.name))
        from host_user hu
        join host h on h.id = hu.host_id
        left join host_user inv on inv.id = hu.invited_by
       where hu.scope = 'blocks' or h.is_operator), '[]'::jsonb)
  );
$function$;

revoke all on function public.staff_list() from public, anon, authenticated;
grant execute on function public.staff_list() to service_role;

-- --------------------------------------------- the private helpers
-- Every write to a booking runs current_actor (the trigger, and
-- booking_change's default) as whoever made it: gate-ops and the payment
-- functions, as the service role. Not the public.
revoke all on function private.name_from_email(text) from public, anon, authenticated;
revoke all on function private.current_actor() from public, anon, authenticated;
grant execute on function private.name_from_email(text) to service_role;
grant execute on function private.current_actor() to service_role;
