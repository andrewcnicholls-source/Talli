-- =====================================================================
--  Talli Parking — pricing templates, and one tap to apply one
--
--  The three templates seeded with the modal (Club rugby night, Big
--  match, Test match or concert) named the FIXTURE. That turned out to
--  be the wrong axis. What actually moves the price on a Talli night is
--  not who is playing, it is what the council has done to the roads:
--
--    No Traffic Management    10 / 12 / 15   nothing on, drive straight in
--    No Road Closures         20 / 25 / 30   marshals about, roads open
--    Burnley Road Closure     30 / 40 / 45   one way in
--    Paice Ave Closure        40 / 50 / 55   the street itself is shut
--
--  (standard / priority / valet, in dollars.)
--
--  A club game with Paice Ave closed is worth more than a test match
--  with the roads open, and the old names could not say that. These can.
--
--  The old three are DEACTIVATED, not deleted. event_form only lists
--  active templates, so they leave the picker; the rows stay because a
--  template is cheap to keep and somebody may want the numbers back.
--
--  Second half of the file: apply_price_template, which sets every
--  matching tier on one event to a template's prices in a single round
--  trip, for the dropdown under Prices on the gate screen.
-- =====================================================================

-- ---------------------------------------------------------------------
--  The old shape-of-a-night templates leave the picker.
-- ---------------------------------------------------------------------
update event_template
   set active = false, updated_at = now()
 where lower(name) in ('club rugby night', 'big match', 'test match or concert');

-- ---------------------------------------------------------------------
--  The four that replace them.
--
--  Written through save_event_template rather than a raw insert, so the
--  tier JSON goes through normalise_event_tiers and a template made here
--  is exactly the shape a template saved from the phone would be. The
--  arrival windows come from 20260902100000 by leaving them unsaid:
--  valet and priority take a car up to kickoff, standard closes at T-30.
--
--  Saving under a name that already exists replaces it, so re-running
--  this file re-asserts the prices rather than making duplicates.
-- ---------------------------------------------------------------------
do $$
declare
  v_row record;
  v_id  uuid;
begin
  for v_row in
    select * from (values
      ('No Traffic Management', 'low',      1000, 1200, 1500, 10),
      ('No Road Closures',      'standard', 2000, 2500, 3000, 20),
      ('Burnley Road Closure',  'high',     3000, 4000, 4500, 30),
      ('Paice Ave Closure',     'premium',  4000, 5000, 5500, 40)
    ) as v(name, demand_tier, standard, priority, valet, sort_order)
  loop
    v_id := save_event_template(
      p_name                 => v_row.name,
      p_id                   => null,
      p_event_name           => null,
      p_venue                => 'Eden Park',
      p_status               => 'draft',
      p_demand_tier          => v_row.demand_tier,
      p_property_id          => null,
      p_gates_open_minutes   => -150,
      p_expected_end_minutes => 150,
      p_online_close_minutes => -45,
      p_tiers                => jsonb_build_array(
        jsonb_build_object(
          'code', 'standard',
          'label', 'Standard — best value, expect to wait for the drive to clear',
          'price_cents', v_row.standard,
          'zone_codes', '["back_yard"]'::jsonb,
          'bay_kind', 'any',
          'sort_order', 1),
        jsonb_build_object(
          'code', 'priority',
          'label', 'Priority exit — near the road, nobody parked in behind you',
          'price_cents', v_row.priority,
          'zone_codes', '["front_lawn","berm"]'::jsonb,
          'bay_kind', 'free_exit',
          'sort_order', 2),
        jsonb_build_object(
          'code', 'valet',
          'label', 'Valet — hand us your keys and we''ll park it for you',
          'price_cents', v_row.valet,
          'zone_codes', '["valet"]'::jsonb,
          'bay_kind', 'any',
          'sort_order', 3)
      )
    );

    -- save_event_template picks its own sort_order for a new row, which
    -- is "after everything else". These four have a running order — it is
    -- the price ladder — so say it.
    update event_template
       set sort_order = v_row.sort_order, active = true
     where id = v_id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  Apply a template's prices to a night.
--
--  Matched on tier code, and only on codes both sides have. A template
--  naming a tier the event does not sell is not an error — the event was
--  built with a different menu, and the template is a price list, not a
--  redefinition of what is for sale. The reverse is the same: a tier the
--  template says nothing about keeps the price it has.
--
--  What it is NOT allowed to be is a silent no-op. Nothing matching at
--  all means the wrong template, or the wrong night, and the phone has
--  to say so rather than flashing a tick.
--
--  Property is optional. Null means every property selling this event,
--  which is what "all spot types for that event" means on a screen that
--  does not mention properties at all.
-- ---------------------------------------------------------------------
create or replace function apply_price_template(
  p_event_id    uuid,
  p_template_id uuid,
  p_property_id uuid default null
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_tiers   jsonb;
  v_name    text;
  v_applied integer;
begin
  select t.tiers, t.name into v_tiers, v_name
    from event_template t
   where t.id = p_template_id;

  if v_tiers is null then
    raise exception 'NO_TEMPLATE: no such pricing template'
      using errcode = 'check_violation';
  end if;

  -- The same bounds set_tier_price enforces one price at a time. A
  -- template is more dangerous than a single tap, not less: it moves the
  -- whole sign at once.
  if exists (
    select 1 from jsonb_array_elements(v_tiers) as item
     where coalesce((item ->> 'price_cents')::integer, 0) not between 100 and 50000
  ) then
    raise exception 'BAD_PRICE: "%" holds a price outside $1 to $500', v_name
      using errcode = 'check_violation';
  end if;

  with wanted as (
    select lower(item ->> 'code')          as code,
           (item ->> 'price_cents')::integer as price_cents
      from jsonb_array_elements(v_tiers) as item
  ),
  hit as (
    update offer_tier ot
       set price_cents = w.price_cents,
           price_updated_at = now()
      from wanted w, event_offer eo
     where ot.event_offer_id = eo.id
       and eo.event_id = p_event_id
       and (p_property_id is null or eo.property_id = p_property_id)
       and ot.active
       and ot.code = w.code
       and ot.price_cents is distinct from w.price_cents
    returning ot.id
  ),
  matched as (
    select count(*) as n
      from offer_tier ot
      join event_offer eo on eo.id = ot.event_offer_id
      join wanted w on w.code = ot.code
     where eo.event_id = p_event_id
       and (p_property_id is null or eo.property_id = p_property_id)
       and ot.active
  )
  select n into v_applied from matched;

  if coalesce(v_applied, 0) = 0 then
    raise exception 'NO_TIER_MATCH: "%" prices nothing this night sells', v_name
      using errcode = 'check_violation';
  end if;

  return v_applied;
end;
$function$;

comment on function apply_price_template(uuid, uuid, uuid) is
  'Set every tier on one event to a pricing template''s prices. Matched on tier code; returns how many tiers the template covers.';
