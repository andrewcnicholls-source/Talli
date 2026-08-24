-- Talli Parking — seed for 86 Paice Ave.
--
-- STILL TO CONFIRM:
--   * Whether the front lawn has double-park positions. The map shows pink at
--     the top right, but "6 in the front lawn" reads like 6 cars total, so it
--     is seeded with none.
--   * Kickoff times. Eden Park publishes dates but not times, and every
--     arrival window derives from starts_at.
--
-- Fixture dates are real, from edenpark.co.nz in August 2026.
-- Times are +12 (NZST) through 26 Sep and +13 (NZDT) from 27 Sep 2026.

insert into host (id, name, email, phone, platform_share, payout_method, notes)
values
  ('11111111-1111-1111-1111-111111111111',
   'Talli Limited', 'andrew.c.nicholls@gmail.com', '+6421347028',
   1.0000, 'manual_bank', 'Talli''s own property'),
  ('11111111-1111-1111-1111-111111111112',
   'Neighbour — 84 Paice Ave berm', 'unknown@example.com', null,
   1.0000, 'none', 'Informal: they let us use the berm when it is free. No payment. Confirm before advertising it as bookable.');

insert into property (id, host_id, name, address, walk_minutes, access_notes)
values
  ('22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111',
   '86 Paice Ave', '86 Paice Avenue, Sandringham, Auckland 1025', 12,
   'Enter from Paice Ave. Marshal on site from 2 hours before kickoff.'),
  ('22222222-2222-2222-2222-222222222223',
   '11111111-1111-1111-1111-111111111112',
   '84 Paice Ave berm', '84 Paice Avenue, Sandringham, Auckland 1025', 12,
   'Neighbour''s berm. Availability is not guaranteed. Gate sales only.');

-- ZONE PLAN. Edit here; bays are generated from it.
create temporary table zone_plan (
  property_id uuid, code text, label text, bays int, double_park int,
  keys_held boolean, reservable boolean, requires_consent boolean,
  exit_rank int, exit_note text, consent_prompt text
);

insert into zone_plan values
  -- NOT reservable: council land, so you cannot promise in advance that it
  -- will be free. Auckland's parking bylaw also prohibits berm parking where
  -- the road has kerb and channel, enforceable once signs go up.
  ('22222222-2222-2222-2222-222222222222','berm','Street berm',
     7, 0, false, false, true,  1,
     'Straight out onto Paice Ave. Quickest exit going.',
     'Happy to be parked on the grass verge by the road if that gets you out fastest? It is council land, so on rare occasions a ticket is possible.'),
  ('22222222-2222-2222-2222-222222222222','front_lawn','Front lawn',
     6, 0, false, true,  false, 2,
     'On the property, short run to the road. Out in a couple of minutes.', null),
  ('22222222-2222-2222-2222-222222222222','valet','Valet lane',
     6, 0, true,  true,  false, 3,
     'We hold your keys and bring the car to you.', null),
  ('22222222-2222-2222-2222-222222222222','back_yard','Back yard',
     7, 7, false, true,  false, 4,
     'Furthest in. Expect to wait for the drive to clear.', null),
  ('22222222-2222-2222-2222-222222222223','neighbour_berm','Neighbour''s berm',
     3, 0, false, false, true,  1,
     'Straight out onto Paice Ave.',
     'Happy to be parked on the grass verge by the road?');

insert into zone (property_id, code, label, keys_held, reservable_in_advance,
                  requires_consent, exit_rank, exit_note, consent_prompt)
select property_id, code, label, keys_held, reservable, requires_consent,
       exit_rank, exit_note, consent_prompt
from zone_plan;

insert into bay (zone_id, label, size_class)
select z.id, zp.label || ' ' || g, 'standard'
from zone_plan zp
join zone z on z.property_id = zp.property_id and z.code = zp.code
cross join generate_series(1, zp.bays) g;

-- Double-park positions, paired one-to-one onto bays in the same zone.
insert into bay (zone_id, label, blocks_bay_id)
select z.id, 'Double-park behind ' || tgt.label, tgt.id
from zone_plan zp
join zone z on z.property_id = zp.property_id and z.code = zp.code
join lateral (
  select b.id, b.label from bay b
  where b.zone_id = z.id and b.blocks_bay_id is null
  order by b.label limit zp.double_park
) tgt on true
where zp.double_park > 0;

