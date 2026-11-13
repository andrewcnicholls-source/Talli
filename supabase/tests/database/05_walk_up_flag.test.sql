-- =====================================================================
--  Walk-ups on the night (plan A3, 20261114100000_talli_walk_up_flag).
--
--  The booking page says "Sold out online — walk-up spaces on the night"
--  from one yes/no in v_block_tier_availability. Yes only while a space
--  of that type is held for the gate and unsold; never a count.
--
--  Uses the two fixture nights in seed-test-nights.sql, as they are seeded.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(9);

-- ------------------------------------------------------------- the shape
select has_column('v_block_tier_availability', 'walk_ups_on_the_night',
  'the block view says whether walk-ups are left');
select col_type_is('v_block_tier_availability', 'walk_ups_on_the_night', 'boolean',
  'as a yes/no, not a count');
select is(
  (select reloptions @> array['security_invoker=true'] from pg_class
    where oid = 'public.v_block_tier_availability'::regclass),
  true, 'and the view still runs as the caller');

-- -------------------------------------------- sold out online, gate left
-- Night 2: 86 Paice Ave Standard is 2 spaces, both held for the gate.
select is(
  (select spots_left from v_block_tier_availability
    where event_id = '7e57e000-0000-4000-8000-000000000002' and code = 'standard'),
  0, 'a type whose every space is held for the gate is sold out online');
select is(
  (select walk_ups_on_the_night from v_block_tier_availability
    where event_id = '7e57e000-0000-4000-8000-000000000002' and code = 'standard'),
  true, 'and says walk-ups are still possible');

-- Night 2 Priority: one space, none held back.
select is(
  (select walk_ups_on_the_night from v_block_tier_availability
    where event_id = '7e57e000-0000-4000-8000-000000000002' and code = 'priority'),
  false, 'a type with nothing held for the gate says no walk-ups');

-- ------------------------------------------ the gate sells its last space
-- Sell both gate spaces at the gate, as the warden would.
update offer_tier t set gate_reserve = 0, manually_sold_out = true
  from event_offer o
 where o.id = t.event_offer_id
   and o.event_id = '7e57e000-0000-4000-8000-000000000002'
   and t.code = 'standard';
select is(
  (select walk_ups_on_the_night from v_block_tier_availability
    where event_id = '7e57e000-0000-4000-8000-000000000002' and code = 'standard'),
  false, 'a type marked sold out says no walk-ups either');

-- ------------------------------------- the public can read it, not more
set local role anon;
select is(
  (select walk_ups_on_the_night from v_block_tier_availability
    where event_id = '7e57e000-0000-4000-8000-000000000001' and code = 'priority'
      and block_name = 'Gribblehurst (test)'),
  true, 'the public sees the flag (Gribblehurst Priority holds one per site)');
select is(
  (select count(*)::int from information_schema.columns
    where table_name = 'v_block_tier_availability'
      and column_name ~ '(gate|reserve|walk_up_count|spots_left_gate)'),
  0, 'and no column that would say how many');
reset role;

select * from finish();
rollback;
