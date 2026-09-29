-- =====================================================================
--  Talli Parking — the ten recovered bays start closed
--
--  20260918100000 made ten bays sellable that no tier could reach:
--  Lawn back row 1-3 and the seven double-park positions behind the back
--  yard. It also made them sellable *by default*, so a new night opened
--  offering sixteen Standard spaces instead of seven.
--
--  That is not the ask. Andrew's words, twice: the bays should be there
--  so he can open or close them — "this is how I control them" — and a
--  new event should start at the numbers it started at before any of
--  this:
--
--      Standard  7      the plain back yard bays
--      Priority  3      the lawn's street row (10 at the gate, with
--                       the verge, which was always gate-only)
--      Valet     6      the valet lane
--
--  The mechanism already exists and is exactly this: bay.is_flex, from
--  20260821091000. A flex bay does not exist for a night until somebody
--  opens it with the "+" on the zone card, and stops existing again when
--  they press "−". It is how the four back-yard squeezes and the two
--  lawn squeezes have always worked.
--
--  So the ten join them. Nothing about the previous migration is undone:
--  Standard still reaches the lawn and the stack, no_clear_exit still
--  keeps Priority's three street-row bays, and the deadline still makes
--  a stacked position sellable. They are simply off until asked for.
--
--  One number moves that is not a tier count. v_night_capacity.capacity
--  drops by ten on every event, because it counts bays that exist
--  tonight and these no longer do until opened. It was previously
--  counting ten bays that nothing on the property could sell, so the
--  board gets more honest rather than less.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Dormant until asked for.
--
--  Only the bays 20260918100000 brought into play. The seven plain back
--  yard bays, the three street-row bays and the valet lane are untouched
--  and stay on by default, which is what makes the starting numbers the
--  original ones.
-- ---------------------------------------------------------------------
update bay b set is_flex = true
  from zone z
 where z.id = b.zone_id
   and b.active and z.active
   and (
     -- the seven double-park positions
     (z.code = 'back_yard' and b.requires_early_departure)
     -- the three boxed-in lawn bays
     or (z.code = 'front_lawn'
         and exists (select 1 from bay bb
                      where bb.blocks_bay_id = b.id and bb.active))
   );

-- ---------------------------------------------------------------------
--  2. The "+" opens the kindest space left, and the "−" shuts the
--     unkindest first.
--
--  With ten more flex bays in play the button's choice starts to matter.
--  A position that boxes a stranger in is the last one to open and the
--  first one to give back; label order decides the rest, as before.
-- ---------------------------------------------------------------------
create or replace function adjust_zone_capacity(
  p_event_id uuid,
  p_zone_id  uuid,
  p_delta    integer,
  p_note     text default null
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_step integer;
  v_bay  uuid;
begin
  if p_delta = 0 then
    raise exception 'NO_CHANGE: delta must not be zero' using errcode = 'check_violation';
  end if;

  for v_step in 1 .. abs(p_delta) loop
    if p_delta < 0 then
      -- Losing one. Prefer undoing a spare we opened earlier — that leaves
      -- the yard closer to the plan than scratching a real bay — and among
      -- those, shut a position that boxes somebody in before any other.
      select i.bay_id into v_bay
        from v_bay_inventory i
       where i.event_id = p_event_id and i.zone_id = p_zone_id
         and i.available and i.is_flex and i.night_state = 'open'
       order by case when i.requires_early_departure then 0 else 1 end,
                i.bay_label desc
       limit 1;

      if v_bay is not null then
        delete from event_bay_status
         where event_id = p_event_id and bay_id = v_bay;
      else
        -- Otherwise take a free real bay, cheapest first: one with nothing
        -- parked in behind it, and a double-park position before a bay that
        -- somebody else's position depends on.
        select i.bay_id into v_bay
          from v_bay_inventory i
         where i.event_id = p_event_id and i.zone_id = p_zone_id
           and i.available and not i.is_flex
           and (i.blocker_bay_id is null
                or not exists (select 1 from bay_allocation a2
                                where a2.event_id = p_event_id
                                  and a2.bay_id = i.blocker_bay_id))
         order by
           case when i.blocker_bay_id is null then 0 else 1 end,
           case when i.blocks_someone then 0 else 1 end,
           i.bay_label desc
         limit 1;

        if v_bay is null then
          raise exception
            'NOTHING_FREE: every space in that zone is taken — move a car before writing one off'
            using errcode = 'check_violation';
        end if;

        insert into event_bay_status (event_id, bay_id, state, note)
        values (p_event_id, v_bay, 'lost', p_note)
        on conflict (event_id, bay_id)
          do update set state = 'lost', note = excluded.note;
      end if;

    else
      -- Gaining one. Give a written-off bay back before opening a spare.
      select s.bay_id into v_bay
        from event_bay_status s
        join bay b on b.id = s.bay_id
       where s.event_id = p_event_id and b.zone_id = p_zone_id
         and s.state = 'lost' and not b.is_flex
       order by b.label asc
       limit 1;

      if v_bay is not null then
        delete from event_bay_status
         where event_id = p_event_id and bay_id = v_bay;
      else
        select b.id into v_bay
          from bay b
         where b.zone_id = p_zone_id and b.active and b.is_flex
           and not exists (select 1 from event_bay_status s2
                            where s2.event_id = p_event_id and s2.bay_id = b.id)
         order by case when b.requires_early_departure then 1 else 0 end,
                  b.label asc
         limit 1;

        if v_bay is null then
          raise exception 'NO_SPARE: no spare space left to open in that zone'
            using errcode = 'check_violation';
        end if;

        insert into event_bay_status (event_id, bay_id, state, note)
        values (p_event_id, v_bay, 'open', p_note);
      end if;
    end if;
  end loop;

  return (select count(*)::integer
            from v_bay_inventory i
           where i.event_id = p_event_id and i.zone_id = p_zone_id);
end;
$function$;
