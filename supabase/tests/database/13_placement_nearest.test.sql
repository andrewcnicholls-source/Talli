-- =====================================================================
--  Placement goes to the nearest house with the space a car paid for
--  (20261123100000_talli_placement_nearest).
--
--  Done when: with three houses in a block, a car whose space here is
--  gone is proposed the nearest house that has its type — not the
--  anchor because it is the anchor — and a Priority car is proposed a
--  Priority space along the street, never a Standard or Valet one.
--
--  Uses the fixture night in seed-test-nights.sql and adds, inside this
--  transaction, a third Gribblehurst (test) house about 8m past the
--  neighbour, so the anchor (about 20m the other way) is further away.
--  Spaces are filled with lost spaces, not cars, so nothing is sold.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2'),
  ('third',  '22222222-2222-2222-2222-2222222222a3');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

-- Where propose_space sends a car of p_code standing at p_site: "site:space".
create function pg_temp.proposal(p_site text, p_code text) returns text
language sql as $$
  select (select k from fx where id = p.property_id) || ':' || p.space_code
    from propose_space(pg_temp.fx('night'), pg_temp.fx(p_site), p_code, null, false) p
$$;

-- Lose every free space of one type at one site.
create function pg_temp.fill(p_site text, p_code text) returns integer
language plpgsql as $$
declare i int := 0;
begin
  while private.space_free(pg_temp.fx('night'), pg_temp.fx(p_site), p_code, null, false) > 0 loop
    perform record_lost_space(pg_temp.fx('night'), pg_temp.fx(p_site), p_code, 'other', 'test fill', null);
    i := i + 1;
    if i > 20 then raise exception 'never filled % %', p_site, p_code; end if;
  end loop;
  return i;
end $$;

-- ------------------------------------------------------- the third house
insert into property (id, host_id, name, address, walk_minutes, active, block_id, lat, lng)
values ('22222222-2222-2222-2222-2222222222a3', '11111111-1111-1111-1111-1111111111a2',
        'TEST Gribblehurst third', 'Gribblehurst Road, Sandringham, Auckland (test site 3)', 9, true,
        (select block_id from property where id = '22222222-2222-2222-2222-2222222222a1'),
        -36.880820, 174.742560);
insert into event_offer (event_id, property_id, status)
values (pg_temp.fx('night'), pg_temp.fx('third'), 'confirmed');
insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                        guarantees_clear_exit, sort_order, active, capacity, gate_reserve,
                        arrival_from, arrival_until, departure_by)
select o.id, v.code, v.code, 4000, '{}'::text[], v.kind, v.code <> 'standard', v.sort, true, 1, 0,
       e.starts_at - interval '3 hours', e.starts_at, e.starts_at + interval '4 hours'
  from event_offer o join event e on e.id = o.event_id
  cross join (values ('standard', 'no_clear_exit', 1), ('priority', 'free_exit', 2)) v(code, kind, sort)
 where o.event_id = pg_temp.fx('night') and o.property_id = pg_temp.fx('third');

select cmp_ok(private.metres_between(-36.880780, 174.742480, -36.880820, 174.742560), '<',
              private.metres_between(-36.880780, 174.742480, -36.880692, 174.742279),
  'the third house is nearer the neighbour than the anchor is');
select is(private.metres_between(null, 174.7, -36.8, 174.7), null,
  'a house with no position has no distance');

-- ------------------------------------------------------------- Standard
select is(pg_temp.proposal('neigh', 'standard'), 'neigh:standard',
  'a Standard car keeps a Standard space here while there is one');

select cmp_ok(pg_temp.fill('neigh', 'standard'), '>=', 0, 'Standard at the neighbour is gone');
select is(pg_temp.proposal('neigh', 'standard'), 'third:standard',
  'then the nearest house with Standard, not the anchor because it is the anchor');

select cmp_ok(pg_temp.fill('third', 'standard'), '>=', 0, 'and Standard at the third house is gone');
select is(pg_temp.proposal('neigh', 'standard'), 'anchor:standard',
  'then the next nearest Standard, before any Priority');

-- ------------------------------------------------------------- Priority
select cmp_ok(pg_temp.fill('neigh', 'priority'), '>=', 0, 'Priority at the neighbour is gone');
select is(pg_temp.proposal('neigh', 'priority'), 'third:priority',
  'a Priority car goes to the nearest Priority space along the street');

select cmp_ok(pg_temp.fill('third', 'priority') + pg_temp.fill('anchor', 'priority'), '>=', 0,
  'with Priority gone everywhere in the block');
select is(pg_temp.proposal('neigh', 'priority'), null,
  'a Priority car is proposed nothing: never a Standard or Valet space');

select * from finish();
rollback;
