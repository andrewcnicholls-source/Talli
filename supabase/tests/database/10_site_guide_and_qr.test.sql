-- =====================================================================
--  The site guide and the Locate Us card (plan A4,
--  20261119100000_talli_site_guide_and_qr).
--
--  A card carries /go/<slug>, so every site and block has one, they never
--  collide across the two tables, and a site's starts as its street number
--  and street ("86 Paice Ave" → 86paice). Pictures of where to park are
--  public for active sites, written by the service role only, and the
--  function that changes an address is the service role's alone.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

-- ---------------------------------------------------------- slugs made
select is((select slug from property where id = '22222222-2222-2222-2222-222222222222'),
          '86paice', '86 Paice Avenue is 86paice');
select is((select count(*)::int from property where slug is null), 0, 'every site has a slug');
select is((select count(*)::int from block where slug is null), 0, 'every block has a slug');

select is(private.site_slug_base('70A Gribblehurst Rd, Sandringham', 'x'), '70agribblehurst',
          'a lettered number keeps its letter');
select is(private.site_slug_base('2/86 Paice Ave, Sandringham', 'x'), '86paice',
          'a unit number is dropped');
select is(private.site_slug_base('Gribblehurst Road (test site)', 'x'), 'gribblehurst-road',
          'no number: the street, slugified, brackets dropped');
select is(private.site_slug_base('', 'TEST Name'), 'test-name', 'no address: the name');

-- A new site, the way add_site makes one: the trigger fills its slug.
insert into property (id, host_id, name, address, active)
select v.id, (select host_id from property where id = '22222222-2222-2222-2222-222222222222'),
       v.name, '12 Example Road, Sandringham', true
  from (values ('a4a4a4a4-0000-4000-8000-000000000001'::uuid, 'TEST A4 one'),
               ('a4a4a4a4-0000-4000-8000-000000000002'::uuid, 'TEST A4 two')) as v(id, name)
 order by v.name;
select is((select slug from property where id = 'a4a4a4a4-0000-4000-8000-000000000001'),
          '12example', 'a new site gets its slug on insert');
select is((select slug from property where id = 'a4a4a4a4-0000-4000-8000-000000000002'),
          '12example-2', 'a second at the same number gets -2');

insert into block (id, name) values ('a4a4a4a4-0000-4000-8000-0000000000b1', 'TEST A4 Area (test)');
select is((select slug from block where id = 'a4a4a4a4-0000-4000-8000-0000000000b1'),
          'test-a4-area', 'a new block gets its slug from its name');

-- --------------------------------------------- one namespace, checked
select throws_ok($$ update block set slug = '86paice' where id = 'a4a4a4a4-0000-4000-8000-0000000000b1' $$,
                 '23505', null, 'a block cannot take a site''s slug');
select throws_ok($$ update property set slug = 'test-a4-area' where id = 'a4a4a4a4-0000-4000-8000-000000000001' $$,
                 '23505', null, 'a site cannot take a block''s slug');
select throws_ok($$ select set_place_slug('site', 'a4a4a4a4-0000-4000-8000-000000000001', 'two words') $$,
                 '23514', null, 'a slug with a space is refused');
select throws_ok($$ select set_place_slug('site', 'a4a4a4a4-0000-4000-8000-000000000001', '-edge-') $$,
                 '23514', null, 'a slug with an edge hyphen is refused');
select is(set_place_slug('site', 'a4a4a4a4-0000-4000-8000-000000000001', ' TEST-a4-Here '),
          'test-a4-here', 'set_place_slug trims and lower-cases');
select throws_ok($$ select set_place_slug('site', 'a4a4a4a4-0000-4000-8000-0000000000ff', 'nobody') $$,
                 'P0002', null, 'a site that does not exist is refused');

-- ------------------------------------------------- who may do what
select ok(not has_function_privilege('anon', 'public.set_place_slug(text, uuid, text)', 'execute'),
          'anon cannot change an address');
select ok(not has_function_privilege('authenticated', 'public.set_place_slug(text, uuid, text)', 'execute'),
          'a signed-in browser cannot change an address');

insert into site_picture (property_id, path, caption)
values ('a4a4a4a4-0000-4000-8000-000000000001',
        'site/a4a4a4a4-0000-4000-8000-000000000001/a4a4a4a4-0000-4000-8000-0000000000c1.png', 'TEST'),
       ('a4a4a4a4-0000-4000-8000-000000000002',
        'site/a4a4a4a4-0000-4000-8000-000000000002/a4a4a4a4-0000-4000-8000-0000000000c2.png', 'TEST off');
update property set active = false where id = 'a4a4a4a4-0000-4000-8000-000000000002';

set local role anon;
select is((select count(*)::int from site_picture where caption = 'TEST'), 1,
          'anon reads the pictures of an active site');
select is((select count(*)::int from site_picture where caption = 'TEST off'), 0,
          'and not of a switched-off one');
select throws_ok($$ insert into site_picture (property_id, path)
                    values ('a4a4a4a4-0000-4000-8000-000000000001',
                            'site/a4a4a4a4-0000-4000-8000-000000000001/a4a4a4a4-0000-4000-8000-0000000000c3.png') $$,
                 '42501', null, 'anon cannot add a picture');
reset role;

select throws_ok($$ insert into site_picture (property_id, path)
                    values ('a4a4a4a4-0000-4000-8000-000000000001', 'https://example.com/x.png') $$,
                 '23514', null, 'a picture is a path in the bucket, never a web address');

select * from finish();
rollback;
