-- =====================================================================
--  Warden access (plan B8, 20261122100000_talli_warden_access).
--
--  Invite, switch an area, deactivate: only ever a warden's row, never an
--  operator's; nothing half-made on a refusal; and none of it reachable
--  from a browser session.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(26);

create temp table fx (k text primary key, id uuid);
insert into fx select 'grib',  id from block where name = 'Gribblehurst (test)';
insert into fx select 'paice', id from block where name = 'Paice Ave';
insert into fx select 'op',    id from host_user where email = 'operator.test@example.com';

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

-- ------------------------------------------------------------- reachable

select ok(not has_function_privilege('anon', 'public.invite_warden(text, uuid[], uuid)', 'execute'),
  'anon cannot invite');
select ok(not has_function_privilege('authenticated', 'public.invite_warden(text, uuid[], uuid)', 'execute'),
  'a signed-in browser session cannot invite');
select ok(not has_function_privilege('authenticated', 'public.set_warden_block(uuid, uuid, boolean)', 'execute'),
  'a signed-in browser session cannot switch an area');
select ok(not has_function_privilege('authenticated', 'public.set_warden_active(uuid, boolean)', 'execute'),
  'a signed-in browser session cannot deactivate');
select ok(not has_function_privilege('anon', 'public.staff_list()', 'execute'),
  'anon cannot list staff');

-- ---------------------------------------------------------------- invite

select throws_like(
  $$ select invite_warden('nope', array[pg_temp.fx('grib')], null) $$,
  'BAD_EMAIL%', 'a bad address is refused');
select throws_like(
  $$ select invite_warden('b8.db@example.com', '{}', null) $$,
  'NO_BLOCKS_CHOSEN%', 'an invitation with no area is refused');
select throws_like(
  $$ select invite_warden('b8.db@example.com', array[null]::uuid[], null) $$,
  'NO_BLOCKS_CHOSEN%', 'nulls are not areas');
select throws_like(
  $$ select invite_warden('b8.db@example.com', array[pg_temp.fx('grib'), gen_random_uuid()], null) $$,
  'UNKNOWN_BLOCK%', 'an area not on the books is refused');
select is((select count(*)::int from host_user where email = 'b8.db@example.com'), 0,
  'a refused invitation leaves nothing behind');
select throws_like(
  $$ select invite_warden('OPERATOR.test@example.com', array[pg_temp.fx('grib')], null) $$,
  'ALREADY_ON_BOOKS%', 'someone on the books is not re-invited, whatever the case');

insert into fx
select 'w', (invite_warden(' B8.DB@example.com ',
              array[pg_temp.fx('grib'), pg_temp.fx('grib')], pg_temp.fx('op')) ->> 'host_user_id')::uuid;

select results_eq(
  $$ select email, scope, role, active, user_id is null, invited_by
       from host_user where id = pg_temp.fx('w') $$,
  $$ values ('b8.db@example.com'::text, 'blocks'::text, 'staff'::text, true, true, pg_temp.fx('op')) $$,
  'an unclaimed warden invitation, lower case, with who sent it');
select ok((select h.is_operator from host_user hu join host h on h.id = hu.host_id
            where hu.id = pg_temp.fx('w')), 'filed under the operator host');
select results_eq(
  $$ select block_id, active from staff_block_access where host_user_id = pg_temp.fx('w') $$,
  $$ values (pg_temp.fx('grib'), true) $$,
  'one grant per area, the repeat folded');

-- ----------------------------------------------------------- the claim

-- The existing claim path is unchanged: the first sign-in with that email.
insert into auth.users (id, email, aud, role)
values ('7e570000-0000-4000-8000-0000000000b8', 'b8.db@example.com', 'authenticated', 'authenticated');
select is((select count(*)::int from host_access_for('7e570000-0000-4000-8000-0000000000b8', 'B8.db@example.com')),
  1, 'the invitation is claimed by a sign-in with that email');

-- --------------------------------------------------------- switch areas

select lives_ok($$ select set_warden_block(pg_temp.fx('w'), pg_temp.fx('paice'), true) $$,
  'a second area is switched on');
select lives_ok($$ select set_warden_block(pg_temp.fx('w'), pg_temp.fx('grib'), false) $$,
  'the first is switched off');
select results_eq(
  $$ select block_id, active from staff_block_access where host_user_id = pg_temp.fx('w')
      order by active $$,
  $$ values (pg_temp.fx('grib'), false), (pg_temp.fx('paice'), true) $$,
  'switched off is kept as a record, not deleted');
select lives_ok($$ select set_warden_block(pg_temp.fx('w'), pg_temp.fx('paice'), false) $$,
  'every area may be switched off');
select is((select scope from host_user where id = pg_temp.fx('w')), 'blocks',
  'and the warden is still a warden — gate-ops turns them away, never widens them');
select throws_like($$ select set_warden_block(pg_temp.fx('w'), gen_random_uuid(), true) $$,
  'UNKNOWN_BLOCK%', 'an area not on the books cannot be switched on');

-- ------------------------------------------------------------ deactivate

select lives_ok($$ select set_warden_active(pg_temp.fx('w'), false) $$, 'a warden is deactivated');
select is((select count(*)::int from host_access_for('7e570000-0000-4000-8000-0000000000b8', 'b8.db@example.com')),
  0, 'and is no host at all from the next request');

-- ------------------------------------------------------- never an operator

select throws_like($$ select set_warden_active(pg_temp.fx('op'), false) $$,
  'NOT_A_WARDEN%', 'an operator cannot be switched off from the screen');
select throws_like($$ select set_warden_block(pg_temp.fx('op'), pg_temp.fx('grib'), false) $$,
  'NOT_A_WARDEN%', 'nor given or denied areas');
select throws_like($$ select set_warden_active(gen_random_uuid(), true) $$,
  'NO_PERSON%', 'nobody is not a warden either');

select * from finish();
rollback;
