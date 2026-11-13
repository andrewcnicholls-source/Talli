-- =====================================================================
--  Selling a space: the last one, the ones held for the gate, and the
--  ones that come back when a checkout is abandoned.
--
--  Runs inside one transaction that is rolled back, against the
--  fixture nights in supabase/test-only/seed-test-nights.sql. Run with
--  `bash scripts/check.sh` (or `supabase test db`).
--
--  True concurrency — two browsers at the same instant — cannot happen
--  inside one transaction; tests/functions/race.test.js does that with
--  two connections. This file proves the arithmetic both rely on.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

-- The fixture night's sites, by name, so a failure reads as English.
create temp table site as
select * from (values
  ('night',  '7e57e000-0000-4000-8000-000000000001'::uuid),
  ('soldout','7e57e000-0000-4000-8000-000000000002'::uuid),
  ('paice',  '22222222-2222-2222-2222-222222222222'::uuid),
  ('berm',   '22222222-2222-2222-2222-222222222223'::uuid),
  ('grib',   '22222222-2222-2222-2222-2222222222a1'::uuid)
) as v(k, id);
create function pg_temp.id(text) returns uuid language sql as $$ select id from site where k = $1 $$;

create function pg_temp.left_online(p_event text, p_site text, p_code text) returns int
language sql as $$
  select spots_left from v_tier_availability
   where event_id = pg_temp.id(p_event) and property_id = pg_temp.id(p_site) and code = p_code
$$;
create function pg_temp.left_gate(p_event text, p_site text, p_code text) returns int
language sql as $$
  select spots_left_gate from v_tier_availability
   where event_id = pg_temp.id(p_event) and property_id = pg_temp.id(p_site) and code = p_code
$$;
create function pg_temp.hold(p_event text, p_site text, p_code text, p_rego text) returns uuid
language sql as $$
  select hold_booking(pg_temp.id(p_event), pg_temp.id(p_site), p_code,
                      'buyer@example.com', 'Buyer', null, p_rego)
$$;

-- ---------------------------------------------------------------------
-- The last space: the berm has two Standard, none held for the gate.
-- ---------------------------------------------------------------------
select is(pg_temp.left_online('night', 'berm', 'standard'), 2, 'the berm starts with 2 Standard online');
select isnt(pg_temp.hold('night', 'berm', 'standard', 'AAA111'), null, 'first buyer gets a space');
select isnt(pg_temp.hold('night', 'berm', 'standard', 'AAA222'), null, 'second buyer gets the last space');
select throws_like($$ select pg_temp.hold('night', 'berm', 'standard', 'AAA333') $$,
  'SOLD_OUT%', 'a third buyer is refused by name: SOLD_OUT');
select is(pg_temp.left_online('night', 'berm', 'standard'), 0, 'and the page shows none left');

-- ---------------------------------------------------------------------
-- The price paid is the tier's price. hold_booking takes no amount.
-- ---------------------------------------------------------------------
select is((select amount_cents from booking where vehicle_rego = 'AAA111'), 3000,
  'a booking costs what the tier says, not what anyone sent');

-- ---------------------------------------------------------------------
-- The gate reserve: 86 Paice Ave has 4 Standard, 1 held for walk-ups.
-- ---------------------------------------------------------------------
select is(pg_temp.left_online('night', 'paice', 'standard'), 3, '3 of 4 Standard sell online');
select pg_temp.hold('night', 'paice', 'standard', 'BBB' || n) from generate_series(1, 3) n;
select throws_like($$ select pg_temp.hold('night', 'paice', 'standard', 'BBB4') $$,
  'HELD_FOR_GATE%', 'the fourth online buyer is refused: HELD_FOR_GATE');
select is(pg_temp.left_gate('night', 'paice', 'standard'), 1, 'the gate still has 1');
select isnt(sell_at_gate(pg_temp.id('night'), pg_temp.id('paice'), 'standard', 'cash', 'GATE1'),
  null, 'a walk-up buys the space held for them');
-- Standard is now full at 86 and at the berm, so the next walk-up is not
-- more Standard: it takes a Priority space at 86 (plan B5; the whole
-- order is in 09_placement_oversell_lost).
create temp table gate2 as
  select sell_at_gate(pg_temp.id('night'), pg_temp.id('paice'), 'standard', 'cash', 'GATE2') as id;
select is((select coalesce(b.space_code, b.tier_code) from booking b
            where b.id = (select id from gate2)),
  'priority', 'after that a Standard walk-up takes a Priority space, never more Standard');

-- ---------------------------------------------------------------------
-- Sold out online is not sold out: night 2 holds every Standard for
-- the gate. The page reads 0, the gate reads 2.
-- ---------------------------------------------------------------------
select is(pg_temp.left_online('soldout', 'paice', 'standard'), 0, 'night 2: nothing online');
select is(pg_temp.left_gate('soldout', 'paice', 'standard'), 2, 'night 2: walk-ups still available');

-- ---------------------------------------------------------------------
-- An abandoned checkout gives its space back.
-- ---------------------------------------------------------------------
select pg_temp.hold('night', 'grib', 'standard', 'CCC1');
select is(pg_temp.left_online('night', 'grib', 'standard'), 2, 'a hold takes a space');
update booking set hold_expires_at = now() - interval '1 minute' where vehicle_rego = 'CCC1';
select is(pg_temp.left_online('night', 'grib', 'standard'), 3,
  'an expired hold stops counting at once, before anything sweeps it');
select ok(expire_stale_holds() >= 1, 'the sweep marks it expired');
select is((select status from booking where vehicle_rego = 'CCC1'), 'expired', 'and says so on the booking');

select * from finish();
rollback;
