-- =====================================================================
--  TEST ENVIRONMENT ONLY — never run this against production.
--
--  Lives outside supabase/migrations/ deliberately, so `supabase db push`
--  can never pick it up and carry it to the live site. scripts/check.sh
--  enforces that no test-only fixture SQL leaks into the migrations
--  directory.
--
--  reset-test-data.sql gives you five fixtures covering the five STATES
--  worth rehearsing, anchored relative to today. That is the right tool
--  for "does the gate-only path still work".
--
--  This is the other half: a full season of dated fixtures running from
--  September to the end of December 2026, so the booking flow, the event
--  picker, the calendar and the gate screen all have a realistic amount
--  of stuff in them. Use it when the test site has gone quiet because
--  every fixture has aged into the past.
--
--  Re-runnable. Every run rebuilds the eighteen season fixtures from
--  scratch, discarding any test bookings made against them. It does not
--  touch the five state fixtures (…4401–…4405), the properties, the
--  zones or the bays.
--
--  Every fixture is prefixed "TEST —" so nobody can mistake the test
--  site for a published schedule. The dates and matchups are invented.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  1. Clear out any previous run.
--
--  booking references event with ON DELETE RESTRICT, so the disposable
--  customer-shaped rows have to go first. Scoped by the fixed UUID block
--  …4410–…4427 so a re-run never touches the state fixtures or any
--  booking made against them.
-- ---------------------------------------------------------------------
create temporary table season_ids on commit drop as
select ('44444444-4444-4444-4444-4444444444' || to_hex(n))::uuid as id
from generate_series(16, 39) as n;   -- 0x10 .. 0x27, eighteen used

delete from bay_allocation  where event_id in (select id from season_ids);
delete from booking         where event_id in (select id from season_ids);
delete from event_interest  where event_id in (select id from season_ids);
delete from event           where id       in (select id from season_ids);
--  event_offer and offer_tier cascade from event.

-- ---------------------------------------------------------------------
--  2. The season.
--
--  Kick-offs are Auckland local time. Daylight saving starts 27 Sep
--  2026, so the September fixtures are NZST and everything after is
--  NZDT — `at time zone 'Pacific/Auckland'` resolves that rather than us
--  hardcoding an offset.
--
--  Status mix is deliberate: mostly on_sale so there is always something
--  bookable, four announced so register-interest has somewhere to land,
--  and two draft that must stay invisible to the public key.
-- ---------------------------------------------------------------------
create temporary table season (
  id           uuid,
  name         text,
  kickoff      timestamp,      -- Auckland local, resolved below
  demand_tier  text,
  status       text
) on commit drop;

