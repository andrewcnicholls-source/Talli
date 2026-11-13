-- =====================================================================
--  The Sites page (plan B3, 20261117100000_talli_sites_page).
--
--  Done when: a new site goes from address to on sale at three nights
--  with no SQL and no visit to Tonight. Each step of that is a call here,
--  and so is each guard: a booked site does not move or switch off, the
--  reference site does neither, an anchor is one of its own block's
--  active sites, and a night's count never goes below what has sold.
--
--  Fixture nights from seed-test-nights.sql: night 1 has Paice Ave (86,
--  the reference, and the 84 berm) and Gribblehurst (test) anchor and
--  neighbour; night 2 has 86 Paice Ave only.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(48);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night1', '7e57e000-0000-4000-8000-000000000001'),
  ('night2', '7e57e000-0000-4000-8000-000000000002'),
  ('paice',  '22222222-2222-2222-2222-222222222222'),
  ('berm',   '22222222-2222-2222-2222-222222222223'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');
create function pg_temp.fx(p text) returns uuid language sql as $$ select id from fx where k = p $$;

-- A third fixture night in the future, for the "three nights" in done-when.
insert into fx values ('night3', '7e57e000-0000-4000-8000-0000000000b3');
insert into event (id, name, venue, starts_at, gates_open_at, expected_end_at, status)
select pg_temp.fx('night3'), 'TEST — B3 third night', 'Eden Park', s, s - interval '90 minutes',
       s + interval '3 hours', 'announced'
  from (select date_trunc('day', now()) + interval '28 days 7 hours' as s) t;
insert into event_offer (event_id, property_id) values (pg_temp.fx('night3'), pg_temp.fx('paice'));
insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                        sort_order, active, capacity, gate_reserve, arrival_from, arrival_until)
select o.id, v.code, v.code, v.price, '{}', 'any', v.sort, true, 4, 1,
       now() + interval '27 days', now() + interval '28 days'
  from event_offer o
  cross join (values ('standard', 3000, 1), ('priority', 4000, 2)) as v(code, price, sort)
 where o.event_id = pg_temp.fx('night3');

create function pg_temp.tier(p_night text, p_site uuid, p_code text)
returns offer_tier language sql as $$
  select t.* from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = pg_temp.fx(p_night) and o.property_id = p_site and t.code = p_code
$$;
create function pg_temp.offer_status(p_night text, p_site uuid) returns text language sql as $$
  select status from event_offer where event_id = pg_temp.fx(p_night) and property_id = p_site
$$;

-- ------------------------------------------------------------ the shape
select ok(not has_function_privilege('anon', 'public.save_site_details(uuid, jsonb)', 'execute'),
  'the public cannot edit a site');
select ok(not has_function_privilege('authenticated', 'public.add_site(jsonb)', 'execute'),
  'nor add one');
select ok(not has_function_privilege('anon', 'public.set_site_nights(uuid, uuid[], uuid[])', 'execute'),
  'nor choose its nights');
select ok(not has_function_privilege('anon', 'public.set_site_night(uuid, uuid, jsonb)', 'execute'),
  'nor set a night''s numbers');
select ok(not has_function_privilege('anon', 'public.set_block_anchor(uuid, uuid)', 'execute'),
  'nor move an anchor');

-- ------------------------------------------- 1. a new site, from an address
insert into fx
select 'new', add_site(jsonb_build_object(
  'name', 'TEST B3 drive', 'address', '1 Invented Road, Sandringham (test)',
  'new_host_name', 'TEST B3 host', 'new_block_name', 'B3 test area',
  'lat', -36.881, 'lng', 174.741, 'walk_minutes', 11));
select ok(pg_temp.fx('new') is not null, 'a site is added from one set of details');
select is((select b.anchor_property_id from block b join property p on p.block_id = b.id
            where p.id = pg_temp.fx('new')), pg_temp.fx('new'),
  'the first site in a new area is its anchor');
select is((select walk_minutes from property where id = pg_temp.fx('new')), 11,
  'walking time is kept');
select is((select count(*)::int from property_tier_default
            where property_id = pg_temp.fx('new') and capacity = 0), 3,
  'it starts with no spaces of any type, never an assumed few');
select throws_like($$ select add_site('{"name":"x","address":"y","new_host_name":"h","new_block_name":"B3 test area"}') $$,
  'AREA_EXISTS%', 'an area is not made twice under one name');
