-- =====================================================================
--  What Priority exit promises (20261125100000_talli_priority_wording).
--
--  Done when: no Priority type or template still says "near the road" or
--  "nobody parked in behind you" — a Priority car can have someone behind
--  it and is not always by the road; it is never blocked in.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(3);

select is((select count(*)::int from offer_tier
            where code = 'priority' and (label ilike '%near the road%' or label ilike '%nobody parked%')),
  0, 'no night''s Priority type promises the road or an empty space behind');
select is((select count(*)::int from event_template, jsonb_array_elements(tiers) x
            where x->>'code' = 'priority'
              and (x->>'label' ilike '%near the road%' or x->>'label' ilike '%nobody parked%')),
  0, 'nor does any template a new night is made from');
select ok((select count(*) > 0 from event_template, jsonb_array_elements(tiers) x
            where x->>'code' = 'priority' and x->>'label' ilike '%won''t be blocked in%'),
  'the templates say what it does promise: not blocked in');

select * from finish();
rollback;
