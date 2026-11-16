-- =====================================================================
--  Sending a car to another site before it arrives
--  (20261127100000_talli_transfer_before_check_in).
--
--  transfer_booking() moves a car within its block and leaves whether it
--  has arrived alone; place_booking() is still the move and the tick-in.
--  Both keep the same rules: the block, the type of space, the count.
--
--  Uses the fixture night in seed-test-nights.sql: Gribblehurst (test),
--  anchor and neighbour, in one block; Paice Ave in another. Rolled back.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('paice',  '22222222-2222-2222-2222-222222222222'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

-- An online Standard booking at the anchor, paid, not here yet.
insert into fx values ('car', hold_booking(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'standard', 'transfer.test@example.com', p_rego => 'TRF001'));
select confirm_booking(pg_temp.fx('car'), null);

create function pg_temp.site() returns uuid
language sql as $$ select property_id from booking where id = pg_temp.fx('car') $$;
create function pg_temp.arrived() returns boolean
language sql as $$ select checked_in_at is not null from booking where id = pg_temp.fx('car') $$;

-- ------------------------------------------------------------ who may
select ok(not has_function_privilege('anon',
  'public.transfer_booking(uuid, uuid, text, uuid, boolean)', 'execute'),
  'the public cannot transfer a car');
select ok(not has_function_privilege('authenticated',
  'public.transfer_booking(uuid, uuid, text, uuid, boolean)', 'execute'),
  'nor can a signed-in browser — only gate-ops');

-- ------------------------------------------------- before it arrives
select lives_ok($$ select transfer_booking(pg_temp.fx('car'), pg_temp.fx('neigh'), null, null) $$,
  'a car not yet here is sent to the neighbour');
select is(pg_temp.site(), pg_temp.fx('neigh'), 'it is now going to the neighbour');
select is(pg_temp.arrived(), false, 'and it is still not checked in');
select is((select booked_property_id from booking where id = pg_temp.fx('car')),
  pg_temp.fx('anchor'), 'where it was booked is kept');

-- --------------------------------------------------- the same rules
select throws_like($$ select transfer_booking(pg_temp.fx('car'), pg_temp.fx('paice'), null, null) $$,
  '%NOT_IN_BLOCK%', 'never out of the block it was booked into');
select throws_like($$ select transfer_booking(pg_temp.fx('car'), pg_temp.fx('anchor'), 'valet', null) $$,
  '%WRONG_SPACE%', 'never into a type of space it cannot take');

-- ----------------------------------------- place_booking still ticks in
select place_booking(pg_temp.fx('car'), pg_temp.fx('anchor'), null, null);
select is(pg_temp.arrived(), true, 'moving a car with place_booking ticks it in, as before');

-- A car already here stays here when it is transferred.
select transfer_booking(pg_temp.fx('car'), pg_temp.fx('neigh'), null, null);
select is(pg_temp.arrived(), true, 'transferring a car that is in leaves it in');

-- ----------------------------------- the operator may send it anywhere
-- The block rule above is the warden's. With p_any_block the operator
-- sends the car to a site in another block.
select lives_ok($$ select transfer_booking(pg_temp.fx('car'), pg_temp.fx('paice'), null, null, true) $$,
  'the operator can send a car to a site in another block');
select is(pg_temp.site(), pg_temp.fx('paice'), 'and it is now at that site');

select * from finish();
rollback;
