-- =====================================================================
--  Talli Parking — three options, everywhere
--
--  The gate screen and the booking page were offering six ways to park.
--  Six is a menu; three is a decision. The NPC games already ran on
--  three (20260819115035), it worked, and this makes it the rule for
--  every event rather than a per-fixture exception:
--
--    Standard        back yard — best value, expect to wait
--    Priority exit   near the road, nobody parked in behind you
--    Valet           hand over the keys, we park it
--
--  'near_road', 'guaranteed_clear' and 'quick_getaway' come off sale.
--
--  DEACTIVATED, NOT DELETED. booking.tier_code is text, and both
--  get-booking and create-checkout resolve a booking's label by looking
--  the code up in offer_tier. Deleting the rows would leave every
--  historical Quick getaway booking without a name for the spot it
--  bought. active = false is what v_tier_availability filters on, so
--  the tiers vanish from the admin screen and the booking page while
--  the history stays readable.
--
--  Nothing here re-prices or re-allocates a booking that already
--  exists. A tier coming off sale does not move a car.
-- =====================================================================

-- ---------------------------------------------------------------------
--  The three that stay, and the three that go.
--
--  Standard also widens from 'may_be_blocked' to 'any'. It has to: with
--  Quick getaway gone, 'may_be_blocked' would leave Standard able to
--  reach only the seven boxed-in back-yard bays, and every back-yard
--  spare opened with +1 on the night would be unsellable — the tap
--  would do nothing. 'any' lets Standard take an ordinary back-yard bay
--  or a spare. It still cannot take a double-park position: hold_booking
--  refuses a bay with requires_early_departure unless the tier carries a
--  departure deadline, and none of the three does.
-- ---------------------------------------------------------------------
update offer_tier t set
  active   = (t.code in ('standard', 'priority', 'valet')),
  bay_kind = case when t.code = 'standard' then 'any' else t.bay_kind end,
  -- Valet has never brought anyone's car back to them. The seeded label
  -- said it would; the NPC games already corrected it, and a promise
  -- that is wrong on one fixture is wrong on all of them.
  label    = case t.code
               when 'valet' then 'Valet — hand us your keys and we''ll park it for you'
               else t.label end;

-- ---------------------------------------------------------------------
--  What this costs, said out loud.
--
--  Two groups of bays now have no tier that can sell them:
--
--    * the three front-lawn back-row bays, which only 'near_road' could
--      reach (Priority promises a free exit and they are boxed in;
--      Standard's zone list is the back yard);
--    * the seven back-yard double-park positions, which only
--      'quick_getaway' could reach, because occupying one boxes in a
--      neighbour who never agreed to wait, so it may only be sold with a
--      departure deadline.
--
--  That is ten of forty-four sellable spaces at 86 Paice Ave, and it is
--  the price of a three-line menu: no double-parking, and no selling the
--  lawn's back row. Both are deliberate. If a big night needs them back,
--  the recovery is a tier row, not a schema change.
-- ---------------------------------------------------------------------
