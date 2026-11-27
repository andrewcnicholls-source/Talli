-- =====================================================================
--  Booking history (20261130100000_talli_booking_history).
--
--  Andrew, after a night where nobody could say whether a booking was
--  Max's walk-up from ten minutes ago or one Andrew had made days before:
--  every booking says who made it, when, and what has happened to it
--  since. And everyone at the gate has a name to say it with.
--
--  "Who" is the x-talli-actor request header, which only gate-ops sets,
--  from the caller it has already verified. Here it is set by hand.
--
--  Uses the fixture night in seed-test-nights.sql. Rolled back.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(29);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

create function pg_temp.act(p_who text) returns void
language sql as $$
  select set_config('request.headers',
    case when p_who is null then '' else json_build_object('x-talli-actor', p_who)::text end,
    true)
$$;

create function pg_temp.kinds(p_id uuid) returns text[]
language sql as $$
  select array_agg(kind order by kind) from booking_change where booking_id = p_id
$$;

-- --------------------------------------------------------- names
select is(private.name_from_email('max.smith@gmail.com'), 'Max Smith',
  'a name comes from the email: max.smith is Max Smith');
select is(private.name_from_email('j.o''neil+gate2@x.nz'), 'J O''neil Gate',
  'separators split it and the numbers fall away');
select ok(coalesce(btrim(private.name_from_email('123@x.nz')), '') <> '',
  'an email of only numbers still gives a name');
select is((select count(*)::int from host_user where coalesce(btrim(name), '') = ''), 0,
  'everyone on the books has a name');

-- A person at the gate, for this test.
with x as (
  insert into host_user (host_id, email, role, scope, active, name)
  select h.id, 'max.history.test@example.com', 'staff', 'blocks', true, 'Max'
    from host h where h.is_operator order by h.created_at limit 1
  returning id)
insert into fx select 'max', id from x;

-- ---------------------------------------------- a sale at the gate
select pg_temp.act(pg_temp.fx('max')::text);
insert into fx values ('sale', sell_at_gate(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'standard', 'cash', 'HIS001'));

select ok(pg_temp.kinds(pg_temp.fx('sale')) @> array['checked_in','created','paid'],
  'a gate sale is created, paid and checked in');
select is((select count(*)::int from booking_change
            where booking_id = pg_temp.fx('sale')
              and by_host_user is distinct from pg_temp.fx('max')), 0,
  'and every line says Max did it');
select is((select count(distinct created_at)::int from booking_change
            where booking_id = pg_temp.fx('sale')), 1,
  'all in one moment, so the screen can show it as one');

-- An edit gets "who" from the column default, with no new argument.
select edit_booking_at_gate(pg_temp.fx('sale'), p_rego => 'NEW001');
select is((select by_host_user from booking_change
            where booking_id = pg_temp.fx('sale') and kind = 'details'),
  pg_temp.fx('max'), 'an edit says who made it');

-- A move.
select transfer_booking(pg_temp.fx('sale'), pg_temp.fx('neigh'), null, pg_temp.fx('max'));
select is((select after->>'property_id' from booking_change
            where booking_id = pg_temp.fx('sale') and kind = 'moved'
            order by created_at desc limit 1),
  pg_temp.fx('neigh')::text, 'a move says where it went');

-- A car put in another kind of space where it was booked has not moved.
select pg_temp.act(pg_temp.fx('max')::text);
update booking set space_code = 'priority' where id = pg_temp.fx('sale');
select is((select count(*)::int from booking_change
            where booking_id = pg_temp.fx('sale') and kind = 'moved'), 1,
  'a change of space at the same site is not a move');

-- A check-in undone is said, so a later one is not read as the first.
update booking set checked_in_at = null where id = pg_temp.fx('sale');
select is((select by_host_user from booking_change
            where booking_id = pg_temp.fx('sale') and kind = 'check_in_undone'),
  pg_temp.fx('max'), 'undoing a check-in is a line, with who');

