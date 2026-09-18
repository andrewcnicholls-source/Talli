-- =====================================================================
--  Talli Parking — the space is chosen when the car turns up
--
--  Andrew: "when I check them in, this is where they will naturally get
--  parked (if possible)".
--
--  Until now a bay was chosen when the booking was MADE. For a walk-up
--  that is the same moment, so the running order governed it. For an
--  online booking it is days early, and that breaks the order in a way
--  that matters physically rather than cosmetically:
--
--      Three people book Standard on Tuesday and are given Back yard 1,
--      Double-park behind 1, and Back yard 2. On Saturday the second one
--      arrives first. Their bay is the stack position in front of Back
--      yard 1 — a bay that is still empty and still needed. You either
--      wave them into it and block a space you have sold, or you put
--      them somewhere else and the screen is now wrong.
--
--  Nobody books a bay. They book a kind of space. Which bay is a
--  decision for the moment the car is in the driveway, and that is
--  exactly when check-in happens.
--
--  So check_in_booking now places the car: the best free bay its tier
--  can reach, in the running order 20260918130000 set down. The bay it
--  was holding goes back for whoever arrives next, which is what makes
--  the yard fill densely and in order as cars actually turn up.
--
--  A bay held by somebody who has not arrived is in the running too. It
--  has to be, or the change does nothing: in the example above Back yard
--  1 is not free, it is spoken for by a car still at home, and the first
--  arrival would be sent past it to a stack position. Nobody works a
--  yard that way. A booking's bay is a claim on a KIND of space until
--  its car is in the driveway; then it is a bay.
--
--  That claim is only ever taken by a booking that could have had it
--  anyway. A bay held by somebody else is a candidate only when the two
--  bookings are interchangeable — same tier, and the same answer on
--  street parking. Anything either one can use, so can the other, so a
--  swap can never strand the one that gets moved: it goes back to
--  unplaced and is placed when its own car turns up, from a set that
--  still has a space in it for every booking yet to arrive.
--
--  Without that restriction the swap can stand somebody up. Priority
--  sells three lawn bays online and the rest of its spaces are verge,
--  which an online customer has never agreed to. Let a walk-up take a
--  lawn bay off an online booking and that booking has nowhere left it
--  is allowed to go.
--
--  Three things this deliberately does not do.
--
--  It never moves anyone to a worse space. The bay they already hold is
--  in the running with the rest, so if it is still the best it wins and
--  nothing happens.
--
--  It never puts a car somewhere its owner did not agree to. The verges
--  carry requires_consent, and an online booking has not had that
--  conversation — so the overflow stays what it is, a decision made at
--  the window with the car in front of you.
--
--  And it places once, on the first tick-in. Undo and re-tick does not
--  move a car that is by then physically parked.
-- =====================================================================

create or replace function check_in_booking(p_booking_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  v_b        booking%rowtype;
  v_tier     offer_tier%rowtype;
  v_first    boolean;
  v_current  uuid;
  v_best     uuid;
  v_displace uuid;
begin
  select * into v_b from booking where id = p_booking_id;
  if not found then return; end if;

  -- Was this the arrival, or a re-tick of a car already in the yard?
  -- Only the arrival chooses a space.
  v_first := v_b.checked_in_at is null;

  update booking set checked_in_at = coalesce(checked_in_at, now())
   where id = p_booking_id and status in ('paid', 'held');

  if not v_first or v_b.status not in ('paid', 'held') then return; end if;

  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = v_b.event_id and o.property_id = v_b.property_id
     and t.code = v_b.tier_code and t.active;
  if not found then return; end if;

  select a.bay_id into v_current
    from bay_allocation a
   where a.booking_id = p_booking_id and a.role = 'occupied';

  -- The best space this car can be put in right now, and whose claim (if
  -- anyone's) it settles.
  --
  -- In the running: bays that are free, this car's own bay, and bays held
  -- by an interchangeable booking whose car has not arrived. Its own bay
  -- being a candidate is what stops the move ever being a downgrade — if
  -- it is already the best, it wins here.
  --
  -- Same predicate and same running order as hold_booking, with two
  -- differences that follow from the car being physically present:
  -- reservable_in_advance does not apply, because nothing is being sold,
  -- and this booking's own blocked_reserve rows do not count against it.
  --
  -- There is deliberately no "all else equal, prefer a bay nobody has
  -- claimed" tiebreak. It reads as politeness and behaves as a bug: a
  -- car's own bay is by definition unclaimed by anyone else, so that key
  -- ranks it above every claimed bay and the running order below it
  -- never gets a say. Nothing would ever move. The order decides, and a
  -- claim by somebody still at home does not outrank it.
  select i.bay_id, held.booking_id into v_best, v_displace
    from v_bay_inventory i
    left join lateral (
      select b2.id as booking_id
        from bay_allocation a2
        join booking b2 on b2.id = a2.booking_id
       where a2.event_id = v_b.event_id
         and a2.bay_id = i.bay_id
         and a2.role = 'occupied'
         and b2.id <> p_booking_id
         and b2.checked_in_at is null
         and b2.status in ('paid', 'held')
         and b2.tier_code = v_b.tier_code
         and b2.accepts_street_parking is not distinct from v_b.accepts_street_parking
       limit 1
    ) held on true
   where i.event_id = v_b.event_id and i.property_id = v_b.property_id
     and (i.available or i.bay_id = v_current or held.booking_id is not null)
     and (v_tier.zone_codes is null or i.zone_code = any (v_tier.zone_codes))
     and (not i.requires_consent or v_b.accepts_street_parking)
     and (v_tier.departure_by is not null or not i.requires_early_departure)
     and case v_tier.bay_kind
           when 'free_exit'      then i.blocker_bay_id is null
           when 'may_be_blocked' then i.blocker_bay_id is not null
           when 'no_clear_exit'  then (i.blocker_bay_id is not null
                                       or i.requires_early_departure
                                       or i.is_flex)
           else true
         end
     and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
          or not exists (select 1 from bay_allocation a3
                          where a3.event_id = v_b.event_id
                            and a3.bay_id = i.blocker_bay_id
                            and a3.booking_id <> p_booking_id))
   order by
     coalesce(array_position(v_tier.zone_codes, i.zone_code), 99),
     case
       when not i.is_flex then 0
       when i.requires_early_departure or i.blocker_bay_id is not null then 1
       else 2
     end,
     case when v_tier.guarantees_clear_exit and i.blocker_bay_id is null then 0 else 1 end,
     i.exit_rank, i.bay_label
   limit 1;

  if v_best is null or v_best is not distinct from v_current then return; end if;

  -- Settle the other claim first: that booking goes back to unplaced and
  -- is given a space when its own car arrives.
  if v_displace is not null then
    delete from bay_allocation where booking_id = v_displace;
  end if;

  perform reassign_booking(p_booking_id, v_best);
end;
$function$;
