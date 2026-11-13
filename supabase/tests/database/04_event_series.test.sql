-- =====================================================================
--  Event series (plan A1, 20261113100000_talli_event_series).
--
--  Every night is in a series; a new night lands in one by its name; the
--  public sees active series only and can write none; Andrew's writes go
--  through save_event_series with named errors.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

-- ---------------------------------------------------------- every night
select is((select count(*)::int from event where series_id is null), 0,
  'every event is in a series');
select col_not_null('event', 'series_id', 'and has to be');

-- ------------------------------------------------- grouping by the name
select is((event_series_parts('Auckland v Bay of Plenty')).series_name, 'Auckland',
  'for sport the series is the team');
select is((event_series_parts('Auckland v Counties Manukau (NPC)')).night_label,
  'v Counties Manukau (NPC)', 'and the night is who they play');
select is((event_series_parts('Warriors vs Knights Semi-Final')).kind, 'sport',
  '"vs" is sport too');
select is((event_series_parts('Bruno Mars (The Romantic Tour, second show)')).series_name,
  'Bruno Mars', 'a tour night belongs to the act');
select is((event_series_parts('Bruno Mars (The Romantic Tour, second show)')).night_label,
  'Second show', 'and is named by the last part in brackets');
select is((event_series_parts('TEST - Bruno Mars - Night 3')).series_name, 'TEST — Bruno Mars',
  'dashes are read alike, and a TEST prefix stays with the series');
select is((event_series_parts('TEST - Bruno Mars - Night 3')).night_label, 'Night 3',
  '"— Night 3" names the night');
select is((event_series_parts('State of Origin Game 2 (NSW Blues v QLD Maroons)')).series_name,
  'State of Origin Game 2', 'a "v" inside brackets does not make the brackets a team');

-- -------------------------------------------- a new night finds its series
insert into event (id, name, starts_at, status) values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'TEST — Zeta Band (World Tour)', now() + interval '40 days', 'draft'),
  ('a1a1a1a1-0000-4000-8000-000000000002', 'TEST — Zeta Band (World Tour, second show)', now() + interval '41 days', 'draft');
select is((select count(distinct series_id)::int from event
            where id in ('a1a1a1a1-0000-4000-8000-000000000001',
                         'a1a1a1a1-0000-4000-8000-000000000002')), 1,
  'two nights of one act land in one series');
select is((select slug from event_series s join event e on e.series_id = s.id
            where e.id = 'a1a1a1a1-0000-4000-8000-000000000001'), 'test-zeta-band',
  'and the series gets an address from its name');
select is((select night_label from event where id = 'a1a1a1a1-0000-4000-8000-000000000002'),
  'Second show', 'with the night named');

insert into event_series (id, slug, name) values
  ('a1a1a1a1-0000-4000-8000-0000000000aa', 'test-chosen', 'TEST — Chosen');
insert into event (id, name, starts_at, status, series_id) values
  ('a1a1a1a1-0000-4000-8000-000000000003', 'TEST — Zeta Band (third show)', now() + interval '42 days',
   'draft', 'a1a1a1a1-0000-4000-8000-0000000000aa');
select is((select series_id from event where id = 'a1a1a1a1-0000-4000-8000-000000000003'),
  'a1a1a1a1-0000-4000-8000-0000000000aa'::uuid, 'a night that names its series keeps it');

-- ------------------------------------------------- saving a series
select is((save_event_series(null, 'TEST — Brand New', 'concert', null, 'A line', 3, true)).slug,
  'test-brand-new', 'a new series takes its address from its name');
select is((save_event_series((select id from event_series where slug = 'test-brand-new'),
            'TEST — Renamed', 'other', 'Eden Park', null, 3, true)).slug,
  'test-brand-new', 'and keeps it through a rename');
select throws_like($$ select save_event_series(null, 'TEST — Renamed', 'concert', null, null, 0, true) $$,
  'SERIES_NAME_TAKEN%', 'two series cannot share a name');
select throws_like($$ select save_event_series(null, 'TEST — Other', 'concert', null, null, 0, true, 'test-chosen') $$,
  'SLUG_TAKEN%', 'nor an address');
select throws_like($$ select save_event_series(null, 'TEST — Bad', 'concert', null, null, 0, true, 'Not A Slug!') $$,
  'BAD_SLUG%', 'an address is lower-case letters, numbers and dashes');

-- ------------------------------------------------- what the public sees
update event_series set active = false where slug = 'test-chosen';
set local role anon;
select is((select count(*)::int from event_series where slug = 'test-chosen'), 0,
  'a series taken off the website is not readable with the anon key');
select throws_like($$ insert into event_series (slug, name) values ('x', 'x') $$,
  '%permission denied%', 'and nobody can write one with it');
select throws_like($$ select ensure_event_series('anything') $$,
  '%permission denied%', 'or make one through the helper');
reset role;

select * from finish();
rollback;
