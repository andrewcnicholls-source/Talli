-- =====================================================================
--  Talli Parking — move the walk-up reserve by a delta, not to a number
--
--  20260917100000 gave the gate screen a − / + for the reserve, and had
--  it send the number it wanted: "set Standard to 1". That is only right
--  while the screen's copy of the reserve is right, and on the night it
--  may not be. The page refreshes every thirty seconds, two phones can
--  be open on the same event, and a screen served before a deploy — or
--  reading a payload that never carried gate_reserve at all — shows 0
--  for a tier that is really holding 2. Tap + on that screen and the
--  reserve is *lowered* to 1, silently, by a control the operator was
--  using to raise it.
--
--  So the tap sends what it means: one more, one fewer. The database
--  adds that to whatever the row actually holds, and the number on the
--  screen goes back to being a display rather than an instruction.
--
--  adjust_zone_capacity has worked this way since 20260821091000, for
--  the same reason and on the same screen. This is the reserve catching
--  up with it.
--
--  set_tier_reserve stays: setting an exact number is still the right
--  call when someone types one, and nothing here changes its meaning.
-- =====================================================================

create or replace function adjust_tier_reserve(
  p_event_id    uuid,
  p_property_id uuid,
  p_tier_code   text,
  p_delta       integer
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id  uuid;
  v_now integer;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'NO_CHANGE: delta must not be zero'
      using errcode = 'check_violation';
  end if;
  -- A phone in a pocket, or a tap counted twice. Ten either way is more
  -- than anyone means in one go, and the same bound adjust_zone_capacity
  -- puts on the button beside it.
  if abs(p_delta) > 10 then
    raise exception 'BAD_DELTA: move the reserve by ten or fewer at a time'
      using errcode = 'check_violation';
  end if;

  select t.id, t.gate_reserve into v_id, v_now
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  -- Clamped rather than refused. "Release one more" with nothing held is
  -- already true, and saying so with an error on a wet phone helps nobody.
  v_now := greatest(0, least(200, v_now + p_delta));

  update offer_tier set gate_reserve = v_now where id = v_id;

  return v_now;
end;
$function$;
