-- =====================================================================
--  Talli Parking — what Priority exit promises
--
--  Andrew, 14 Nov 2026: a Priority car may well have someone parked
--  behind it, but it is never blocked in. And it is not always near the
--  road. The old wording said both ("near the road, nobody parked in
--  behind you"), so it promised something the night will not always keep.
--
--  The label is data, copied from the event templates into each night's
--  types, and from a night's types to a site that joins it. So this
--  rewrites the label wherever it still has the old words: every
--  offer_tier, and every Priority entry in every event_template. A label
--  someone has already changed by hand is left alone.
--
--  Data only; no function is restated. Safe to run twice.
-- =====================================================================

update offer_tier
   set label = 'Priority exit — you won''t be blocked in, so you can leave when you''re ready'
 where code = 'priority'
   and label in ('Priority exit — near the road, nobody parked in behind you',
                 'Priority exit — parked near the road, out in a couple of minutes');

update event_template t
   set tiers = (
     select jsonb_agg(
              case when x->>'code' = 'priority'
                    and x->>'label' in ('Priority exit — near the road, nobody parked in behind you',
                                        'Priority exit — parked near the road, out in a couple of minutes')
                   then jsonb_set(x, '{label}',
                          to_jsonb('Priority exit — you won''t be blocked in, so you can leave when you''re ready'::text))
                   else x end
              order by ord)
       from jsonb_array_elements(t.tiers) with ordinality as e(x, ord))
 where exists (
   select 1 from jsonb_array_elements(t.tiers) x
    where x->>'code' = 'priority'
      and x->>'label' in ('Priority exit — near the road, nobody parked in behind you',
                          'Priority exit — parked near the road, out in a couple of minutes'));
