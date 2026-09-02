-- =====================================================================
--  TEST ENVIRONMENT ONLY — never run this against production.
--
--  Lives outside supabase/migrations/ deliberately, so `supabase db push`
--  can never pick it up and carry it to the live site.
--
--  Re-runnable. Every run:
--    * throws away all test bookings and interest registrations
--    * makes the event list exactly the schedule below and nothing else
--      — anything not on the list is deleted
--    * re-derives gates, end time and the online cutoff from each
--      fixture's start
--    * rebuilds the three-tier price ladder for every fixture
--
--  Run it whenever the test data has drifted, or when Eden Park
--  announces something new — add the row here, run it, and the test
--  site matches the real calendar again. Nothing here touches
--  structure, property, zones or bays; those stay exactly as
--  production has them.
--
--  WHY REAL FIXTURES, NOT INVENTED ONES
--  Test used to carry five made-up fixtures re-anchored to today. That
--  kept the dates fresh but meant device testing never looked like the
--  real thing. This lists what Eden Park has actually announced, so the
--  picker on a phone shows the season you would really be selling.
--
--  WHAT COUNTS AS AN EVENT HERE
--  A crowd, not a booking in the venue's diary. Under a couple of
--  thousand people nobody walks to Paice Ave, so it is not a night the
--  driveway sells and it does not belong in the picker. The NPC games
--  are the floor — already marginal, listed because they are the
--  smallest thing still worth a look. Eden Park's smaller diary
--  entries — the Father's Day experience, Art in the Park, function
--  and tour bookings — are deliberately absent.
--
--  The `TEST — ` prefix stays on every name. It is the one thing that
--  tells you at a glance, on a phone, that you are not on talli.co.nz.
--
--  SOURCES AND DATES
--  Dates and start times below are as published by Eden Park and the
--  ticketing sites as at 2 September 2026. Times marked TBC in the
--  comments were not published and are a sensible guess for the code
--  and format of event; correct them here when the real time appears.
-- =====================================================================

begin;

-- ---- 1. Clear the customer-shaped data. Test bookings are disposable.
--
-- booking cascades to bay_allocation, booking_addon, booking_cancellation
-- and booking_transfer, and it must go before event: booking.event_id is
-- ON DELETE RESTRICT, on purpose, so nothing can quietly delete a night
-- someone has paid for.
delete from bay_allocation;
delete from booking;
delete from event_interest;
delete from processed_webhook_event;

-- ---- 2. The schedule.
--
-- status:      on_sale   — sells online now
--              announced — listed, no prices, register-interest capture
-- demand_tier: drives the price ladder in step 7.
-- runs_for:    how long the crowd is inside; sets expected_end_at.
create temporary table known_event (
  id          uuid primary key,
  name        text not null,
  starts_at   timestamptz not null,
  demand_tier text not null,
  status      text not null,
  runs_for    interval not null default interval '2 hours 30 minutes'
) on commit drop;

