-- =====================================================================
--  A night always has something to sell
--  (20261126100000_talli_a_night_always_has_something_to_sell).
--
--  A site added to a night with nothing to copy used to come in pending
--  with no tiers, so the night sold nothing and had no price to set. It
--  now takes the template for the night's demand tier and the site's own
--  default spaces; and a night cannot go on sale with nothing to sell.
--  Rolled back afterwards.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('paice', '22222222-2222-2222-2222-222222222222'),
  ('grib',  '22222222-2222-2222-2222-2222222222a1'),
  ('empty', 'b10e5000-0000-4000-8000-000000000001'),
  ('other', 'b10e5000-0000-4000-8000-000000000002');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

create function pg_temp.offer(p_event text, p_site text) returns uuid
language sql as $$
  select id from event_offer where event_id = pg_temp.fx(p_event) and property_id = pg_temp.fx(p_site)
$$;

-- Paice's own spaces, whatever the seed left.
insert into property_tier_default (property_id, code, capacity, online)
values (pg_temp.fx('paice'), 'standard', 10, 6),
       (pg_temp.fx('paice'), 'priority', 16, 3),
       (pg_temp.fx('paice'), 'valet',     6, 3)
on conflict (property_id, code) do update set capacity = excluded.capacity, online = excluded.online;

-- Two nights with no site at all, as the Blues 2027 nights were made.
insert into event (id, name, venue, starts_at, gates_open_at, expected_end_at,
                   online_sales_close_at, demand_tier, status)
select pg_temp.fx(k), 'TEST — empty night ' || k, 'Eden Park',
       now() + interval '60 days', now() + interval '60 days' - interval '150 minutes',
       now() + interval '60 days' + interval '150 minutes',
       now() + interval '60 days' - interval '45 minutes', 'standard', 'draft'
  from (values ('empty'), ('other')) v(k);

-- ------------------------------------- the reference site, first on a night
select add_event_offer(pg_temp.fx('empty'), pg_temp.fx('paice'));

select is((select status from event_offer where id = pg_temp.offer('empty', 'paice')), 'confirmed',
  'the reference site, first on a night, is on sale');
select is((select count(*) from offer_tier where event_offer_id = pg_temp.offer('empty', 'paice')),
  (select jsonb_array_length(t.tiers)::bigint from event_template t
    where t.active order by (t.demand_tier = 'standard') desc, t.sort_order, t.name limit 1),
  'it takes every type in the template for the night''s demand tier');
select is((select capacity from offer_tier
            where event_offer_id = pg_temp.offer('empty', 'paice') and code = 'standard'), 10,
  'with the site''s own default spaces');
select is((select gate_reserve from offer_tier
            where event_offer_id = pg_temp.offer('empty', 'paice') and code = 'standard'), 4,
  'and keeps back for the gate what is not sold online');
select ok((select bool_and(price_cents > 0) from offer_tier
            where event_offer_id = pg_temp.offer('empty', 'paice')),
  'every type has a price, so the Event tab has a price to set');
select is((select count(*) from v_block_tier_availability where event_id = pg_temp.fx('empty')) > 0,
  true, 'and the booking page has something to show');

-- --------------------------------------------- a second site copies it
select add_event_offer(pg_temp.fx('empty'), pg_temp.fx('grib'));
select is((select status from event_offer where id = pg_temp.offer('empty', 'grib')), 'pending',
  'any other site still waits for a tap on the Sites page');
select is((select count(*) from offer_tier where event_offer_id = pg_temp.offer('empty', 'grib')),
  (select count(*) from offer_tier where event_offer_id = pg_temp.offer('empty', 'paice')),
  'and copies the types of the site already there');

-- -------------------------------------- a non-reference site first
select add_event_offer(pg_temp.fx('other'), pg_temp.fx('grib'));
select is((select status from event_offer where id = pg_temp.offer('other', 'grib')), 'pending',
  'a host''s site first on a night is not put on sale for them');
select ok((select count(*) from offer_tier where event_offer_id = pg_temp.offer('other', 'grib')) > 0,
  'but it is not left empty either');

-- ------------------------------------------- nothing to sell, no sale
select throws_like(
  $$ select set_event_status('b10e5000-0000-4000-8000-000000000002', 'on_sale') $$,
  'NOTHING_TO_SELL%', 'a night with no site on sale cannot be put on sale');
select lives_ok(
  $$ select set_event_status('b10e5000-0000-4000-8000-000000000001', 'on_sale') $$,
  'a night with a site on sale with spaces can');
select lives_ok(
  $$ select set_event_status('b10e5000-0000-4000-8000-000000000002', 'announced') $$,
  'and any night can be taken off sale or announced, whatever it has');

-- ----------------------------------------------- never overwrites
select is(private.seed_offer_tiers(pg_temp.offer('empty', 'paice')), 0,
  'filling a site that already has prices changes nothing');

select * from finish();
rollback;
