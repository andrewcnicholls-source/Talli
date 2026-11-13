-- =====================================================================
--  Host settlement (plan B7, 20261121100000_talli_host_settlement).
--
--  Done when: moving every car to one host's driveway, or raising the
--  price halfway through sales, changes no host's figure; recording a
--  lost space lowers that host's and no other; and every night's shares
--  add up to its takings to the cent.
--
--  A night of its own, so no other suite's cars are on it: the two
--  Gribblehurst (test) sites from seed-test-block.sql, each confirmed for
--  3 Standard and 2 Priority. Their hosts are TEST Host A (anchor) and
--  TEST Host B (neighbour). Bookings are written straight into the table:
--  what is being proved is the arithmetic on whatever was sold.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(57);

create temp table fx (k text primary key, id uuid);
create temp table seen (k text primary key, v bigint);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-0000000000b7'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2'),
  ('hostA',  '11111111-1111-1111-1111-1111111111a1'),
  ('hostB',  '11111111-1111-1111-1111-1111111111a2');
insert into fx select 'block', id from block where name = 'Gribblehurst (test)';
insert into fx values ('w1', gen_random_uuid()), ('w2', gen_random_uuid());

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

-- The percentages as decided, whatever another run left them at.
do $$ begin perform save_settlement_setting('{"talli_parking_bps":3000,"warden_parking_bps":2000,
  "host_parking_bps":5000,"warden_extras_bps":1000}'::jsonb, null); end $$;

-- Two wardens, invented.
insert into host_user (id, host_id, email, role, scope, active)
values (pg_temp.fx('w1'), pg_temp.fx('hostA'), 'b7.warden.one@example.com', 'staff', 'blocks', true),
       (pg_temp.fx('w2'), pg_temp.fx('hostA'), 'b7.warden.two@example.com', 'staff', 'blocks', true);

-- The night.
insert into event (id, name, venue, starts_at, gates_open_at, expected_end_at,
                   online_sales_close_at, status)
select pg_temp.fx('night'), 'TEST — Settlement night', 'Eden Park', s, s - interval '90 minutes',
       s + interval '3 hours', s - interval '1 hour', 'on_sale'
  from (select date_trunc('day', now()) + interval '30 days 7 hours' as s) t;

insert into event_offer (event_id, property_id, status)
values (pg_temp.fx('night'), pg_temp.fx('anchor'), 'confirmed'),
       (pg_temp.fx('night'), pg_temp.fx('neigh'), 'confirmed');

insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                        guarantees_clear_exit, sort_order, active, capacity, gate_reserve,
                        arrival_from, arrival_until, departure_by)
select o.id, v.code, v.label, v.price, '{}'::text[], v.kind, v.code <> 'standard', v.sort, true,
       v.cap, v.reserve, e.starts_at - interval '3 hours', e.starts_at, e.starts_at + interval '4 hours'
  from event_offer o join event e on e.id = o.event_id
  cross join (values ('standard', 'Standard', 4000, 'no_clear_exit', 1, 3, 0),
                     ('priority', 'Priority exit', 5000, 'free_exit', 2, 2, 1))
       as v(code, label, price, kind, sort, cap, reserve)
 where o.event_id = pg_temp.fx('night');

-- A paid booking, booked at p_site.
create function pg_temp.book(p_site text, p_amount int, p_method text default 'stripe',
                             p_channel text default 'online', p_addons int default 0,
                             p_surcharge int default 0, p_cash_by uuid default null)
returns uuid
language sql as $$
  insert into booking (event_id, property_id, booked_property_id, tier_code, customer_email,
                       vehicle_rego, amount_cents, addons_cents, surcharge_cents, channel,
                       status, payment_method, paid_at, cash_collected_by)
  values (pg_temp.fx('night'), pg_temp.fx(p_site), pg_temp.fx(p_site), 'standard',
          'b7.test@example.com', 'B7' || upper(substr(md5(random()::text), 1, 5)),
          p_amount, p_addons, p_surcharge, p_channel, 'paid', p_method, now(), p_cash_by)
  returning id
$$;

create function pg_temp.fig() returns jsonb
language sql as $$
  select (select b -> 'figures' from jsonb_array_elements(
            settlement_report(pg_temp.fx('night')) -> 'blocks') b
           where b ->> 'block_id' = pg_temp.fx('block')::text)
