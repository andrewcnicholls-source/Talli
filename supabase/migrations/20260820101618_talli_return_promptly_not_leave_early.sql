-- The obligation on these spots was modelled backwards. Nobody leaves an event
-- early. What actually happens is that the car at the front of a stack blocks
-- the one behind it, so its driver has to come back promptly at the end and
-- move — otherwise the person behind is stuck.
--
-- The timestamps said so even more plainly than the words did: departure_by was
-- ten minutes AFTER kick-off on every fixture, which read as "leave during the
-- first half". It now means "be back at your car by", set shortly after the
-- event is expected to finish.
--
-- The column names (departure_by, must_depart_by, requires_early_departure)
-- still carry the old reading and are now misleading. Renaming them touches
-- hold_booking, sell_at_gate and two views, so it is left as a deliberate
-- follow-up rather than folded into a copy fix on a live site.
update offer_tier t
set departure_by = e.expected_end_at + interval '20 minutes',
    label = case t.code
              when 'quick_getaway'
                then 'Quick getaway — first car out, but you are blocking someone '
                  || 'in, so please come straight back after the final whistle'
              else t.label end
from event_offer eo, event e
where eo.id = t.event_offer_id
  and e.id = eo.event_id
  and t.departure_by is not null
  and e.expected_end_at is not null;
