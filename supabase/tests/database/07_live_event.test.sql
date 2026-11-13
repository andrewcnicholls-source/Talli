-- =====================================================================
--  One event is live at a time (plan B2, 20261116100000_talli_live_event).
--
--  The seed makes the fixture night live. Everything here runs inside one
--  transaction and is rolled back, so the seed is as it was afterwards.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',   '7e57e000-0000-4000-8000-000000000001'),
  ('soldout', '7e57e000-0000-4000-8000-000000000002');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

create function pg_temp.live_count() returns bigint
language sql as $$ select count(*) from event where is_live $$;

create function pg_temp.live_id() returns uuid
language sql as $$ select id from event where is_live $$;

-- ------------------------------------------------------------ the seed
select is(pg_temp.live_count(), 1::bigint, 'the seed leaves exactly one night live');
select is(pg_temp.live_id(), pg_temp.fx('night'), 'and it is the fixture night');

-- -------------------------------------------------- at most one, ever
select throws_ok(
  $$ update event set is_live = true where id = '7e57e000-0000-4000-8000-000000000002' $$,
  '23505', null,
  'a second live night is refused by the index, not left to the screen');

-- ---------------------------------------------- moving the live night
select is(set_live_event(pg_temp.fx('soldout')), pg_temp.fx('soldout'),
  'set_live_event makes another night live');
select is(pg_temp.live_id(), pg_temp.fx('soldout'), 'and that one is now the live one');
select is(pg_temp.live_count(), 1::bigint, 'and the last one was cleared with it');

select is(set_live_event(pg_temp.fx('soldout')), pg_temp.fx('soldout'),
  'making the live night live again changes nothing');

select is(set_live_event(null), null::uuid, 'set_live_event(null) clears it');
select is(pg_temp.live_count(), 0::bigint, 'and then no night is live');

-- ------------------------------------------- what cannot be live
update event set status = 'draft' where id = pg_temp.fx('soldout');
select throws_ok($$ select set_live_event('7e57e000-0000-4000-8000-000000000002') $$,
  'NOT_LIVE_STATUS: a draft event cannot be live at the gate',
  'a draft night cannot be made live');

select throws_like($$ select set_live_event(gen_random_uuid()) $$,
  'NO_EVENT%', 'an event that does not exist cannot be made live');

-- ------------------- cancelling the live night takes it off the gate
select set_live_event(pg_temp.fx('night'));
select set_event_status(pg_temp.fx('night'), 'cancelled');
select is(pg_temp.live_count(), 0::bigint,
  'cancelling the live night takes it off the gate as well');

-- --------------------------------------------- who may call it at all
select ok(not has_function_privilege('anon', 'set_live_event(uuid)', 'execute'),
  'the anon key cannot move the live night');
select ok(not has_function_privilege('authenticated', 'set_live_event(uuid)', 'execute'),
  'nor can a signed-in browser: it goes through gate-ops');

select * from finish();
rollback;
