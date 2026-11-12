-- =====================================================================
--  What the public anon key can and cannot reach.
--
--  The anon key is in every page of the site. Anything it can read, the
--  internet can read; anything it can change, the internet can change.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

-- A booking with a real-looking customer on it, so "reads nothing" means
-- something.
select hold_booking('7e57e000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222223',
                    'standard', 'private@example.com', 'Private Person', '021 000 000', 'PRIV1');

-- What a role sees in a table: a count, or -1 when it may not look at all.
create function pg_temp.sees(p_table text) returns int language plpgsql as $$
declare n int;
begin
  execute format('select count(*) from public.%I', p_table) into n;
  return n;
exception when insufficient_privilege then
  return -1;
end $$;
grant execute on function pg_temp.sees(text) to anon;

-- Run a write as whoever is current. Being refused outright and being
-- allowed to change zero rows are both fine; the checks below look at
-- what actually changed.
create function pg_temp.try(p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
exception when insufficient_privilege then
  null;
end $$;
grant execute on function pg_temp.try(text) to anon;

set local role anon;
select ok(pg_temp.sees('booking') <= 0,              'anon reads no bookings');
select ok(pg_temp.sees('booking_addon') <= 0,        'anon reads no booking extras');
select ok(pg_temp.sees('host') <= 0,                 'anon reads no hosts');
select ok(pg_temp.sees('host_user') <= 0,            'anon reads no gate-screen users');
select ok(pg_temp.sees('staff_block_access') <= 0,   'anon reads no warden grants');
select ok(pg_temp.sees('bank_transfer_setting') <= 0,'anon reads no bank details');
select ok(pg_temp.sees('event_interest') <= 0,       'anon reads no interest registrations');
select ok(pg_temp.sees('processed_webhook_event') <= 0, 'anon reads no Stripe events');

-- Every write the anon key might try changes nothing.
select pg_temp.try('update public.payment_setting set card_surcharge_bps = 0');
select pg_temp.try('update public.offer_tier set price_cents = 100');
select pg_temp.try('update public.block set name = ''taken over''');
select pg_temp.try('update public.event set status = ''cancelled''');
select pg_temp.try('delete from public.addon');
reset role;

select is((select count(*)::int from payment_setting where card_surcharge_bps = 0), 0,
  'anon cannot change the card surcharge');
select is((select count(*)::int from offer_tier where price_cents = 100), 0, 'anon cannot change a price');
select is((select count(*)::int from block where name = 'taken over'), 0, 'anon cannot rename a block');
select is((select count(*)::int from event where status = 'cancelled' and id::text like '7e57e%'), 0,
  'anon cannot cancel a night');
select ok((select count(*) from addon) > 0, 'anon cannot delete the extras for sale');

set local role anon;
select throws_ok($$ select set_tier_price('7e57e000-0000-4000-8000-000000000001',
                    '22222222-2222-2222-2222-222222222222', 'standard', 100) $$,
  '42501', null, 'a pricing function run with the anon key is refused by the table grants');
reset role;

-- The gate's identity check is reachable only by the service role.
select ok(not has_function_privilege('anon', 'public.host_access_for(uuid, text)', 'execute'),
  'anon cannot call host_access_for');
select ok(not has_function_privilege('authenticated', 'public.host_access_for(uuid, text)', 'execute'),
  'a signed-in browser cannot call host_access_for either');

-- CREATE OR REPLACE VIEW drops security_invoker silently; a view without
-- it runs as its owner and walks straight past row-level security.
select is(
  (select array_agg(c.relname::text order by c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce('security_invoker=true' = any(c.reloptions), false)),
  null,
  'every public view keeps security_invoker');

select * from finish();
rollback;
