-- =====================================================================
--  Rate us (20261129100000_talli_reviews).
--
--  Done when: a review from the homepage is stored with the site the
--  customer picked; a review from a booking is stored against where the
--  car actually was and its night, once per booking; nothing outside the
--  service role reads the table or calls the functions; and the summary
--  the operator sees adds up.
--
--  Uses the fixture night in seed-test-nights.sql. Rolled back.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

create temp table fx (k text primary key, id uuid);
insert into fx values
  ('night',  '7e57e000-0000-4000-8000-000000000001'),
  ('paice',  '22222222-2222-2222-2222-222222222222'),
  ('anchor', '22222222-2222-2222-2222-2222222222a1'),
  ('neigh',  '22222222-2222-2222-2222-2222222222a2');

create function pg_temp.fx(p_k text) returns uuid
language sql as $$ select id from fx where k = p_k $$;

-- Start from no reviews, so the summary counts are this test's own.
delete from review;

-- ------------------------------------------------------------ who may
select ok(not has_table_privilege('anon', 'public.review', 'select'),
  'the public cannot read reviews');
select ok(not has_table_privilege('anon', 'public.review', 'insert'),
  'nor write one straight into the table');
select ok(not has_table_privilege('authenticated', 'public.review', 'select'),
  'nor can a signed-in browser');
select ok(not has_function_privilege('anon',
  'public.submit_review(int, text, text, text, uuid, boolean, boolean, text)', 'execute'),
  'submit_review is the edge function''s, not the browser''s');
select ok(not has_function_privilege('anon', 'public.review_summary(int)', 'execute'),
  'the summary has names and contact details: service role only');

-- ------------------------------------------------------- the options
select ok((select review_options() @> jsonb_build_array(
            jsonb_build_object('id', pg_temp.fx('paice')))),
  'an active site is offered');
select ok((select bool_and(x - 'id' - 'label' = '{}'::jsonb)
             from jsonb_array_elements(review_options()) x),
  'each offered as its id and name, nothing more');

-- ------------------------------------------------ from the homepage
select is((submit_review(5, '  Great night  ', 'Sam', null, pg_temp.fx('paice'),
           true, false)->>'from_booking')::boolean, false,
  'a homepage review is taken');
select is((select row(rating, comment, name, property_id, easy_to_find, easy_to_leave, source)::text
             from review where name = 'Sam'),
  row(5, 'Great night', 'Sam', pg_temp.fx('paice'), true, false, 'homepage')::text,
  'stored as sent, trimmed, against the site picked');

select lives_ok($$ select submit_review(3) $$, 'stars alone are enough');
select is((select count(*)::int from review where comment is null and name is null),
  1, 'and blanks are stored as nothing, not as empty text');

select throws_like($$ select submit_review(0) $$, '%BAD_RATING%', 'no zero stars');
select throws_like($$ select submit_review(6) $$, '%BAD_RATING%', 'no six stars');
select throws_like($$ select submit_review(4, repeat('x', 2001)) $$, '%TOO_LONG%',
  'a comment has a limit');
select throws_like($$ select submit_review(4, null, null, null, gen_random_uuid()) $$,
  '%NO_SITE%', 'a site that is not ours is refused');

-- ---------------------------------------------------- from a booking
-- Booked at the anchor, then sent next door before it arrived: the review
-- belongs to the neighbour, where the car was.
insert into fx values ('car', hold_booking(pg_temp.fx('night'), pg_temp.fx('anchor'),
  'standard', 'review.test@example.com', p_rego => 'RVW001'));
select confirm_booking(pg_temp.fx('car'), null);
update booking set stripe_checkout_session_id = 'cs_test_review_1'
 where id = pg_temp.fx('car');
select transfer_booking(pg_temp.fx('car'), pg_temp.fx('neigh'), null, null);

select is((submit_review(2, 'Hard to get out', null, null, pg_temp.fx('paice'),
           null, false, 'cs_test_review_1')->>'from_booking')::boolean, true,
  'a review from a booking link is taken');
select is((select row(property_id, event_id, source)::text
             from review where booking_id = pg_temp.fx('car')),
  row(pg_temp.fx('neigh'), pg_temp.fx('night'), 'booking')::text,
  'against where the car actually was and its night, not the site in the request');

select is((submit_review(4, 'Actually fine', null, null, null, null, null,
           'cs_test_review_1')->>'updated')::boolean, true,
  'sending it again updates the first');
select is((select count(*)::int from review where booking_id = pg_temp.fx('car')),
  1, 'one review per booking');

select throws_like($$ select submit_review(4, null, null, null, null, null, null, 'cs_nope') $$,
  '%NO_BOOKING%', 'a session that is not a booking is refused');

-- --------------------------------------------------------- summary
select is((review_summary()->'overall'->>'count')::int, 3,
  'the summary counts every review');
select is((select (s->>'average')::numeric from jsonb_array_elements(review_summary()->'sites') s
            where s->>'property_id' = pg_temp.fx('neigh')::text),
  4.0, 'and gives each site its own average');

select * from finish();
rollback;
