-- =====================================================================
--  Talli Parking — arrival windows that match how the night runs
--
--  The seeded windows closed before kickoff for every option: valet at
--  T-5, priority exit and standard at T-10. That is not how the night
--  actually works.
--
--    Valet and Priority exit   take cars right up to kickoff (T-0).
--      Both are parked by a marshal at the front of the property, so a
--      late arrival costs a wave of the arm and nothing else.
--
--    Standard                  closes half an hour before (T-30).
--      Standard fills the back yard, and the back yard is packed by
--      double-parking cars behind each other. A car that turns up after
--      the stack is built has nowhere to go without unpicking it.
--
--  The point of the earlier standard cutoff is not to turn people away.
--  It is to have a stated time, so a late standard arrival is a decision
--  taken at the gate rather than a promise already broken.
--
--  Three things change together, so the booking page, the admin modal
--  and the templates cannot drift apart:
--
--    1. normalise_event_tiers defaults the close by tier code, the way
--       it already defaults the zone list by tier code. Anything that
--       does not name a window gets the right one for what it is.
--    2. The seeded templates carry the new numbers explicitly.
--    3. Events already on sale, and not yet started, are moved.
--
--  Bookings that already exist are NOT moved. booking.arrival_from and
--  booking.arrival_until are copied from the tier at purchase precisely
--  so the confirmation, the gate list and any dispute all agree on what
--  was promised to that customer. Re-writing them would change a promise
--  after the fact, and for standard it would narrow one.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. The default close, by tier code.
--
--  Unchanged from 20260831120000 apart from v_until: where the code was
--  a flat coalesce(..., -10), it now falls back the way zone_codes
--  already does — on what the tier is. An explicit value in the payload
--  still wins, so a one-off fixture can still say something else.
-- ---------------------------------------------------------------------
create or replace function normalise_event_tiers(p_tiers jsonb)
returns jsonb
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_item  jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_codes text[] := array[]::text[];
  v_code  text;
  v_label text;
  v_price integer;
  v_from  integer;
  v_until integer;
  v_depart integer;
  v_kind  text;
  v_zones jsonb;
  v_n     integer := 0;
begin
  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'BAD_TIERS: the tier list must be an array'
      using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_tiers) = 0 then
    raise exception 'NO_TIERS: an event needs at least one thing to sell'
      using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_tiers) > 12 then
    raise exception 'TOO_MANY_TIERS: twelve options is already more than anyone reads'
      using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_tiers) loop
    v_n := v_n + 1;

    v_code := lower(trim(coalesce(v_item ->> 'code', '')));
    if v_code !~ '^[a-z][a-z0-9_]{0,30}$' then
      raise exception 'BAD_TIER_CODE: "%" is not a usable tier code — letters, digits and underscores', v_code
        using errcode = 'check_violation';
    end if;
    if v_code = any (v_codes) then
      raise exception 'DUPLICATE_TIER: "%" is listed twice', v_code
        using errcode = 'check_violation';
    end if;
    v_codes := v_codes || v_code;

    -- A tier with no label of its own gets a readable one rather than a
    -- code shown to a customer.
    v_label := nullif(trim(coalesce(v_item ->> 'label', '')), '');
    if v_label is null then
      v_label := initcap(replace(v_code, '_', ' '));
    end if;
    if length(v_label) > 160 then
      raise exception 'LONG_LABEL: "%" is too long for the booking page', v_code
        using errcode = 'check_violation';
    end if;

    -- The same bounds set_tier_price enforces on the night. A price typed
    -- on a wet phone is wrong in the same ways whenever it is typed.
    v_price := (v_item ->> 'price_cents')::integer;
    if v_price is null or v_price < 100 or v_price > 50000 then
      raise exception 'BAD_PRICE: % must be priced between $1 and $500', v_code
        using errcode = 'check_violation';
    end if;

    v_from   := coalesce((v_item ->> 'arrival_from_minutes')::integer, -150);
    -- Valet and priority are parked for you at the front, so they can take
    -- a car at kickoff. Standard is double-parked in the back yard and has
    -- to close while there is still someone to build the stack.
    v_until  := coalesce(
                  (v_item ->> 'arrival_until_minutes')::integer,
                  case v_code
                    when 'valet'    then 0
                    when 'priority' then 0
                    when 'standard' then -30
                    else -10
                  end);
    v_depart := (v_item ->> 'departure_by_minutes')::integer;
    if v_from < -1440 or v_from > 1440 or v_until < -1440 or v_until > 1440 then
      raise exception 'BAD_WINDOW: % arrives more than a day either side of kickoff', v_code
        using errcode = 'check_violation';
    end if;
    if v_until <= v_from then
      raise exception 'BAD_WINDOW: % closes its arrival window before it opens', v_code
        using errcode = 'check_violation';
    end if;

    v_kind := lower(trim(coalesce(v_item ->> 'bay_kind', 'any')));
    if v_kind not in ('free_exit', 'may_be_blocked', 'any') then
      raise exception 'BAD_BAY_KIND: % must be free_exit, may_be_blocked or any', v_code
        using errcode = 'check_violation';
    end if;

    -- Null zone list = fulfil from anywhere on the property. An empty list
    -- would mean "nowhere", which is never what anyone meant.
    v_zones := v_item -> 'zone_codes';
    if v_zones is null or jsonb_typeof(v_zones) <> 'array' or jsonb_array_length(v_zones) = 0 then
      v_zones := case v_code
                   when 'valet'    then '["valet"]'::jsonb
                   when 'priority' then '["front_lawn","berm"]'::jsonb
                   when 'standard' then '["back_yard"]'::jsonb
                   else null
                 end;
    end if;

    v_out := v_out || jsonb_build_object(
      'code', v_code,
      'label', v_label,
      'price_cents', v_price,
      'zone_codes', v_zones,
      'bay_kind', v_kind,
      'guarantees_clear_exit', coalesce((v_item ->> 'guarantees_clear_exit')::boolean, false),
      'arrival_from_minutes', v_from,
      'arrival_until_minutes', v_until,
      'departure_by_minutes', v_depart,
      'sort_order', coalesce((v_item ->> 'sort_order')::integer, v_n)
    );
  end loop;

  return v_out;
