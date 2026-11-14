-- =====================================================================
--  Talli — warden access from the screen (plan B8)
--
--  Until now a warden was two rows of SQL (supabase/test-only/
--  seed-test-block.sql): a host_user with scope 'blocks' and a
--  staff_block_access row per block. This gives Andrew the same from the
--  Sites page, through gate-ops, where every action below is operator-only.
--
--    staff_list()          the wardens, their blocks, whether they have
--                          signed in yet; and the operators, read-only.
--    invite_warden()       one host_user (an unclaimed invitation) and a
--                          grant per block chosen. Claimed, as every
--                          invitation is, by the first sign-in with that
--                          verified email — nothing here changes how.
--    set_warden_block()    switch one block on or off for a warden.
--    set_warden_active()   deactivate or reactivate a warden.
--
--  What these never do:
--
--    - touch a row with scope 'all'. An operator is not made, changed or
--      switched off from the screen, so Andrew cannot lock himself out and
--      a mistyped invitation cannot make someone a super admin.
--    - widen a warden. A warden with every block switched off keeps
--      scope 'blocks' and is refused by gate-ops as NO_BLOCKS.
--    - delete. Deactivating keeps the record of who checked cars in and
--      who held cash (booking.checked_in_by, cash_collected_by).
--
--  The email here is the invitation's, typed by Andrew. It is never the
--  caller's identity: gate-ops takes that from the verified token alone.
--
--  Additive: one column, four functions. Nothing restated.
-- =====================================================================

alter table host_user
  add column if not exists invited_by uuid references host_user(id) on delete set null;

comment on column host_user.invited_by is
  'Who sent the invitation from the gate screen (plan B8). Null for rows made by SQL.';

-- ------------------------------------------------------------- staff_list

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
               'email',        hu.email,
               'scope',        hu.scope,
               'active',       hu.active,
               'host_name',    h.name,
               'invited_at',   hu.invited_at,
               'claimed',      hu.user_id is not null,
               'claimed_at',   hu.claimed_at,
               'last_seen_at', hu.last_seen_at,
               'invited_by',   inv.email,
               'blocks', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'block_id', g.block_id, 'name', b.name, 'active', g.active)
                          order by b.sort_order, b.name)
                   from staff_block_access g join block b on b.id = g.block_id
                  where g.host_user_id = hu.id), '[]'::jsonb))
             -- Operators first, then wardens; the switched-off last.
             order by (hu.scope = 'all') desc, hu.active desc, lower(hu.email))
        from host_user hu
        join host h on h.id = hu.host_id
        left join host_user inv on inv.id = hu.invited_by
       where hu.scope = 'blocks' or h.is_operator), '[]'::jsonb)
  );
$function$;

comment on function public.staff_list() is
  'Plan B8: the people who may open the gate screen as wardens, with their blocks, and the operators (read-only).';

revoke all on function public.staff_list() from public, anon, authenticated;
grant execute on function public.staff_list() to service_role;

-- ---------------------------------------------------------- invite_warden

create or replace function public.invite_warden(p_email text, p_block_ids uuid[], p_by uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_blocks   uuid[] := array(select distinct x from unnest(coalesce(p_block_ids, '{}')) x
                              where x is not null);
  v_operator uuid;
  v_id       uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'BAD_EMAIL: that is not an email address' using errcode = 'check_violation';
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
  -- books — a warden, a host of their own driveway, an operator — is
  -- changed from their own line, never re-invited over the top.
  if exists (select 1 from host_user where lower(email) = v_email) then
    raise exception 'ALREADY_ON_BOOKS: % already has a line on the People list', v_email
      using errcode = 'unique_violation';
  end if;

  select id into v_operator from host where is_operator order by created_at limit 1;
  if v_operator is null then
    raise exception 'NO_OPERATOR_HOST: no host is marked as the operator'
      using errcode = 'check_violation';
  end if;

  insert into host_user (host_id, email, role, scope, active, invited_by)
  values (v_operator, v_email, 'staff', 'blocks', true, p_by)
  returning id into v_id;

  insert into staff_block_access (host_user_id, block_id, active)
  select v_id, x, true from unnest(v_blocks) x;

  return jsonb_build_object('host_user_id', v_id, 'email', v_email);
end;
$function$;

comment on function public.invite_warden(text, uuid[], uuid) is
  'Plan B8: an unclaimed warden invitation (scope blocks) with a grant per area. Never makes an operator.';

revoke all on function public.invite_warden(text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.invite_warden(text, uuid[], uuid) to service_role;

-- ------------------------------------------------------- the warden guard

-- The row, if it is a warden. Anything else — an operator, a host of
-- their own driveway, no such row — is refused by name.
create or replace function private.warden_row(p_host_user_id uuid)
returns host_user
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  r host_user%rowtype;
begin
  select * into r from host_user where id = p_host_user_id;
  if not found then
    raise exception 'NO_PERSON: that person is not on the books' using errcode = 'check_violation';
  end if;
  if r.scope <> 'blocks' then
    raise exception 'NOT_A_WARDEN: only a warden''s access is changed here'
      using errcode = 'check_violation';
  end if;
  return r;
end;
$function$;

revoke all on function private.warden_row(uuid) from public, anon, authenticated;
grant execute on function private.warden_row(uuid) to service_role;

-- ------------------------------------------------------- set_warden_block

create or replace function public.set_warden_block(p_host_user_id uuid, p_block_id uuid, p_on boolean)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
begin
  perform private.warden_row(p_host_user_id);
  if p_on is null then
    raise exception 'BAD_SWITCH: say on or off' using errcode = 'check_violation';
  end if;
  -- Switching on needs an area that is in use; switching off is allowed
  -- for any grant the warden holds, so an area retired later can still be
  -- taken away.
  if not exists (select 1 from block where id = p_block_id and (active or not p_on)) then
    raise exception 'UNKNOWN_BLOCK: that area is not on the books' using errcode = 'check_violation';
  end if;

  insert into staff_block_access (host_user_id, block_id, active)
  values (p_host_user_id, p_block_id, p_on)
  on conflict (host_user_id, block_id) do update
    set active = excluded.active,
        granted_at = case when excluded.active and not staff_block_access.active
                          then now() else staff_block_access.granted_at end;

  return jsonb_build_object('host_user_id', p_host_user_id, 'block_id', p_block_id, 'active', p_on);
end;
$function$;

comment on function public.set_warden_block(uuid, uuid, boolean) is
  'Plan B8: switch one area on or off for a warden. Every area off leaves them refused (NO_BLOCKS), never widened.';

revoke all on function public.set_warden_block(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_warden_block(uuid, uuid, boolean) to service_role;

-- ------------------------------------------------------ set_warden_active

create or replace function public.set_warden_active(p_host_user_id uuid, p_active boolean)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
begin
  perform private.warden_row(p_host_user_id);
  if p_active is null then
    raise exception 'BAD_SWITCH: say on or off' using errcode = 'check_violation';
  end if;
  -- host_access_for() only ever returns active rows, so a warden switched
  -- off is refused on their very next request, signed in or not.
  update host_user set active = p_active where id = p_host_user_id;
  return jsonb_build_object('host_user_id', p_host_user_id, 'active', p_active);
end;
$function$;

comment on function public.set_warden_active(uuid, boolean) is
  'Plan B8: deactivate or reactivate a warden. Keeps the row and its history; never touches an operator.';

revoke all on function public.set_warden_active(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_warden_active(uuid, boolean) to service_role;