-- Local wall-clock times, converted by Postgres. Auckland goes to NZDT on
-- 27 September 2026 and back to NZST on 4 April 2027, so writing the
-- offsets by hand would get half of these rows wrong.
insert into known_event (id, name, starts_at, demand_tier, status, runs_for) values
  -- Sat 12 Sep 2026 — NPC, 2.05pm (FPC curtain-raiser 11.35am).
  ('ede22026-0000-4000-8000-000000000001',
   'TEST — Auckland v Counties Manukau (NPC)',
   timestamp '2026-09-12 14:05' at time zone 'Pacific/Auckland',
   'standard', 'on_sale', interval '2 hours 30 minutes'),

  -- Fri 25 Sep 2026 — NPC. Kick-off TBC; 7.05pm is the Friday norm.
  ('ede22026-0000-4000-8000-000000000002',
   'TEST — Auckland v Manawatu (NPC)',
   timestamp '2026-09-25 19:05' at time zone 'Pacific/Auckland',
   'standard', 'on_sale', interval '2 hours 30 minutes'),

  -- Sat 10 Oct 2026 — Bledisloe Cup test, 7.10pm. The biggest night here.
  ('ede22026-0000-4000-8000-000000000003',
   'TEST — All Blacks v Australia (Bledisloe Cup)',
   timestamp '2026-10-10 19:10' at time zone 'Pacific/Auckland',
   'premium', 'on_sale', interval '2 hours 30 minutes'),

  -- Fri 30 Oct 2026 — T20, 8.00pm.
  ('ede22026-0000-4000-8000-000000000004',
   'TEST — BLACKCAPS v India (T20)',
   timestamp '2026-10-30 20:00' at time zone 'Pacific/Auckland',
   'high', 'on_sale', interval '3 hours 30 minutes'),

  -- Wed 4 Nov 2026 — ODI, 3.00pm. A day game: the yard fills in
  -- daylight and empties after dark.
  ('ede22026-0000-4000-8000-000000000005',
   'TEST — BLACKCAPS v India (ODI)',
   timestamp '2026-11-04 15:00' at time zone 'Pacific/Auckland',
   'high', 'on_sale', interval '8 hours'),

  -- Tue 24 Nov 2026 — Robbie Williams, BRITPOP World Tour, with Drax
  -- Project. Doors 5.00pm; the headline set and gates are TBC.
  ('ede22026-0000-4000-8000-000000000006',
   'TEST — Robbie Williams (BRITPOP World Tour)',
   timestamp '2026-11-24 17:00' at time zone 'Pacific/Auckland',
   'premium', 'on_sale', interval '6 hours'),

  -- Thu 17 Dec 2026 — Guns N' Roses with Airbourne. Doors 5.00pm.
  ('ede22026-0000-4000-8000-000000000007',
   'TEST — Guns N'' Roses (with Airbourne)',
   timestamp '2026-12-17 17:00' at time zone 'Pacific/Auckland',
   'premium', 'on_sale', interval '6 hours'),

  -- Sat 13 and Sun 14 Mar 2027 — Bruno Mars, The Romantic Tour. Two
  -- nights; the second was added on demand. Doors TBC, 5.00pm assumed.
  -- Far enough out that Talli has no prices for them yet.
  ('ede22026-0000-4000-8000-000000000008',
   'TEST — Bruno Mars (The Romantic Tour)',
   timestamp '2027-03-13 17:00' at time zone 'Pacific/Auckland',
   'premium', 'announced', interval '6 hours'),
  ('ede22026-0000-4000-8000-000000000009',
   'TEST — Bruno Mars (The Romantic Tour, second show)',
   timestamp '2027-03-14 17:00' at time zone 'Pacific/Auckland',
   'premium', 'announced', interval '6 hours'),

  -- Sun 25 Apr 2027 — Anzac Round. The Warriors' first NRL match at
  -- Eden Park in thirteen years. Opponent and kick-off wait on the 2027
  -- NRL draw; 4.00pm is the Anzac Round norm in New Zealand.
  ('ede22026-0000-4000-8000-00000000000a',
   'TEST — One NZ Warriors (Anzac Round)',
   timestamp '2027-04-25 16:00' at time zone 'Pacific/Auckland',
   'premium', 'announced', interval '2 hours 30 minutes'),

  -- Sun 13 Jun 2027 — the Warriors open Origin week, three days before
  -- the Origin match itself. Opponent and kick-off TBC; afternoon.
  ('ede22026-0000-4000-8000-00000000000b',
   'TEST — One NZ Warriors (Origin week)',
   timestamp '2027-06-13 16:00' at time zone 'Pacific/Auckland',
   'premium', 'announced', interval '2 hours 30 minutes'),

  -- Wed 16 Jun 2027 — State of Origin Game 2, the first ever played in
  -- New Zealand. Kick-off TBC; 8.00pm is the Origin norm.
  ('ede22026-0000-4000-8000-00000000000c',
   'TEST — State of Origin Game 2 (NSW Blues v QLD Maroons)',
   timestamp '2027-06-16 20:00' at time zone 'Pacific/Auckland',
   'premium', 'announced', interval '2 hours 30 minutes');

-- ---- 3. Anything not on the list goes.
--
-- This is the "only these" rule. event cascades to event_offer,
-- offer_tier, event_interest, event_bay_status and event_overflow_limit,
-- so a fixture that leaves the list takes its pricing with it.
delete from event e
 where not exists (select 1 from known_event k where k.id = e.id);

