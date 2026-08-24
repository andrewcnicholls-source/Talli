-- =====================================================================
--  Talli Parking — putting a fixture on the website
--
--  Four states, and each one is a different thing for the person looking
--  at talli.co.nz:
--
--    draft      nothing. Row level security does not let the public see it
--               at all.
--    announced  the fixture is listed but cannot be booked. Tapping it asks
--               for an email so they can be told when it opens.
--    on_sale    bookable, unless the online cut-off below has passed.
--    closed     off the list entirely. Bookings already taken stand.
--
--  'cancelled' exists in the column and is deliberately NOT settable here.
--  Calling a fixture off strands everyone who has paid, and that is a
--  conversation with customers before it is a button on a phone.
--
--  The cut-off is the other half of the same question. On the night it is
--  the "stop selling online, we are gate-only now" lever, and it takes
--  effect the moment it is set: v_tier_availability reads it and every tier
--  goes to zero spots.
-- =====================================================================

create or replace function public.set_event_status(
  p_event_id uuid,
  p_status   text
) returns text
language plpgsql
set search_path to 'public'
as $$
declare
  v_e event%rowtype;
  v_tiers integer;
begin
  if p_status is null or p_status not in ('draft','announced','on_sale','closed') then
    raise exception 'BAD_STATUS: % is not a state this screen sets', coalesce(p_status, 'nothing')
      using errcode = 'check_violation';
  end if;

  select * into v_e from event where id = p_event_id for update;
  if not found then
    raise exception 'NO_SUCH_EVENT: that fixture is gone' using errcode = 'no_data_found';
  end if;

  -- Bookable with nothing to book is a dead end for whoever taps it.
  if p_status = 'on_sale' then
    select count(*) into v_tiers
      from offer_tier t
      join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and t.active;
    if v_tiers = 0 then
      raise exception 'NOTHING_TO_SELL: this fixture has no spots set up yet'
        using errcode = 'check_violation';
    end if;
  end if;

  update event set status = p_status where id = p_event_id;
  return p_status;
end;
$$;

-- When online sales stop. Null means open until sold out.
create or replace function public.set_event_sales_close(
  p_event_id uuid,
  p_at       timestamptz
) returns timestamptz
language plpgsql
set search_path to 'public'
as $$
declare v_e event%rowtype;
begin
  select * into v_e from event where id = p_event_id for update;
  if not found then
    raise exception 'NO_SUCH_EVENT: that fixture is gone' using errcode = 'no_data_found';
  end if;

  -- A cut-off a year out from the fixture is a typo, not a decision.
  if p_at is not null and abs(extract(epoch from (p_at - v_e.starts_at))) > 31536000 then
    raise exception 'BAD_CUTOFF: that is nowhere near this fixture'
      using errcode = 'check_violation';
  end if;

  update event set online_sales_close_at = p_at where id = p_event_id;
  return p_at;
end;
$$;
