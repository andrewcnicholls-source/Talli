-- =====================================================================
--  Talli Parking — send a car to another site before it arrives
--
--  place_booking() moves a car to another site in its block, or a
--  Standard car into a Priority space, and ticks it in as it does: it
--  was written for the car in front of the warden. A car can also be
--  sent elsewhere before it turns up — the anchor is full of the host's
--  guests — and that must not mark it arrived.
--
--    1. transfer_booking(): place_booking's checks and move, nothing
--       about check-in.
--    2. place_booking() restated as transfer_booking() then the tick-in,
--       so the two rules cannot drift apart. Same signature.
--
--  Additive: one new function, one restated with its signature kept.
-- =====================================================================

-- ------------------------------------------------ 1. transfer_booking

create or replace function transfer_booking(
  p_booking_id uuid, p_property_id uuid, p_space_code text default null,
  p_by uuid default null)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  b        booking%rowtype;
  v_space  text;
  v_was    text;
  v_block  uuid;
  v_target uuid;
begin
  select * into b from booking where id = p_booking_id for update;
  if not found or b.status not in ('paid', 'held') then
    raise exception 'NO_BOOKING: no such booking at the gate tonight'
      using errcode = 'check_violation';
  end if;

  v_space := coalesce(p_space_code, b.tier_code);
  v_was := coalesce(b.space_code, b.tier_code);
  if v_space <> b.tier_code and not (b.tier_code = 'standard' and v_space = 'priority') then
    raise exception 'WRONG_SPACE: a % booking cannot go in a % space', b.tier_code, v_space
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from event_offer o
                  where o.event_id = b.event_id and o.property_id = p_property_id) then
    raise exception 'SITE_NOT_IN_EVENT: that site is not part of this event'
      using errcode = 'check_violation';
  end if;

  -- Any site in the block it was booked into.
  select pr.block_id into v_block from property pr
   where pr.id = coalesce(b.booked_property_id, b.property_id);
  select pr.block_id into v_target from property pr where pr.id = p_property_id;
  if p_property_id <> b.property_id and p_property_id <> coalesce(b.booked_property_id, b.property_id)
     and (v_block is null or v_target is distinct from v_block) then
    raise exception 'NOT_IN_BLOCK: that site is not in the block this car was booked into'
      using errcode = 'check_violation';
  end if;

  if not (p_property_id = b.property_id and v_space = v_was) then
    -- Take the tier row's lock, as hold_booking does, so two phones
    -- placing the last space take turns.
    perform 1 from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = b.event_id and o.property_id = p_property_id
       and t.code = v_space and t.active
       for update of t;
    if private.space_free(b.event_id, p_property_id, v_space, b.id, false) <= 0 then
      raise exception 'NO_ROOM: no % space free at that site', v_space
        using errcode = 'check_violation';
    end if;
  end if;

  update booking set
    property_id = p_property_id,
    space_code  = nullif(v_space, b.tier_code)
  where id = b.id
  returning * into b;

  return jsonb_build_object(
    'booking_id', b.id,
    'property_id', b.property_id,
    'space_code', coalesce(b.space_code, b.tier_code),
    'tier_code', b.tier_code);
end;
$function$;

-- ---------------------------------------- 2. place_booking = move + tick in

create or replace function place_booking(
  p_booking_id uuid, p_property_id uuid, p_space_code text default null,
  p_by uuid default null)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  v_out := transfer_booking(p_booking_id, p_property_id, p_space_code, p_by);
  update booking set
    checked_in_at = coalesce(checked_in_at, now()),
    checked_in_by = coalesce(checked_in_by, p_by)
  where id = p_booking_id;
  return v_out;
end;
$function$;

-- --------------------------------------------------------- who may call

-- gate-ops, under the service role, and nobody else, as place_booking.
revoke all on function transfer_booking(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function transfer_booking(uuid, uuid, text, uuid) to service_role;
