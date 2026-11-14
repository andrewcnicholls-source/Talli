-- =====================================================================
--  Prices by distance from Eden Park (20261124100000_talli_price_rings).
--
--  Done when: an area takes its ring from its anchor's distance; two
--  areas in the same ring charge the same; Andrew can put an area on a
--  boundary in another ring, and take it back; the reference site's area
--  cannot be moved.
--
--  Fixture: 86 Paice Ave (the reference) and the Gribblehurst (test)
--  anchor are both 600–800m from Eden Park, so both are ring 4 by
--  distance. The fixture puts Gribblehurst in ring 5 (+$10) by hand.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('paice',  '22222222-2222-2222-2222-222222222222'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;
create function pg_temp.price(p_site text, p_code text) returns integer
language sql as $$
  select t.price_cents from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = pg_temp.fx('night') and o.property_id = pg_temp.fx(p_site) and t.code = p_code
$$;
create function pg_temp.grib() returns uuid
language sql as $$ select block_id from property where id = pg_temp.fx('anchor') $$;
create function pg_temp.paice_block() returns uuid
language sql as $$ select block_id from property where id = pg_temp.fx('paice') $$;

-- ------------------------------------------------------------ the shape
select has_table('price_ring', 'the rings have a table');
select is((select array_agg(outer_metres order by ring) from price_ring),
  array[200, 400, 600, 800, null]::integer[],
  'four rings of 200m, then everything beyond');
select has_column('block', 'ring_override', 'an area can be put in a ring by hand');
select ok(not has_table_privilege('anon', 'price_ring', 'select'), 'the public cannot read the rings');
select ok(not has_function_privilege('anon', 'public.set_block_ring(uuid, smallint)', 'execute'),
  'nor move an area between them');

-- -------------------------------------------------------- by distance
select is(private.ring_for_metres(150), 1::smallint, '150m is ring 1');
select is(private.ring_for_metres(200), 1::smallint, '200m is still ring 1');
select is(private.ring_for_metres(201), 2::smallint, '201m is ring 2');
select is(private.ring_for_metres(5000), 5::smallint, 'anything beyond 800m is ring 5');
select is(block_ring_by_distance(pg_temp.grib()), 4::smallint,
  'the Gribblehurst anchor is ring 4 by distance');
select is(reference_ring(), 4::smallint, 'and so is 86 Paice Ave');
select is(block_ring(pg_temp.grib()), 5::smallint, 'the fixture has put Gribblehurst in ring 5 by hand');

-- ----------------------------------------- back to its ring by distance
select ok(set_block_ring(pg_temp.grib(), null) >= 1,
  'taking the override off re-prices its upcoming nights');
select is(pg_temp.price('anchor', 'standard'), pg_temp.price('paice', 'standard'),
  'in the same ring as the reference, it charges the reference price');
select is(pg_temp.price('neigh', 'priority'), pg_temp.price('paice', 'priority'),
  'for every type, at every house in the area');

-- --------------------------------------------------- into another ring
do $$ begin perform set_ring_offsets(3::smallint,
  '[{"code":"standard","offset_cents":2500},{"code":"priority","offset_cents":2500}]'); end $$;
select ok(set_block_ring(pg_temp.grib(), 3::smallint) >= 1, 'put in ring 3 by hand');
select is(pg_temp.price('neigh', 'standard'), pg_temp.price('paice', 'standard') + 2500,
  'it charges ring 3''s price');

select throws_like($$ select set_block_ring(pg_temp.paice_block(), 3::smallint) $$,
  'REFERENCE_BLOCK%', 'the reference site''s area cannot be moved');
select throws_like($$ select set_block_ring(pg_temp.grib(), 7::smallint) $$,
  'NO_SUCH_RING%', 'nor can an area go in a ring that does not exist');

select * from finish();
rollback;
