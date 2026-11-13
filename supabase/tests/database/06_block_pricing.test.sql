-- =====================================================================
--  One price per block (plan B1, 20261115100000_talli_block_pricing).
--
--  Done when: two sites in one block always show and charge the same
--  figure, and one surge change re-prices every block.
--
--  Uses the fixture night in seed-test-nights.sql: Paice Ave (86, the
--  reference, and the 84 berm) at $30 Standard; Gribblehurst (test)
--  anchor and neighbour at $40 Standard / $50 Priority, which is the
--  reference plus the block's +$10 adjustment.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('paice',  '22222222-2222-2222-2222-222222222222'),
  ('berm',   '22222222-2222-2222-2222-222222222223'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');

create function pg_temp.price(p_site text, p_code text) returns integer
language sql as $$
  select t.price_cents from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = (select id from fx where k = 'night')
     and o.property_id = (select id from fx where k = p_site) and t.code = p_code
$$;

-- What the booking page reads for a block, and what a hold in it charges.
create function pg_temp.shown(p_block text, p_code text) returns integer
language sql as $$
  select price_cents from v_block_tier_availability
   where event_id = (select id from fx where k = 'night')
     and block_name = p_block and code = p_code
$$;

-- ------------------------------------------------------------ the shape
select has_table('block_tier_offset', 'blocks carry a price adjustment per type');
select is(reference_property(), (select id from fx where k = 'paice'),
  '86 Paice Ave is the reference site');
select ok(not has_table_privilege('anon', 'block_tier_offset', 'select'),
  'the public cannot read the adjustments');
select ok(not has_function_privilege('anon', 'public.set_block_offsets(uuid, jsonb)', 'execute'),
  'nor set them');

-- ----------------------------------------- one surge moves every block
select lives_ok($$ select set_tier_price((select id from fx where k = 'night'),
                                         (select id from fx where k = 'paice'), 'standard', 3500) $$,
  'a price set on the reference site is accepted');
select is(pg_temp.price('berm', 'standard'), 3500,
  'its neighbour in the same block follows exactly');
select is(pg_temp.price('anchor', 'standard'), 4500,
  'another block follows at its adjustment');
select is(pg_temp.price('neigh', 'standard'), 4500,
  'and both its sites charge the same');
select is(pg_temp.price('anchor', 'priority'), 5000,
  'a type whose reference price did not move stays where it was');

-- --------------------------------------- no site is priced on its own
select throws_like($$ select set_tier_price((select id from fx where k = 'night'),
                                            (select id from fx where k = 'neigh'), 'standard', 2000) $$,
  'REFERENCE_PRICE_ONLY%', 'a price on any other site is refused by name');
select is(pg_temp.price('neigh', 'standard'), 4500, 'and changes nothing');

-- ------------------------------------------- a block's adjustment moves
select ok(set_block_offsets((select block_id from property where id = (select id from fx where k = 'anchor')),
                            '[{"code":"standard","offset_cents":-500},{"code":"priority","offset_cents":0}]') >= 1,
  'saving a block''s adjustments re-prices its upcoming nights');
select is(pg_temp.price('anchor', 'standard'), 3000, 'the anchor at reference − $5');
select is(pg_temp.price('neigh', 'standard'), 3000, 'the neighbour at the same');
select is(pg_temp.price('neigh', 'priority'), 4000, 'priority at the reference price');
select is(pg_temp.price('paice', 'standard'), 3500, 'the reference site is untouched');

select throws_like($$ select set_block_offsets((select block_id from property where id = (select id from fx where k = 'paice')),
                                              '[{"code":"standard","offset_cents":500}]') $$,
  'REFERENCE_BLOCK%', 'the reference block cannot be given an adjustment');
select throws_like($$ select set_block_offsets((select block_id from property where id = (select id from fx where k = 'anchor')),
                                              '[{"code":"standard","offset_cents":20000}]') $$,
  'BAD_OFFSET%', 'an adjustment over $100 is refused');

-- -------------------------- a template keeps the blocks at their prices
insert into event_template (id, name, tiers)
values ('b1b1b1b1-0000-4000-8000-000000000001', 'TEST — B1 surge',
        '[{"code":"standard","price_cents":6000},{"code":"priority","price_cents":7000}]');
select lives_ok($$ select apply_price_template((select id from fx where k = 'night'),
                                              'b1b1b1b1-0000-4000-8000-000000000001') $$,
  'a template applied to the whole night');
select is(pg_temp.price('neigh', 'standard'), 5500,
  'leaves another block at its adjustment, not flattened to the template');

-- ------------------------------- shown is charged, whichever site is picked
select is(pg_temp.shown('Gribblehurst (test)', 'standard'), pg_temp.price('neigh', 'standard'),
  'the block price the booking page shows is the neighbour''s price too');
insert into fx
select 'held', hold_booking(
  (select id from fx where k = 'night'), (select id from fx where k = 'neigh'), 'standard',
  'b1.test@example.com', null, null, 'B1TEST', 30, 'online', false, 'stripe', false);
select is(
  (select amount_cents from booking where id = (select id from fx where k = 'held')),
  pg_temp.shown('Gribblehurst (test)', 'standard'),
  'and a hold at the neighbour charges exactly that');

select * from finish();
rollback;
