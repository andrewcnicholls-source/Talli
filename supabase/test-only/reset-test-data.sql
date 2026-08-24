-- =====================================================================
--  TEST ENVIRONMENT ONLY — never run this against production.
--
--  Lives outside supabase/migrations/ deliberately, so `supabase db push`
--  can never pick it up and carry it to the live site.
--
--  Re-runnable. Every run:
--    * throws away all test bookings and interest registrations
--    * re-anchors the five fixtures to dates relative to TODAY, so the
--      test site never goes stale and always has something on sale
--    * renames every fixture with a TEST prefix
--
--  Run it whenever the test data has drifted or the fixtures have aged
--  past their dates. Nothing here touches structure, pricing or bays —
--  those stay exactly as production has them.
-- =====================================================================

-- ---- 1. Clear the customer-shaped data. Test bookings are disposable.
delete from bay_allocation;
delete from booking;
delete from event_interest;
delete from processed_webhook_event;

-- ---- 2. Re-anchor the fixtures relative to now.
--
-- The five cover the states actually worth rehearsing:
--   on sale tomorrow      — the ordinary happy path
--   on sale next week     — a second fixture, so the picker has a choice
--   online sales closed   — the gate-only path and ONLINE_SALES_CLOSED
--   announced, no prices  — the register-interest capture
--   draft                 — must be invisible to the public key
--
-- Tier arrival and departure windows shift by exactly the same amount as
-- the fixture moves, so every relationship the migrations established
-- (including "be back at your car by" landing after full time) is kept.

create temporary table test_fixture (id uuid, new_name text, new_status text, new_start timestamptz);

insert into test_fixture values
  ('44444444-4444-4444-4444-444444444401',
   'TEST — Tomorrow Night (on sale)', 'on_sale',
   (date_trunc('day', now() at time zone 'Pacific/Auckland')
      + interval '1 day' + interval '19 hours 5 minutes') at time zone 'Pacific/Auckland'),

  ('44444444-4444-4444-4444-444444444402',
   'TEST — Next Week (on sale)', 'on_sale',
   (date_trunc('day', now() at time zone 'Pacific/Auckland')
      + interval '8 days' + interval '16 hours 35 minutes') at time zone 'Pacific/Auckland'),

  ('44444444-4444-4444-4444-444444444403',
   'TEST — Online Sales Closed (gate only)', 'on_sale',
   now() + interval '2 hours'),

  ('44444444-4444-4444-4444-444444444404',
   'TEST — Announced, No Prices Yet', 'announced',
   (date_trunc('day', now() at time zone 'Pacific/Auckland')
      + interval '40 days' + interval '19 hours 5 minutes') at time zone 'Pacific/Auckland'),

  ('44444444-4444-4444-4444-444444444405',
   'TEST — Draft, Hidden From Public', 'draft',
   (date_trunc('day', now() at time zone 'Pacific/Auckland')
      + interval '60 days' + interval '19 hours 10 minutes') at time zone 'Pacific/Auckland');

-- Tiers move first: the delta needs the event's OLD starts_at, which the
-- next statement is about to overwrite.
update offer_tier t
set arrival_from  = t.arrival_from  + (f.new_start - e.starts_at),
    arrival_until = t.arrival_until + (f.new_start - e.starts_at),
    departure_by  = case when t.departure_by is null then null
                         else t.departure_by + (f.new_start - e.starts_at) end
from event_offer eo, event e, test_fixture f
where eo.id = t.event_offer_id
  and e.id = eo.event_id
  and f.id = e.id;

update event e
set name            = f.new_name,
    status          = f.new_status,
    starts_at       = f.new_start,
    gates_open_at   = f.new_start - interval '150 minutes',
    expected_end_at = f.new_start + interval '2 hours 30 minutes',
    -- One fixture is deliberately past its cutoff so the gate-only path
    -- and the ONLINE_SALES_CLOSED error can both be exercised on demand.
    online_sales_close_at = case
      when f.id = '44444444-4444-4444-4444-444444444403'
        then now() - interval '30 minutes'
      else f.new_start - interval '45 minutes'
    end
from test_fixture f
where f.id = e.id;

drop table test_fixture;