drop table zone_plan;

insert into event (id, name, starts_at, demand_tier, status) values
  ('44444444-4444-4444-4444-444444444401', 'Auckland v Bay of Plenty',
     '2026-08-28 19:05:00+12', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-444444444402', 'Auckland v Counties Manukau',
     '2026-09-12 16:35:00+12', 'standard', 'on_sale'),
  ('44444444-4444-4444-4444-444444444403', 'Auckland v Manawatu',
     '2026-09-25 19:05:00+12', 'low', 'draft'),
  ('44444444-4444-4444-4444-444444444404', 'All Blacks v Australia (Bledisloe Cup)',
     '2026-10-10 19:05:00+13', 'premium', 'on_sale'),
  ('44444444-4444-4444-4444-444444444405', 'BLACKCAPS v India — T20',
     '2026-10-30 19:10:00+13', 'high', 'draft');

update event set
  gates_open_at   = starts_at - interval '150 minutes',
  expected_end_at = starts_at + interval '2 hours 30 minutes';

-- Only 86 Paice Ave goes on sale online.
insert into event_offer (event_id, property_id)
select e.id, '22222222-2222-2222-2222-222222222222' from event e;

-- PRICE MATRIX. SELL THE PROMISE, NOT THE PLACE — no tier is named after a
-- location, because the moment you sell "front lawn" you owe them the front
-- lawn. 'priority' lists both the lawn and the berm; online bookings can only
-- land on the lawn, because the berm is not reservable_in_advance.
--
-- guaranteed_clear is the only product that destroys inventory, and it is
-- switched off at high and premium demand: on a sold-out night it would have
-- to out-price priority, which is faster out and clear by nature.
with pricing(demand_tier, priority, valet, yard, yard_clear, dbl) as (values
  ('low',      2200, 3000, 1500, 2000, 1200),
  ('standard', 3200, 4000, 2500, 3500, 2000),
  ('high',     5000, 5500, 3500, 6500, 3000),
  ('premium',  6000, 7000, 4000, 7500, 3500)
)
insert into offer_tier
  (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
   guarantees_clear_exit, arrival_from, arrival_until, departure_by,
   sort_order, active)
select eo.id, v.code, v.label, v.price_cents, v.zone_codes, v.bay_kind,
       v.guarantees_clear_exit,
       e.starts_at + v.from_offset,
       e.starts_at + v.until_offset,
       case when v.depart_offset is null then null else e.starts_at + v.depart_offset end,
       v.sort_order,
       case when v.guarantees_clear_exit
            then e.demand_tier in ('low','standard') else true end
from event_offer eo
join event   e on e.id = eo.event_id
join pricing p on p.demand_tier = e.demand_tier
cross join lateral (values
  ('valet',            'Valet — we hold your keys and bring the car to you',
     p.valet,      array['valet'],              'clear',    false,
     interval '-150 minutes', interval '-5 minutes',  null::interval, 1),
  ('priority',         'Priority exit — parked near the road, out in a couple of minutes',
     p.priority,   array['front_lawn','berm'],  'clear',    false,
     interval '-150 minutes', interval '-10 minutes', null::interval, 2),
  ('standard',         'Standard — best value, expect to wait for the drive to clear',
     p.yard,       array['back_yard'],          'clear',    false,
     interval '-150 minutes', interval '-10 minutes', null::interval, 3),
  ('guaranteed_clear', 'Guaranteed clear — nobody parks in behind you',
     p.yard_clear, array['back_yard'],          'clear',    true,
     interval '-150 minutes', interval '-10 minutes', null::interval, 4),
  ('quick_getaway',    'Quick getaway — parked in behind someone, must leave before full time',
     p.dbl,        array['back_yard'],          'blocking', false,
     interval '-45 minutes',  interval '-5 minutes',  interval '+10 minutes', 5)
) as v(code, label, price_cents, zone_codes, bay_kind, guarantees_clear_exit,
       from_offset, until_offset, depart_offset, sort_order);