-- ---------------------------------------- a header that is not a person
select pg_temp.act('not-a-uuid');
select lives_ok($$ insert into fx values ('junk', sell_at_gate(pg_temp.fx('night'),
  pg_temp.fx('anchor'), 'standard', 'cash', 'HIS002')) $$,
  'a header that is not a person never stops a sale');
select is((select count(*)::int from booking_change
            where booking_id = pg_temp.fx('junk') and by_host_user is not null), 0,
  'and nobody is named');
select is((select by_label from booking_change
            where booking_id = pg_temp.fx('junk') and kind = 'created'),
  'System', 'it is put down to the system');

-- ------------------------------------------------------ online
select pg_temp.act(null);
insert into fx values ('web', hold_booking(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'standard', 'history.online.test@example.com', p_rego => 'HIS003'));
select is((select by_label from booking_change
            where booking_id = pg_temp.fx('web') and kind = 'created'),
  'Customer online', 'an online booking was made by the customer');
select confirm_booking(pg_temp.fx('web'), 'pi_test_history');
select is((select by_label from booking_change
            where booking_id = pg_temp.fx('web') and kind = 'paid'),
  'Stripe', 'and paid through Stripe');

-- ------------------------------------------ cancelling an unpaid walk-up
select pg_temp.act(pg_temp.fx('max')::text);
insert into fx values ('owes', sell_at_gate(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'standard', 'unpaid', 'HIS004'));
select cancel_unpaid_gate_booking(pg_temp.fx('owes'));
select is((select count(*)::int from booking_change
            where booking_id = pg_temp.fx('owes') and kind in ('cancelled', 'payment')), 1,
  'a cancelled walk-up says so once');
select is((select by_host_user from booking_change
            where booking_id = pg_temp.fx('owes') and kind = 'cancelled'),
  pg_temp.fx('max'), 'and who cancelled it');

-- -------------------------------------------------------- reading it
select is((select by_name from booking_history(pg_temp.fx('sale')) where kind = 'created'),
  'Max', 'the history names the person');
select is((select kind from booking_history(pg_temp.fx('sale')) limit 1),
  'created', 'oldest first');

-- --------------------------------------------------------- invites
select throws_like($$ select invite_warden('new.warden.test@example.com', '   ',
  array(select id from block where active limit 1), pg_temp.fx('max')) $$,
  '%NO_NAME%', 'a warden cannot be invited without a name');
select lives_ok($$ select invite_warden('new.warden.test@example.com', ' Sam Jones ',
  array(select id from block where active limit 1), pg_temp.fx('max')) $$,
  'a warden is invited with a name');
select is((select name from host_user where email = 'new.warden.test@example.com'),
  'Sam Jones', 'and it is kept, trimmed');

-- --------------------------------------------------------- renaming
select rename_staff(pg_temp.fx('max'), 'Maxwell');
select is((select by_name from booking_history(pg_temp.fx('sale')) where kind = 'created'),
  'Maxwell', 'a corrected name shows on the old lines too');
select throws_like($$ select rename_staff(pg_temp.fx('max'), '') $$,
  '%NO_NAME%', 'a name cannot be blanked');

select is((select count(*)::int from booking b
            where not exists (select 1 from booking_change c
                               where c.booking_id = b.id and c.kind = 'created')), 0,
  'every booking has the line that says it was made');

-- --------------------------------------------------- who may call
select ok(not has_function_privilege('authenticated',
  'public.booking_history(uuid)', 'execute'),
  'a signed-in browser cannot read history directly — only gate-ops');

-- gate-ops calls in as the service role, and every booking write runs
-- these. Without the grant, every sale through the API fails.
select ok(has_function_privilege('service_role', 'private.current_actor()', 'execute'),
  'the service role can ask who is acting');
select ok(has_function_privilege('service_role', 'private.name_from_email(text)', 'execute'),
  'and can name someone from their email');

select * from finish();
rollback;
