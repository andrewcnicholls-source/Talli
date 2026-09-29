-- =====================================================================
--  Talli Parking — the templates carry the yard, not just the prices
--
--  20260918100000 moved Standard onto the lawn and the stack, and gave
--  normalise_event_tiers per-code defaults to match. Defaults only fire
--  when nobody said otherwise, and every saved template says otherwise:
--  all seven of them store Standard as
--
--      "bay_kind": "any", "zone_codes": ["back_yard"]
--
--  written out in full by save_event_template, which normalises before
--  it stores. So a night created from a template — which is how nights
--  are created — would have taken the old mapping back: the ten
--  recovered bays unsellable again, and bay_kind 'any' letting Standard
--  take the three street-row bays Priority is sold on.
--
--  The templates are where the yard's shape is really written down for
--  a new event, so this writes it there. Prices, windows and everything
--  else each template was tuned with are left exactly as they are: only
--  Standard's three structural keys move, and only on templates that
--  still carry the old values.
--
--  20260902110000 rewrote template tiers in place the same way, for the
--  same reason.
-- =====================================================================

update event_template t set
  tiers = (
    select jsonb_agg(
             case
               when lower(item ->> 'code') = 'standard'
                 then item || jsonb_build_object(
                        'zone_codes', '["back_yard","front_lawn"]'::jsonb,
                        'bay_kind', 'no_clear_exit',
                        -- Relative to kickoff, like every other minutes
                        -- field a template holds: half an hour after this
                        -- template's own expected end.
                        'departure_by_minutes',
                          coalesce(t.expected_end_minutes, 150) + 30)
               else item
             end
             order by ord
           )
      from jsonb_array_elements(t.tiers) with ordinality as e(item, ord)
  )
where jsonb_typeof(t.tiers) = 'array'
  and exists (
    select 1 from jsonb_array_elements(t.tiers) as item
     where lower(item ->> 'code') = 'standard'
       and (item -> 'zone_codes' = '["back_yard"]'::jsonb
            or item ->> 'bay_kind' = 'any'
            or item ->> 'departure_by_minutes' is null)
  );