end;
$function$;

-- ---------------------------------------------------------------------
--  2. The templates already saved.
--
--  The three seeded templates wrote -5 / -10 / -10 into their tier JSON
--  explicitly, so the new default above would never reach them. Rewrite
--  the number in place, tier by tier, leaving every other key — price,
--  label, zones — exactly as whoever tuned that template left it.
--
--  Only the three known codes are touched. A template carrying a tier
--  somebody invented keeps whatever window it was given.
-- ---------------------------------------------------------------------
update event_template t set
  tiers = (
    select jsonb_agg(
             case
               when lower(item ->> 'code') in ('valet', 'priority')
                 then item || jsonb_build_object('arrival_until_minutes', 0)
               when lower(item ->> 'code') = 'standard'
                 then item || jsonb_build_object('arrival_until_minutes', -30)
               else item
             end
             order by ord
           )
    from jsonb_array_elements(t.tiers) with ordinality as e(item, ord)
  )
where jsonb_typeof(t.tiers) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(t.tiers) as item
    where lower(item ->> 'code') in ('valet', 'priority', 'standard')
  );

-- ---------------------------------------------------------------------
--  3. What is on sale right now.
--
--  offer_tier stores absolute timestamps, not offsets, so the new close
--  has to be computed back from each event's kickoff. Only events that
--  have not started yet: a finished night's record of when it took cars
--  is history, and history does not get edited.
--
--  arrival_from is left alone. The gates-open end of the window did not
--  change, and every row already satisfies arrival_until > arrival_from
--  afterwards — the earliest new close is kickoff minus 30 minutes and
--  the seeded open is kickoff minus 150.
-- ---------------------------------------------------------------------
update offer_tier ot set
  arrival_until = ev.starts_at
                  + make_interval(mins => case ot.code
                                            when 'standard' then -30
                                            else 0
                                          end)
from event_offer eo
join event ev on ev.id = eo.event_id
where ot.event_offer_id = eo.id
  and ev.starts_at > now()
  and ev.status in ('draft', 'announced', 'on_sale')
  and ot.code in ('valet', 'priority', 'standard')
  and ot.arrival_until <> ev.starts_at
                          + make_interval(mins => case ot.code
                                                    when 'standard' then -30
                                                    else 0
                                                  end)
  and ev.starts_at
      + make_interval(mins => case ot.code when 'standard' then -30 else 0 end)
      > ot.arrival_from;