select throws_like($$ select add_site('{"name":"x","address":"y","new_block_name":"Another"}') $$,
  'HOST_REQUIRED%', 'a site needs a host');

-- ---------------------------------------------------------- 2. its defaults
select lives_ok($$ select save_site_setup(pg_temp.fx('new'), 0,
  '[{"code":"standard","capacity":3,"online":2},{"code":"priority","capacity":2,"online":1}]', false) $$,
  'its usual spaces are set');

-- ----------------------------------------------- 3. the nights it sells
select is(set_site_nights(pg_temp.fx('new'),
            array[pg_temp.fx('night1'), pg_temp.fx('night2'), pg_temp.fx('night3')], '{}'),
          '{"added": 3, "removed": 0}'::jsonb,
  'ticked onto three nights');
select is(pg_temp.offer_status('night3', pg_temp.fx('new')), 'pending',
  'it joins each one pending, not on sale');
select is((pg_temp.tier('night3', pg_temp.fx('new'), 'standard')).capacity, 3,
  'at its usual spaces');
select is((pg_temp.tier('night3', pg_temp.fx('new'), 'standard')).gate_reserve, 1,
  'with its usual share held for the gate');
select is((pg_temp.tier('night3', pg_temp.fx('new'), 'standard')).price_cents, 3000,
  'priced as the reference site, its new area having no adjustment');
select is(set_site_nights(pg_temp.fx('new'), array[pg_temp.fx('night3')], '{}'),
          '{"added": 0, "removed": 0}'::jsonb,
  'ticking a night it already sells changes nothing');

-- ----------------------------------------------- 4. confirmed for sale
update event_offer set status = 'confirmed'
 where property_id = pg_temp.fx('new') and event_id in (pg_temp.fx('night1'), pg_temp.fx('night2'), pg_temp.fx('night3'));
select is((select count(*)::int from v_tier_availability
            where property_id = pg_temp.fx('new') and code = 'standard' and spots_left = 2
              and event_id in (pg_temp.fx('night1'), pg_temp.fx('night2'))), 2,
  'confirmed, the website can sell its online share');

-- ------------------------------------------------- 5. one night's numbers
select is(set_site_night(pg_temp.fx('night1'), pg_temp.fx('new'),
            '[{"code":"standard","capacity":5,"online":3}]'),
          '{"tiers_updated": 1}'::jsonb, 'one night''s spaces are set');
select is((pg_temp.tier('night1', pg_temp.fx('new'), 'standard')).capacity, 5, 'that night has five');
select is((pg_temp.tier('night1', pg_temp.fx('new'), 'standard')).gate_reserve, 2, 'two of them for the gate');
select is((pg_temp.tier('night2', pg_temp.fx('new'), 'standard')).capacity, 3, 'and no other night moved');
select is((select capacity from property_tier_default
            where property_id = pg_temp.fx('new') and code = 'standard'), 3, 'nor the usual number');

insert into fx
select 'held', hold_booking(pg_temp.fx('night1'), pg_temp.fx('new'), 'standard',
  'b3.test@example.com', null, null, 'B3TEST1', 30, 'online', false, 'stripe', false);
insert into fx
select 'held2', hold_booking(pg_temp.fx('night1'), pg_temp.fx('new'), 'standard',
  'b3.test@example.com', null, null, 'B3TEST2', 30, 'online', false, 'stripe', false);

select throws_like($$ select set_site_night(pg_temp.fx('night1'), pg_temp.fx('new'),
                        '[{"code":"standard","capacity":1,"online":1}]') $$,
  'BELOW_SOLD%', 'a night is never set below what has sold');
select is((pg_temp.tier('night1', pg_temp.fx('new'), 'standard')).capacity, 5, 'and is left as it was');
select lives_ok($$ select set_site_night(pg_temp.fx('night1'), pg_temp.fx('new'),
                     '[{"code":"standard","capacity":2,"online":0}]') $$,
  'down to exactly what has sold is allowed');
select throws_like($$ select set_site_night(pg_temp.fx('night1'), pg_temp.fx('new'),
                        '[{"code":"standard","capacity":4,"online":5}]') $$,
  'BAD_COUNT%', 'online is never more than the spaces');
select throws_like($$ select set_site_night(pg_temp.fx('night1'), pg_temp.fx('new'),
                        '[{"code":"nonesuch","capacity":1,"online":1}]') $$,
  'NO_SUCH_TIER%', 'a type the night does not sell there is refused');