$$;
create function pg_temp.owed(p_host text) returns bigint
language sql as $$
  select (h ->> 'amount_cents')::bigint
    from jsonb_array_elements(pg_temp.fig() -> 'hosts') h
   where h ->> 'host_id' = pg_temp.fx(p_host)::text
$$;
create function pg_temp.spaces(p_host text) returns bigint
language sql as $$
  select (h ->> 'spaces')::bigint
    from jsonb_array_elements(pg_temp.fig() -> 'hosts') h
   where h ->> 'host_id' = pg_temp.fx(p_host)::text
$$;
create function pg_temp.c(p_key text) returns bigint
language sql as $$ select (pg_temp.fig() ->> p_key)::bigint $$;
-- Talli + wardens + hosts, against the night's takings.
create function pg_temp.adds_up() returns boolean
language sql as $$
  select pg_temp.c('talli_cents') + pg_temp.c('wardens_cents') + pg_temp.c('hosts_cents')
           = pg_temp.c('net_cents')
     and pg_temp.c('hosts_cents') = (select sum((h ->> 'amount_cents')::bigint)
                                       from jsonb_array_elements(pg_temp.fig() -> 'hosts') h)
$$;

-- ------------------------------------------------------------ the shape
select has_table('settlement_setting', 'the percentages are a setting');
select has_table('night_site_spaces', 'spaces provided are snapshotted');
select has_table('warden_allocation', 'the wardens'' split has a table');
select has_table('night_settlement', 'settled nights have a table');
select has_column('booking', 'refunded_cents', 'a partial refund is recorded');
select has_column('host', 'payout_notes', 'a host has payout notes');
select ok(not has_table_privilege('anon', 'night_settlement', 'select'),
  'the public cannot read a settlement');
select ok(not has_table_privilege('authenticated', 'warden_allocation', 'select'),
  'nor a signed-in browser the wardens'' split');
select ok(not has_function_privilege('anon', 'public.settlement_report(uuid)', 'execute'),
  'nor run the report');
select ok(not has_function_privilege('authenticated',
  'public.settle_night(uuid, uuid, uuid)', 'execute'), 'nor settle a night');

-- ------------------------------------------------------------ the split
-- Three online at the anchor, $40 with a $1.20 surcharge each; a cash
-- walk-up at the neighbour, $40 with a $10 poncho.
do $$ begin perform pg_temp.book('anchor', 4000, 'stripe', 'online', 0, 120) from generate_series(1, 3); end $$;
insert into fx values ('cash', pg_temp.book('neigh', 4000, 'cash', 'gate', 1000, 0, pg_temp.fx('w1')));

select is(pg_temp.c('parking_cents'), 16000::bigint, 'parking is the spaces sold');
select is(pg_temp.c('extras_cents'), 1000::bigint, 'extras are their own pool');
-- The surcharge is the database's (card_surcharge_bps), whatever was written.
insert into seen values ('sur', (select sum(surcharge_cents) from booking
                                  where event_id = pg_temp.fx('night')));
select cmp_ok((select v from seen where k = 'sur'), '>', 0::bigint, 'the card sales carry a surcharge');
select is(pg_temp.c('surcharge_cents'), (select v from seen where k = 'sur'), 'and surcharges are outside both');
select is((pg_temp.fig() -> 'parking_pool' ->> 'wardens_cents')::bigint, 3200::bigint, '20% of parking to wardens');
select is((pg_temp.fig() -> 'parking_pool' ->> 'hosts_cents')::bigint, 8000::bigint, '50% to hosts');
select is((pg_temp.fig() -> 'parking_pool' ->> 'talli_cents')::bigint, 4800::bigint, '30% to Talli');
select is((pg_temp.fig() -> 'extras_pool' ->> 'wardens_cents')::bigint, 100::bigint, '10% of extras to wardens');
select is(pg_temp.c('wardens_cents'), 3300::bigint, 'the wardens'' amount is both together');
select is(pg_temp.c('talli_cents'), 4800 + 900 + (select v from seen where k = 'sur'),
  'Talli has 30%, 90% of extras and every surcharge');