-- ---- 4. Put the list in, and keep it matching on every re-run.
insert into event (id, name, venue, starts_at, demand_tier, status)
select k.id, k.name, 'Eden Park', k.starts_at, k.demand_tier, k.status
  from known_event k
on conflict (id) do update set
  name        = excluded.name,
  venue       = excluded.venue,
  starts_at   = excluded.starts_at,
  demand_tier = excluded.demand_tier,
  status      = excluded.status;

-- ---- 5. Everything else about the night follows from the start time.
--
-- Gates 2h30 before, online sales shut 45 minutes before — after that
-- the gate screen is the only way to sell, which is what
-- ONLINE_SALES_CLOSED means to the booking page.
update event e set
  gates_open_at         = e.starts_at - interval '150 minutes',
  expected_end_at       = e.starts_at + k.runs_for,
  online_sales_close_at = e.starts_at - interval '45 minutes'
from known_event k
where k.id = e.id;

-- ---- 6. Only 86 Paice Ave goes on sale online.
insert into event_offer (event_id, property_id)
select k.id, '22222222-2222-2222-2222-222222222222' from known_event k
on conflict (event_id, property_id) do nothing;

-- ---- 7. THREE OPTIONS, EVERYWHERE.
--
-- Standard, Priority exit, Valet — the ladder migration 20260831100000
-- made the rule. Six was a menu; three is a decision. The prices are the
-- test environment's ladder, one step per demand tier; the gate screen
-- re-prices any of them on the night with set_tier_price().
--
-- Rebuilt from scratch each run. Safe only because step 1 has already
-- removed every booking: a live booking resolves the name of what it
-- bought by looking its tier_code up in offer_tier.
delete from offer_tier;

with ladder(demand_tier, standard, priority, valet) as (values
  ('low',      1800, 2400, 2400),
  ('standard', 2300, 3000, 3000),
  ('high',     2700, 3600, 3600),
  ('premium',  3000, 4000, 4000)
)
insert into offer_tier
  (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
   guarantees_clear_exit, arrival_from, arrival_until, sort_order, active)
select eo.id, v.code, v.label, v.price_cents, v.zone_codes, v.bay_kind,
       false,
       e.starts_at - interval '150 minutes',
       e.starts_at + v.until_offset,
       v.sort_order, true
  from event_offer eo
  join event  e on e.id = eo.event_id
  join ladder l on l.demand_tier = e.demand_tier
 cross join lateral (values
   ('valet',    'Valet — hand us your keys and we''ll park it for you',
      l.valet,    array['valet'],             'any',      interval '-5 minutes',  1),
   ('priority', 'Priority exit — near the road, nobody parked in behind you',
      l.priority, array['front_lawn','berm'], 'free_exit', interval '-10 minutes', 2),
   ('standard', 'Standard — best value, expect to wait for the drive to clear',
      l.standard, array['back_yard'],         'any',      interval '-10 minutes', 4)
 ) as v(code, label, price_cents, zone_codes, bay_kind, until_offset, sort_order);

commit;

-- =====================================================================
--  REHEARSING A STATE THE REAL CALENDAR DOES NOT HAPPEN TO BE IN
--
--  Real dates cost the three fixtures that used to sit permanently in
--  the states worth testing. Each is one statement away. Run one, test,
--  then re-run this whole file to put the calendar back.
--
--  Online sales closed — the gate-only path and ONLINE_SALES_CLOSED:
--
--    update event set online_sales_close_at = now() - interval '30 minutes'
--     where name = 'TEST — Auckland v Counties Manukau (NPC)';
--
--  A fixture on sale tomorrow night — the ordinary happy path, without
--  waiting for the next real one:
--
--    update event set starts_at = date_trunc('day', now() at time zone
--      'Pacific/Auckland') + interval '1 day 19 hours 5 minutes'
--      at time zone 'Pacific/Auckland'
--     where name = 'TEST — Auckland v Manawatu (NPC)';
--    -- then re-run steps 5 and 7 above, or just re-run this file after.
--
--  Draft, invisible to the public key:
--
--    update event set status = 'draft'
--     where name = 'TEST — State of Origin Game 2 (NSW Blues v QLD Maroons)';
-- =====================================================================