select throws_like($$ select set_site_night(pg_temp.fx('night2'), pg_temp.fx('berm'),
                        '[{"code":"standard","capacity":1,"online":1}]') $$,
  'NOT_IN_NIGHT%', 'so is a site that is not part of the night');

-- ----------------------------------- 6. a booked site stays where it is
select throws_like($$ select set_site_nights(pg_temp.fx('new'), '{}', array[pg_temp.fx('night1')]) $$,
  'SITE_HAS_BOOKINGS%', 'a night with bookings at the site cannot be unticked');
select is(set_site_nights(pg_temp.fx('new'), '{}', array[pg_temp.fx('night2')]),
          '{"added": 0, "removed": 1}'::jsonb, 'one without can');
select is(pg_temp.offer_status('night2', pg_temp.fx('new')), null, 'and the site is off that night');
select throws_like($$ select save_site_details(pg_temp.fx('new'), '{"active": false}') $$,
  'SITE_HAS_BOOKINGS%', 'a site with bookings ahead cannot be switched off');
select throws_like($$ select save_site_details(pg_temp.fx('new'),
                        jsonb_build_object('block_id', (select block_id from property where id = pg_temp.fx('paice')))) $$,
  'SITE_HAS_BOOKINGS%', 'nor moved to another area');

-- ------------------------------------------------- 7. the reference site
select throws_like($$ select save_site_details(pg_temp.fx('paice'), '{"active": false}') $$,
  'REFERENCE_SITE%', 'the reference site cannot be switched off');
select throws_like($$ select set_site_nights(pg_temp.fx('paice'), '{}', array[pg_temp.fx('night3')]) $$,
  'REFERENCE_SITE%', 'nor taken off a night its prices are measured from');

-- ---------------------------------------------------------- 8. anchors
select throws_like($$ select save_site_details(pg_temp.fx('anchor'), '{"active": false}') $$,
  'SITE_IS_ANCHOR%', 'an anchor does not leave while its area has other sites');
select throws_like($$ select set_block_anchor((select block_id from property where id = pg_temp.fx('anchor')),
                                              pg_temp.fx('paice')) $$,
  'ANCHOR_NOT_IN_AREA%', 'an anchor is one of its own area''s sites');
select lives_ok($$ select set_block_anchor((select block_id from property where id = pg_temp.fx('anchor')),
                                           pg_temp.fx('neigh')) $$,
  'another site in the area can be made its anchor');
select lives_ok($$ select save_site_details(pg_temp.fx('anchor'), '{"active": false}') $$,
  'after which the old anchor can be switched off');
select is(pg_temp.offer_status('night1', pg_temp.fx('anchor')), null,
  'and it comes off the nights still to come');

-- ---------------------------------------------------------- 9. details
select lives_ok($$ select save_site_details(pg_temp.fx('berm'), jsonb_build_object(
  'name', 'TEST 84 berm renamed', 'fill_notes', 'Nose in, tight to the fence',
  'site_guide_url', 'https://example.com/guide.jpg', 'walk_minutes', 7)) $$,
  'details are edited in one call');
select is((select name || '|' || fill_notes || '|' || walk_minutes from property where id = pg_temp.fx('berm')),
  'TEST 84 berm renamed|Nose in, tight to the fence|7', 'and kept');
select throws_like($$ select save_site_details(pg_temp.fx('berm'), '{"site_guide_url":"javascript:alert(1)"}') $$,
  'BAD_LINK%', 'a site guide is an https link');
select throws_like($$ select save_site_details(pg_temp.fx('berm'), '{"lat": -36.8}') $$,
  'BAD_POSITION%', 'a position is both numbers');

-- ----------------------------- 10. a new night includes every active site
insert into fx
select 'made', create_gate_event('TEST — B3 new night', to_char(now() + interval '40 days', 'YYYY-MM-DD') || 'T19:30',
  'Eden Park', 'draft', 'standard', null, -150, 150, null,
  '[{"code":"standard","price_cents":3000,"capacity":4,"gate_reserve":1},
    {"code":"priority","price_cents":4000,"capacity":3,"gate_reserve":1}]');
select is((select count(*)::int from event_offer where event_id = pg_temp.fx('made')),
          (select count(*)::int from property where active),
  'every active site is in the new night');
select is((select o.status from event_offer o
            where o.event_id = pg_temp.fx('made') and o.property_id = reference_property()),
  'confirmed', 'made at the reference site, which sells at once');

select * from finish();
rollback;
