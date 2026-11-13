-- =====================================================================
--  TEST ONLY — two nights the automated tests can rely on.
--
--  The calendar in reset-test-data.sql is Eden Park's real one, so its
--  nights go past and close for online sale as the weeks go by. A test
--  that booked "Robbie Williams" would start failing on 24 Nov 2026 for
--  no reason in the code. These two are dated from whenever the seed
--  runs, so they are always in the future.
--
--  Night 1 — "Fixture night": two blocks, two sites each, four hosts.
--    Paice Ave            86 Paice Ave  standard 4 (1 for the gate)  $30
--                                       priority 3 (1 for the gate)  $40
--                                       valet    2 (1 for the gate)  $45
--                         84 berm       standard 2                   $30
--    Gribblehurst (test)  anchor        standard 3                   $40
--                                       priority 2 (1 for the gate)  $50
--                         neighbour     the same
--
--  Night 2 — "Sold out online": 86 Paice Ave only, every Standard space
--    held for the gate. The website must say walk-ups only; the gate can
--    still sell.
--
--  Night 1 is the live night at the gate (plan B2).
--
--  Re-runnable: the two nights are deleted and rebuilt (with any
--  bookings on them — this is test data). Needs seed-test-block.sql.
--  Never run against production.
-- =====================================================================

delete from booking where event_id in ('7e57e000-0000-4000-8000-000000000001',
                                       '7e57e000-0000-4000-8000-000000000002');
delete from event where id in ('7e57e000-0000-4000-8000-000000000001',
                               '7e57e000-0000-4000-8000-000000000002');

insert into event (id, name, venue, starts_at, gates_open_at, expected_end_at,
                   online_sales_close_at, status)
select v.id, v.name, 'Eden Park', s, s - interval '90 minutes', s + interval '3 hours',
       s - interval '1 hour', 'on_sale'
  from (values
    ('7e57e000-0000-4000-8000-000000000001'::uuid, 'TEST — Fixture night', 14),
    ('7e57e000-0000-4000-8000-000000000002'::uuid, 'TEST — Fixture night (sold out online)', 21)
  ) as v(id, name, days)
  cross join lateral (select date_trunc('day', now()) + make_interval(days => v.days)
                             + interval '7 hours' as s) t;

insert into event_offer (event_id, property_id, status)
values ('7e57e000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222222', 'confirmed'),
       ('7e57e000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222223', 'confirmed'),
       ('7e57e000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-2222222222a1', 'confirmed'),
       ('7e57e000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-2222222222a2', 'confirmed'),
       ('7e57e000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'confirmed')
on conflict (event_id, property_id) do update set status = excluded.status;

insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                        guarantees_clear_exit, sort_order, active, capacity, gate_reserve,
                        arrival_from, arrival_until, departure_by)
select o.id, v.code, v.label, v.price, '{}'::text[], v.kind, v.code <> 'standard', v.sort, true,
       v.cap, v.reserve, e.starts_at - interval '3 hours', e.starts_at,
       e.starts_at + interval '4 hours'
  from event_offer o
  join event e on e.id = o.event_id
  join (values
    -- night, site, code, label, price, kind, sort, capacity, reserve
    (1, '22222222-2222-2222-2222-222222222222', 'standard', 'Standard',        3000, 'no_clear_exit', 1, 4, 1),
    (1, '22222222-2222-2222-2222-222222222222', 'priority', 'Priority exit',   4000, 'free_exit',     2, 3, 1),
    (1, '22222222-2222-2222-2222-222222222222', 'valet',    'Valet',           4500, 'any',           3, 2, 1),
    (1, '22222222-2222-2222-2222-222222222223', 'standard', 'Standard',        3000, 'no_clear_exit', 1, 2, 0),
    (1, '22222222-2222-2222-2222-2222222222a1', 'standard', 'Standard',        4000, 'no_clear_exit', 1, 3, 0),
    (1, '22222222-2222-2222-2222-2222222222a1', 'priority', 'Priority exit',   5000, 'free_exit',     2, 2, 1),
    (1, '22222222-2222-2222-2222-2222222222a2', 'standard', 'Standard',        4000, 'no_clear_exit', 1, 3, 0),
    (1, '22222222-2222-2222-2222-2222222222a2', 'priority', 'Priority exit',   5000, 'free_exit',     2, 2, 1),
    (2, '22222222-2222-2222-2222-222222222222', 'standard', 'Standard',        3000, 'no_clear_exit', 1, 2, 2),
    (2, '22222222-2222-2222-2222-222222222222', 'priority', 'Priority exit',   4000, 'free_exit',     2, 1, 0)
  ) as v(night, site, code, label, price, kind, sort, cap, reserve)
    on o.event_id = ('7e57e000-0000-4000-8000-00000000000' || v.night)::uuid
   and o.property_id = v.site::uuid
on conflict (event_offer_id, code) do nothing;

-- One price per block (plan B1): Gribblehurst (test) sells at the
-- reference price plus $10 for each type, which is what the prices above
-- already say. Recorded here so a change to the reference price moves
-- the fixture night's Gribblehurst prices with it rather than flattening
-- them to $30 / $40.
insert into block_tier_offset (block_id, code, offset_cents)
select b.id, v.code, v.cents
  from block b
  cross join (values ('standard', 1000), ('priority', 1000), ('valet', 1000)) as v(code, cents)
 where b.name = 'Gribblehurst (test)'
on conflict (block_id, code) do update set offset_cents = excluded.offset_cents, updated_at = now();

-- The night the gate is working (plan B2). Arrivals shows this one, and a
-- warden cannot name another. Moves the live flag off any other night.
select set_live_event('7e57e000-0000-4000-8000-000000000001');
