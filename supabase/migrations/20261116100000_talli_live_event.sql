-- =====================================================================
--  Talli Parking — one event is live at a time (plan B2)
--
--  Plan § 3.7: Andrew marks one event live, and Arrivals shows that one.
--  A warden has no event selector and cannot name another night: gate-ops
--  resolves the live event on the server for every Arrivals action.
--
--    1. event.is_live, at most one true, held by a partial unique index
--       rather than by anyone remembering to clear the last one.
--    2. set_live_event(id) makes one live and clears the rest in the
--       same transaction. set_live_event(null) clears it.
--
--  Additive: one column, one index, one function. Nothing is made live
--  here; on production the first live night is a tap on Tonight after
--  release, and until then Arrivals says no event is live.
-- =====================================================================

alter table event add column if not exists is_live boolean not null default false;

comment on column event.is_live is
  'The night the gate is working. At most one row is true (event_one_live). '
  'Arrivals, for everyone, and every action a warden takes, use this event. '
  'Set with set_live_event().';

-- At most one. The expression is a constant, so every live row has the
-- same key and a second one is a unique violation.
create unique index if not exists event_one_live on event ((true)) where is_live;

create or replace function set_live_event(p_event_id uuid)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare v_status text;
begin
  -- Two taps on two phones at once would each clear and then each set,
  -- and the second set would hit the index. Take turns instead.
  perform pg_advisory_xact_lock(hashtext('talli.set_live_event'));

  if p_event_id is not null then
    select status into v_status from event where id = p_event_id;
    if v_status is null then
      raise exception 'NO_EVENT: no such event'
        using errcode = 'check_violation';
    end if;
    -- A draft has not been decided on and a cancelled night is off: there
    -- is nobody to wave in at either. Closed stays allowed, because online
    -- sales close while the gate is still busy.
    if v_status in ('draft', 'cancelled') then
      raise exception 'NOT_LIVE_STATUS: a % event cannot be live at the gate', v_status
        using errcode = 'check_violation';
    end if;
  end if;

  -- Clear first, then set: the index is checked row by row, so doing both
  -- in one statement could trip it on the way through.
  update event set is_live = false
   where is_live and id is distinct from p_event_id;
  if p_event_id is not null then
    update event set is_live = true where id = p_event_id and not is_live;
  end if;
  return p_event_id;
end;
$function$;

comment on function set_live_event(uuid) is
  'Makes one event live at the gate and clears any other, or clears it with null. '
  'Refuses a draft or cancelled event (NOT_LIVE_STATUS). Called by gate-ops for the operator.';

revoke all on function set_live_event(uuid) from public, anon, authenticated;
grant execute on function set_live_event(uuid) to service_role;

-- ---------------------------------------------------------------------
--  Cancelling, or going back to draft, takes a night off the gate too.
--  Restated from 20260831120000 with its signature and checks unchanged;
--  the one addition is the last update.
-- ---------------------------------------------------------------------
create or replace function set_event_status(
  p_event_id uuid,
  p_status   text
) returns text
language plpgsql
set search_path to 'public'
as $function$
declare v_before text;
begin
  if coalesce(p_status, '') not in
     ('draft','announced','on_sale','closed','cancelled') then
    raise exception 'BAD_STATUS: % is not an event status', p_status
      using errcode = 'check_violation';
  end if;

  select status into v_before from event where id = p_event_id;
  if v_before is null then
    raise exception 'NO_EVENT: no such event'
      using errcode = 'check_violation';
  end if;

  update event set status = p_status,
                   is_live = is_live and p_status not in ('draft', 'cancelled')
   where id = p_event_id;
  return p_status;
end;
$function$;