select is(pg_temp.spaces('hostA'), 5::bigint, 'each host provided five spaces');
select is(pg_temp.owed('hostA'), 4000::bigint, 'and is owed half the hosts'' pool,');
select is(pg_temp.owed('hostB'), 4000::bigint, 'though every online car was at the anchor');
select ok(pg_temp.adds_up(), 'the shares add up to the takings');
select is((select (c ->> 'cents')::bigint from jsonb_array_elements(pg_temp.fig() -> 'cash') c
            where c ->> 'host_user_id' = pg_temp.fx('w1')::text), 5000::bigint,
  'the cash each warden holds');

insert into seen values ('A', pg_temp.owed('hostA')), ('B', pg_temp.owed('hostB'));

-- ------------------------------------- moving every car to one driveway
update booking set property_id = pg_temp.fx('neigh') where event_id = pg_temp.fx('night');
select is(pg_temp.owed('hostA'), (select v from seen where k = 'A'),
  'every car parked at the neighbour: the anchor''s host is owed the same');
select is(pg_temp.owed('hostB'), (select v from seen where k = 'B'), 'and so is the neighbour''s');
update booking set booked_property_id = pg_temp.fx('neigh') where event_id = pg_temp.fx('night');
select is(pg_temp.owed('hostA'), (select v from seen where k = 'A'),
  'and booked there too: still the same');
update booking set property_id = pg_temp.fx('anchor'), booked_property_id = pg_temp.fx('anchor')
 where event_id = pg_temp.fx('night');
select is(pg_temp.owed('hostB'), (select v from seen where k = 'B'),
  'every car at the anchor: the neighbour''s host is owed the same');

-- --------------------------------------- raising the price halfway through
-- Two more sales at $60 after a price rise, sold at the anchor; then the
-- same two sold at the neighbour instead. Who paid the higher price, and
-- where they parked, changes no host's figure.
create temp table late (id uuid);
insert into late select pg_temp.book('anchor', 6000) from generate_series(1, 2);
insert into seen values ('A2', pg_temp.owed('hostA')), ('B2', pg_temp.owed('hostB'));
update booking set property_id = pg_temp.fx('neigh'), booked_property_id = pg_temp.fx('neigh')
 where id in (select id from late);
select is(pg_temp.owed('hostA'), (select v from seen where k = 'A2'),
  'the dearer cars at the other driveway: the anchor''s host is owed the same');
select is(pg_temp.owed('hostB'), (select v from seen where k = 'B2'), 'and the neighbour''s');
select is(pg_temp.owed('hostA'), pg_temp.owed('hostB'),
  'equal spaces, equal shares, whatever each car paid');

-- --------------------------------------------------------- a lost space
insert into seen values ('pool', (pg_temp.fig() -> 'parking_pool' ->> 'hosts_cents')::bigint);
insert into fx values ('lost', record_lost_space(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'priority', 'host_car', null, null));
select is(pg_temp.spaces('hostA'), 4::bigint, 'a lost space comes off its host''s spaces');
select is(pg_temp.spaces('hostB'), 5::bigint, 'and no one else''s');
select cmp_ok(pg_temp.owed('hostA'), '<', (select v from seen where k = 'A2'),
  'it lowers that host''s figure');
select cmp_ok(pg_temp.owed('hostB'), '>=', (select v from seen where k = 'B2'),
  'and lowers no other host''s');
select is((pg_temp.fig() -> 'parking_pool' ->> 'hosts_cents')::bigint, (select v from seen where k = 'pool'),
  'the hosts'' pool is the same size');
select ok(pg_temp.adds_up(), 'shared 4:5 it still adds up to the cent');

-- ---------------------------------------------------- to the cent, always
create function pg_temp.always_adds_up() returns integer
language plpgsql as $$
declare i int; bad int := 0;
begin
  for i in 1 .. 40 loop
    update booking set amount_cents = 100 + floor(random() * 9900)::int,
                       addons_cents = floor(random() * 3) * (100 + floor(random() * 900)::int),
                       surcharge_cents = floor(random() * 300)::int
     where id = (select id from late limit 1);
    if not pg_temp.adds_up() then bad := bad + 1; end if;
  end loop;
  return bad;
end $$;
select is(pg_temp.always_adds_up(), 0, 'forty odd-cent nights, every one adds up to the cent');