insert into season (id, name, kickoff, demand_tier, status) values
  -- September — NPC club rugby, NZST
  ('44444444-4444-4444-4444-444444444410', 'TEST — Auckland v Canterbury',      '2026-09-05 19:05', 'high',     'on_sale'),
  ('44444444-4444-4444-4444-444444444411', 'TEST — Auckland v Tasman',          '2026-09-09 19:35', 'low',      'on_sale'),
  ('44444444-4444-4444-4444-444444444412', 'TEST — Auckland v Wellington',      '2026-09-12 16:35', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-444444444413', 'TEST — Auckland v Waikato',         '2026-09-18 19:05', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-444444444414', 'TEST — All Blacks v Australia',     '2026-09-26 19:05', 'premium',  'on_sale'),

  -- October — finals month, NZDT from 27 Sep
  ('44444444-4444-4444-4444-444444444415', 'TEST — Auckland v Otago',           '2026-10-03 19:05', 'high',     'on_sale'),
  ('44444444-4444-4444-4444-444444444416', 'TEST — Auckland v Bay of Plenty',   '2026-10-10 16:05', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-444444444417', 'TEST — Auckland v Northland',       '2026-10-16 19:35', 'low',      'on_sale'),
  ('44444444-4444-4444-4444-444444444418', 'TEST — NPC Final',                  '2026-10-24 19:05', 'premium',  'on_sale'),
  ('44444444-4444-4444-4444-444444444419', 'TEST — Spring Concert Series',      '2026-10-31 18:00', 'standard', 'announced'),

  -- November — concerts and one-offs
  ('44444444-4444-4444-4444-44444444441a', 'TEST — Stadium Concert (big night)','2026-11-07 19:05', 'premium',  'on_sale'),
  ('44444444-4444-4444-4444-44444444441b', 'TEST — Auckland FC v Wellington',   '2026-11-14 16:35', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-44444444441c', 'TEST — Summer Sevens',              '2026-11-21 19:05', 'high',     'announced'),
  ('44444444-4444-4444-4444-44444444441d', 'TEST — Charity Match',              '2026-11-28 19:05', 'standard', 'announced'),

  -- December — cricket season opens, afternoon starts
  ('44444444-4444-4444-4444-44444444441e', 'TEST — Black Caps v England (T20)', '2026-12-05 14:35', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-44444444441f', 'TEST — Black Caps v England (ODI)', '2026-12-11 19:05', 'high',     'announced'),
  ('44444444-4444-4444-4444-444444444420', 'TEST — Boxing Day Fixture',         '2026-12-19 14:05', 'low',      'draft'),
  ('44444444-4444-4444-4444-444444444421', 'TEST — New Year Warm-up',           '2026-12-30 14:35', 'standard', 'draft');

insert into event (id, name, venue, starts_at, gates_open_at, expected_end_at,
                   demand_tier, status, online_sales_close_at)
select
  s.id,
  s.name,
  'Eden Park',
  s.kickoff at time zone 'Pacific/Auckland',
  (s.kickoff at time zone 'Pacific/Auckland') - interval '150 minutes',
  (s.kickoff at time zone 'Pacific/Auckland') + interval '2 hours 30 minutes',
  s.demand_tier,
  s.status,
  (s.kickoff at time zone 'Pacific/Auckland') - interval '45 minutes'
from season s;

-- ---------------------------------------------------------------------
--  3. One offer per fixture, against 86 Paice Ave.
--
--  The neighbour's berm at 84 is reached through the berm zone codes on
--  the tiers below, not through a second offer — same as the existing
--  fixtures.
-- ---------------------------------------------------------------------
insert into event_offer (event_id, property_id)
select s.id, '22222222-2222-2222-2222-222222222222'
from season s;

-- ---------------------------------------------------------------------
--  4. Tiers.
--
--  Shape and arrival windows are copied from the existing premium
--  fixture so the relationships the migrations established are kept:
--  quick_getaway opens late and carries a departure_by that lands after
--  full time, near_road shuts earliest, valet runs latest.
--
--  Prices scale off the premium set by demand tier and round to the
--  nearest dollar, so a low-demand Wednesday is not priced like a test
--  match.
-- ---------------------------------------------------------------------
create temporary table tier_template (
  code            text,
  label           text,
  premium_cents   int,
  zone_codes      text[],
  bay_kind        text,
  clear_exit      boolean,
  from_offset_min int,          -- relative to kick-off, negative = before
  until_offset_min int,
  depart_offset_min int,        -- null = no departure obligation
  sort_order      int
) on commit drop;

insert into tier_template values
  ('valet',            'Valet — we hold your keys and bring the car to you',
     4000, array['valet'],                'any',            false, -150,  -5, null,  1),
  ('priority',         'Priority exit — near the road, nobody parked in behind you',
     4000, array['front_lawn','berm'],    'free_exit',      false, -150, -10, null,  2),
  ('near_road',        'Near the road — a short wait for the car in front to move',
     5000, array['front_lawn'],           'may_be_blocked', false, -150, -40, null,  3),
  ('standard',         'Standard — best value, expect to wait for the drive to clear',
     3000, array['back_yard'],            'may_be_blocked', false, -150, -10, null,  4),
  ('guaranteed_clear', 'Guaranteed clear — nobody parks in behind you',
     7500, array['back_yard'],            'may_be_blocked', true,  -150, -10, null,  5),
  ('quick_getaway',    'Quick getaway — first car out, but you are blocking someone in, so please come straight back after the final whistle',
     3500, array['back_yard'],            'free_exit',      false,  -45,  -5,  170,  6);

insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes,
                        bay_kind, guarantees_clear_exit,
                        arrival_from, arrival_until, departure_by,
                        sort_order, active)
select
  eo.id,
  t.code,
  t.label,
  greatest(100, round(t.premium_cents * case s.demand_tier
                                           when 'low'      then 0.60
                                           when 'standard' then 0.75
                                           when 'high'     then 0.90
                                           else                 1.00
                                         end / 100.0) * 100)::int,
  t.zone_codes,
  t.bay_kind,
  t.clear_exit,
  e.starts_at + make_interval(mins => t.from_offset_min),
  e.starts_at + make_interval(mins => t.until_offset_min),
  case when t.depart_offset_min is null then null
       else e.starts_at + make_interval(mins => t.depart_offset_min) end,
  t.sort_order,
  true
from season s
join event e        on e.id = s.id
join event_offer eo on eo.event_id = s.id
cross join tier_template t;

commit;

-- ---------------------------------------------------------------------
--  What you should see afterwards: eighteen fixtures from 5 Sep to
--  30 Dec, twelve of them on sale, four announced, two draft — plus
--  whatever the five state fixtures are currently set to.
-- ---------------------------------------------------------------------
