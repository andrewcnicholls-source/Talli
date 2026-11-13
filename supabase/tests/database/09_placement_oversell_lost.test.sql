-- =====================================================================
--  Placement, Standard into Priority at the gate, and lost spaces
--  (plan B5, 20261118100000_talli_placement_oversell_lost_spaces).
--
--  Done when: selling one Standard too many removes one Priority from
--  the booking page, a lost space does the same and can be undone, and
--  the proposal order holds with two sites in a block.
--
--  Uses the fixture night in seed-test-nights.sql. Gribblehurst (test):
--  anchor and neighbour, each 3 Standard and 2 Priority (1 held for the
--  gate). Paice Ave: 86 with Standard, Priority and Valet; the 84 berm
--  with Standard only. Counts are measured, not assumed, so another
--  suite's cars on the night do not change what is being proved.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('paice',  '22222222-2222-2222-2222-222222222222'),
  ('berm',   '22222222-2222-2222-2222-222222222223'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

-- Free at the gate, and on the booking page, for one site and type.
create function pg_temp.gate(p_site text, p_code text) returns integer
language sql as $$
  select spots_left_gate from v_tier_availability
   where event_id = pg_temp.fx('night') and property_id = pg_temp.fx(p_site) and code = p_code
$$;
create function pg_temp.online(p_site text, p_code text) returns integer
language sql as $$
  select spots_left from v_tier_availability
   where event_id = pg_temp.fx('night') and property_id = pg_temp.fx(p_site) and code = p_code
$$;
create function pg_temp.block_online(p_block text, p_code text) returns integer
language sql as $$
  select spots_left from v_block_tier_availability
   where event_id = pg_temp.fx('night') and block_name = p_block and code = p_code
$$;

-- A walk-up sold for cash, standing at p_site.
create function pg_temp.sell(p_site text, p_code text) returns uuid
language sql as $$
  select sell_at_gate(pg_temp.fx('night'), pg_temp.fx(p_site), p_code, 'cash',
                      'B5' || upper(substr(md5(random()::text), 1, 5)))
$$;

-- Where a booking is: "site:space".
create function pg_temp.at(p_id uuid) returns text
language sql as $$
  select (select k from fx where id = b.property_id) || ':' || coalesce(b.space_code, b.tier_code)
    from booking b where b.id = p_id
$$;

-- Sell Standard at p_site until a sale lands at p_want ("site:space").
-- Returns that booking; every sale on the way is kept in sold.
create temp table sold (n serial, id uuid, at text);
create function pg_temp.sell_until(p_site text, p_want text) returns uuid
language plpgsql as $$
declare v uuid; i int := 0;
begin
  loop
    v := pg_temp.sell(p_site, 'standard');
    insert into sold (id, at) values (v, pg_temp.at(v));
    if pg_temp.at(v) = p_want then return v; end if;
    i := i + 1;
    if i > 20 then raise exception 'never landed at %', p_want; end if;
  end loop;
end $$;

create temp table seen (k text primary key, v integer);

-- ------------------------------------------------------------ the shape
select has_column('booking', 'space_code', 'a booking says which type of space the car is in');
select has_table('lost_space', 'lost spaces have a table of their own');
select ok(not has_table_privilege('anon', 'lost_space', 'select'),
  'the public cannot read lost spaces');
select ok(not has_function_privilege('anon',
  'public.record_lost_space(uuid, uuid, text, text, text, uuid)', 'execute'),
  'nor record one');
select ok(not has_function_privilege('anon',
  'public.place_booking(uuid, uuid, text, uuid)', 'execute'),
  'nor place a car');
select ok(not has_function_privilege('anon',
  'public.check_in_placed(uuid, uuid, uuid)', 'execute'),
  'nor tick one in');

-- ---------------------------------------------------------- lost spaces
insert into seen values ('pg', pg_temp.gate('paice', 'priority')),
                        ('po', pg_temp.online('paice', 'priority'));

insert into fx values ('lost', record_lost_space(pg_temp.fx('night'), pg_temp.fx('paice'),
  'priority', 'bad_parking', 'across two', null));

select is(pg_temp.gate('paice', 'priority'), (select v from seen where k = 'pg') - 1,
  'a lost space comes off the gate');
select is(pg_temp.online('paice', 'priority'), greatest(0, (select v from seen where k = 'po') - 1),
  'and off the booking page');
select is((select lost from v_tier_availability where event_id = pg_temp.fx('night')
             and property_id = pg_temp.fx('paice') and code = 'priority'), 1,
  'and is counted as lost, not as a car');
select is(undo_lost_space(pg_temp.fx('lost'), null), true, 'it can be undone');
select is(pg_temp.gate('paice', 'priority'), (select v from seen where k = 'pg'),
  'and the space is back on sale');
select is(undo_lost_space(pg_temp.fx('lost'), null), false, 'undoing it twice does nothing');
select throws_like($$ select record_lost_space(pg_temp.fx('night'), pg_temp.fx('berm'),
                        'priority', 'blocked') $$, '%NO_TIER%',
  'a type the site does not have cannot be lost');
select throws_like($$ select record_lost_space(pg_temp.fx('night'), pg_temp.fx('paice'),
                        'standard', 'because') $$, '%BAD_REASON%',
  'and a lost space says why');

-- ------------------------------------- the order, with two sites in a block

-- An online Standard car, booked at the anchor before the gate opens.
insert into fx values ('car', hold_booking(pg_temp.fx('night'), pg_temp.fx('anchor'), 'standard',
  'b5.test@example.com', null, null, 'B5CAR', 30, 'online', false, 'stripe', false));
do $$ begin perform confirm_booking(pg_temp.fx('car'), null); end $$;

-- 1. Walk-ups at the anchor fill the anchor's Standard first.
insert into fx values ('first_else', pg_temp.sell_until('anchor', 'neigh:standard'));
select is((select count(*)::int from sold where at = 'anchor:standard'), (select count(*)::int - 1 from sold),
  'Standard here first: every sale before the first elsewhere was at the anchor');
select is(pg_temp.gate('anchor', 'standard'), 0, 'and the anchor''s Standard is full');
select is((select at from sold order by n desc limit 1), 'neigh:standard',
  '2. then Standard at another site in the block, before any Priority');

-- Placement on arrival: its own space while it has one.
select is((select property_id from propose_space(pg_temp.fx('night'), pg_temp.fx('anchor'),
            'standard', pg_temp.fx('car'), false)), pg_temp.fx('anchor'),
  'an arriving online car keeps its own space');

-- A lost Standard space at the anchor leaves it nowhere there.
insert into fx values ('lost2', record_lost_space(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'standard', 'host_car', null, null));
select is(check_in_placed(pg_temp.fx('car'), pg_temp.fx('anchor'), null) ->> 'property_id',
  pg_temp.fx('neigh')::text,
  'with its space lost, it is placed in Standard at the other site');
select is(pg_temp.at(pg_temp.fx('car')), 'neigh:standard', 'and is counted there');
select isnt((select checked_in_at from booking where id = pg_temp.fx('car')), null,
  'and is ticked in');
select is(undo_lost_space(pg_temp.fx('lost2'), null), true, 'the host moves their car');

-- 3. Standard full across the block: the next walk-up takes Priority here.
insert into seen values ('ag', pg_temp.gate('anchor', 'priority')),
                        ('bo', pg_temp.block_online('Gribblehurst (test)', 'priority'));
insert into fx values ('spill', pg_temp.sell_until('anchor', 'anchor:priority'));
select is(pg_temp.gate('anchor', 'standard') + pg_temp.gate('neigh', 'standard'), 0,
  'only once Standard is full at both sites');
select is((select tier_code from booking where id = pg_temp.fx('spill')), 'standard',
  '3. then a Priority space here, sold as Standard');
select is((select amount_cents from booking where id = pg_temp.fx('spill')),
  (select price_cents from v_tier_availability where event_id = pg_temp.fx('night')
     and property_id = pg_temp.fx('anchor') and code = 'standard'),
  'at the Standard price');
select is(pg_temp.gate('anchor', 'priority'), (select v from seen where k = 'ag') - 1,
  'it takes one Priority space at the gate');
select is(pg_temp.block_online('Gribblehurst (test)', 'priority'),
  greatest(0, (select v from seen where k = 'bo') - 1),
  'and one comes off the booking page');
select is((select overflow_in from v_tier_availability where event_id = pg_temp.fx('night')
             and property_id = pg_temp.fx('anchor') and code = 'priority'), 1,
  'the Priority line says one of its cars is Standard');

-- 4. Priority here full: Priority at the other site.
select is(pg_temp.at(pg_temp.sell_until('anchor', 'neigh:priority')), 'neigh:priority',
  '4. then a Priority space at another site in the block');
select is(pg_temp.gate('anchor', 'priority'), 0, 'only once Priority here is full');

-- Nothing left in Standard or Priority anywhere in the block.
create function pg_temp.drain() returns integer
language plpgsql as $$
declare i int := 0;
begin
  loop
    begin
      perform pg_temp.sell('anchor', 'standard');
    exception when others then
      return i;
    end;
    i := i + 1;
    if i > 20 then return -1; end if;
  end loop;
end $$;
select cmp_ok(pg_temp.drain(), '>=', 0, 'the block runs out of room');
select throws_like($$ select pg_temp.sell('anchor', 'standard') $$, '%SOLD_OUT%',
  'and then a Standard walk-up is refused');
select throws_like($$ select pg_temp.sell('neigh', 'priority') $$, '%SOLD_OUT%',
  'Priority is never sold past its count');
select throws_like($$ select hold_booking(pg_temp.fx('night'), pg_temp.fx('neigh'), 'standard',
                       'b5.test@example.com', null, null, 'B5WEB', 30, 'online', false, 'stripe', false) $$,
  '%SOLD_OUT%', 'and the website still stops at the count');

-- ------------------------------------------------------- never Valet
-- Paice Ave: fill Standard at 86 and the berm, and Priority at 86. Valet
-- at 86 has room, and is never taken.
insert into seen values ('pv', pg_temp.gate('paice', 'valet'));
create function pg_temp.drain_paice() returns integer
language plpgsql as $$
declare i int := 0;
begin
  loop
    begin
      perform pg_temp.sell('paice', 'standard');
    exception when others then
      return i;
    end;
    i := i + 1;
    if i > 30 then return -1; end if;
  end loop;
end $$;
select cmp_ok(pg_temp.drain_paice(), '>=', 0, 'Paice Ave runs out of Standard and Priority');
select is(pg_temp.gate('paice', 'priority'), 0, 'Priority at 86 was taken');
select is(pg_temp.gate('paice', 'valet'), (select v from seen where k = 'pv'),
  'Valet was never touched');

-- ----------------------------------------------- overriding a placement
select throws_like($$ select place_booking(pg_temp.fx('car'), pg_temp.fx('anchor'), 'valet', null) $$,
  '%WRONG_SPACE%', 'a Standard car cannot be put in a Valet space');
select throws_like($$ select place_booking(pg_temp.fx('car'), pg_temp.fx('anchor'), 'priority', null) $$,
  '%NO_ROOM%', 'nor in a Priority space that is not free');

select * from finish();
rollback;