-- ------------------------------------------------------------- refunds
insert into seen values ('net', pg_temp.c('net_cents')), ('park', pg_temp.c('parking_cents')),
                        ('ext', pg_temp.c('extras_cents'));
select is(record_refund(pg_temp.fx('cash'), 4500), 4500, 'a partial refund is recorded');
select is(pg_temp.c('parking_cents'), (select v from seen where k = 'park') - 4000,
  'it comes out of parking first');
select is(pg_temp.c('extras_cents'), (select v from seen where k = 'ext') - 500,
  'then extras');
select is(pg_temp.c('net_cents'), (select v from seen where k = 'net') - 4500,
  'and off the night''s takings');
do $$ begin perform record_refund(pg_temp.fx('cash'), 0); end $$;
update booking set status = 'refunded' where id = (select id from late limit 1);
select is(pg_temp.c('refund_cents') > 0, true, 'a full refund shows as refunded');
select ok(pg_temp.adds_up(), 'and the shares still add up');

-- ---------------------------------------------------------- allocating
select throws_like(format($$ select save_warden_allocation(%L, %L, '[{"host_user_id":"%s","amount_cents":1}]'::jsonb, null) $$,
                          pg_temp.fx('night'), pg_temp.fx('block'), pg_temp.fx('w1')),
  '%ALLOCATION_NOT_EQUAL%', 'an allocation that does not add up is refused');

insert into seen values ('w', pg_temp.c('wardens_cents'));
select lives_ok(format($$ select save_warden_allocation(%L, %L,
    jsonb_build_array(jsonb_build_object('host_user_id', %L, 'amount_cents', %s),
                      jsonb_build_object('host_user_id', %L, 'amount_cents', %s)), %L) $$,
    pg_temp.fx('night'), pg_temp.fx('block'),
    pg_temp.fx('w1'), (select v / 2 from seen where k = 'w'),
    pg_temp.fx('w2'), (select v - v / 2 from seen where k = 'w'), pg_temp.fx('w1')),
  'one that does is saved');
select is((select set_by from warden_allocation where event_id = pg_temp.fx('night') limit 1),
  pg_temp.fx('w1'), 'with who set it');

-- ------------------------------------------------------------ settling
select throws_like(format($$ select settle_night(%L, %L, null) $$, pg_temp.fx('night'), pg_temp.fx('block')),
  '%NIGHT_NOT_CLOSED%', 'a night still on sale cannot be settled');

update event set status = 'closed' where id = pg_temp.fx('night');
select is((select sum(provided)::int from night_site_spaces where event_id = pg_temp.fx('night')), 9,
  'closing the night snapshots the spaces provided');

-- A site's numbers changed after the night closed rewrite nothing.
update offer_tier set capacity = capacity + 10
 where event_offer_id in (select id from event_offer where event_id = pg_temp.fx('night'));
select is(pg_temp.spaces('hostA'), 4::bigint, 'the snapshot, not the site as it is now');

select lives_ok(format($$ select settle_night(%L, %L, %L) $$,
                       pg_temp.fx('night'), pg_temp.fx('block'), pg_temp.fx('w1')),
  'a closed night with its wardens allocated is settled');
select is((select talli_parking_bps from night_settlement where event_id = pg_temp.fx('night')), 3000,
  'with the percentages in force stored');

insert into seen values ('A3', pg_temp.owed('hostA'));
do $$ begin perform save_settlement_setting('{"talli_parking_bps":2500,"host_parking_bps":5500}'::jsonb, null); end $$;
select is(pg_temp.owed('hostA'), (select v from seen where k = 'A3'),
  'changing the percentages later does not touch a settled night');
select throws_like($$ select save_settlement_setting('{"talli_parking_bps":5000}'::jsonb, null) $$,
  '%SPLIT_NOT_100%', 'and the parking split must add up to 100%');

select throws_like(format($$ select save_warden_allocation(%L, %L, '[]'::jsonb, null) $$,
                          pg_temp.fx('night'), pg_temp.fx('block')),
  '%NIGHT_SETTLED%', 'the allocation cannot change once settled');
select is(reopen_settlement(pg_temp.fx('night'), pg_temp.fx('block'), null), true,
  'a settled night can be reopened');

select * from finish();
rollback;
