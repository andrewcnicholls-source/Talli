-- Enforce the reserve and cutoff at the point of sale, and add the check-in
-- and reconciliation the marshal needs on the night.

create or replace function hold_booking(
  p_event_id     uuid,
  p_property_id  uuid,
  p_tier_code    text,
  p_email        text,
  p_name         text default null,
  p_phone        text default null,
  p_rego         text default null,
  p_hold_minutes int  default 30,
  p_channel      text default 'online',
  p_accepts_street boolean default false,
  p_payment_method text default 'stripe'
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_tier       offer_tier%rowtype;
  v_close      timestamptz;
  v_share      numeric(5,4);
  v_platform   int;
  v_booking_id uuid;
  v_bay        record;
  v_got_bay    boolean := false;
begin
  select t.* into v_tier
    from offer_tier t join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;
  if not found then
    raise exception 'No active tier "%" for that event and property', p_tier_code;
  end if;

  -- Hard stop: after the cutoff the night belongs to the marshal.
  if p_channel = 'online' then
    select e.online_sales_close_at into v_close from event e where e.id = p_event_id;
    if v_close is not null and now() > v_close then
      raise exception 'ONLINE_SALES_CLOSED: online sales for this event closed at %', v_close
        using errcode = 'check_violation';
    end if;
  end if;

  select h.platform_share into v_share
    from property pr join host h on h.id = pr.host_id where pr.id = p_property_id;
  v_platform := round(v_tier.price_cents * v_share);

  insert into booking (
    event_id, property_id, tier_code, customer_email, customer_name,
    customer_phone, vehicle_rego, amount_cents,
    arrival_from, arrival_until, must_depart_by,
    platform_fee_cents, host_earnings_cents,
    channel, payment_method, accepts_street_parking, status, hold_expires_at
  ) values (
    p_event_id, p_property_id, v_tier.code, p_email, p_name,
    p_phone, p_rego, v_tier.price_cents,
    v_tier.arrival_from, v_tier.arrival_until, v_tier.departure_by,
    v_platform, v_tier.price_cents - v_platform,
    p_channel, p_payment_method, p_accepts_street, 'held',
    now() + make_interval(mins => p_hold_minutes)
  ) returning id into v_booking_id;

  for v_bay in
    select i.bay_id, i.blocker_bay_id
      from v_bay_inventory i
     where i.event_id = p_event_id and i.property_id = p_property_id and i.available
       and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
       and (p_channel = 'gate' or i.reservable_in_advance)
       and (not i.requires_consent or p_accepts_street)
       -- Online may not sell a zone down into its walk-up reserve.
       and (p_channel = 'gate' or i.gate_reserve = 0 or (
             select count(*) from v_bay_inventory j
              where j.event_id = p_event_id and j.zone_id = i.zone_id and j.available
           ) > i.gate_reserve)
       and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                when 'blocking' then i.is_blocking else true end
       and (not v_tier.guarantees_clear_exit or i.blocker_bay_id is null
            or not exists (select 1 from bay_allocation a2
                           where a2.event_id = p_event_id and a2.bay_id = i.blocker_bay_id))
     order by
       case when i.reservable_in_advance then 1 else 0 end,
       case when v_tier.guarantees_clear_exit and i.blocker_bay_id is null then 0 else 1 end,
       i.exit_rank, i.bay_label
  loop
    begin
      insert into bay_allocation (event_id, bay_id, booking_id, role)
      values (p_event_id, v_bay.bay_id, v_booking_id, 'occupied');
      if v_tier.guarantees_clear_exit and v_bay.blocker_bay_id is not null then
        insert into bay_allocation (event_id, bay_id, booking_id, role)
        values (p_event_id, v_bay.blocker_bay_id, v_booking_id, 'blocked_reserve');
      end if;
      v_got_bay := true;
      exit;
    exception when unique_violation then
      continue;
    end;
  end loop;

  if not v_got_bay then
    -- Three distinct reasons you might be turned away; say which.
    if p_channel = 'online' and exists (
         select 1 from v_bay_inventory i
          where i.event_id = p_event_id and i.property_id = p_property_id
            and i.available and i.reservable_in_advance
            and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
            and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                     when 'blocking' then i.is_blocking else true end)
    then
      raise exception 'HELD_FOR_GATE: the only space left in that zone is the walk-up reserve'
        using errcode = 'check_violation';
    end if;

    if not p_accepts_street and exists (
         select 1 from v_bay_inventory i
          where i.event_id = p_event_id and i.property_id = p_property_id
            and i.available and i.requires_consent
            and (v_tier.zone_codes is null or i.zone_code = any(v_tier.zone_codes))
            and (p_channel = 'gate' or i.reservable_in_advance)
            and case v_tier.bay_kind when 'clear' then not i.is_blocking
                                     when 'blocking' then i.is_blocking else true end)
    then
      raise exception 'CONSENT_REQUIRED: space is available for tier "%", but only in a zone the customer must opt into first', p_tier_code
        using errcode = 'check_violation';
    end if;

    raise exception 'SOLD_OUT: no bay available for tier "%" at that property', p_tier_code
      using errcode = 'check_violation';
  end if;

  return v_booking_id;
end;
$$;

revoke execute on function hold_booking(uuid, uuid, text, text, text, text, text, int, text, boolean, text)
  from public, anon, authenticated;

-- One tap on the night: mark a car as arrived. Idempotent.
create or replace function check_in_booking(p_booking_id uuid)
returns void language plpgsql set search_path = public as $$
begin
  update booking set checked_in_at = coalesce(checked_in_at, now())
   where id = p_booking_id and status in ('paid','held');
end;
$$;
revoke execute on function check_in_booking(uuid) from public, anon, authenticated;

-- Sell to a walk-up and take their money in one call. Defaults to cash,
-- immediately paid and checked in, no hold to expire.
create or replace function sell_at_gate(
  p_event_id      uuid,
  p_property_id   uuid,
  p_tier_code     text,
  p_payment_method text default 'cash',
  p_rego          text default null,
  p_name          text default null,
  p_phone         text default null,
  p_email         text default null,
  p_accepts_street boolean default false
) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  v_id := hold_booking(
    p_event_id, p_property_id, p_tier_code,
    coalesce(p_email, 'gate+' || replace(gen_random_uuid()::text,'-','') || '@talli.co.nz'),
    p_name, p_phone, p_rego, 5, 'gate', p_accepts_street, p_payment_method);
  perform confirm_booking(v_id, null);
  perform check_in_booking(v_id);
  return v_id;
end;
$$;
revoke execute on function sell_at_gate(uuid, uuid, text, text, text, text, text, text, boolean)
  from public, anon, authenticated;

-- The gate list, now with arrival state. Dropped rather than replaced because
-- the column order changes.
drop view if exists v_gate_list;
create view v_gate_list
with (security_invoker = true) as
select
  b.event_id, e.name as event_name, b.id as booking_id,
  b.customer_name, b.customer_phone, b.vehicle_rego, b.tier_code,
  i.zone_label, i.bay_label, i.exit_class,
  b.arrival_from, b.arrival_until, b.must_depart_by,
  b.accepts_street_parking, b.channel, b.payment_method, b.status,
  b.checked_in_at, (b.checked_in_at is not null) as arrived,
  b.amount_cents, b.notes
from booking b
join event e on e.id = b.event_id
left join bay_allocation a on a.booking_id = b.id and a.role = 'occupied'
left join v_bay_inventory i on i.bay_id = a.bay_id and i.event_id = b.event_id
where b.status in ('paid','held');

-- End-of-night reconciliation: who paid how, and did they turn up.
create or replace view v_night_summary
with (security_invoker = true) as
select
  b.event_id, e.name as event_name,
  b.channel, b.payment_method, b.status,
  count(*)::int                                            as bookings,
  count(*) filter (where b.checked_in_at is not null)::int as arrived,
  count(*) filter (where b.checked_in_at is null
                     and b.status = 'paid')::int           as paid_no_show,
  (sum(b.amount_cents)/100.0)::numeric(10,2)               as gross_nzd
from booking b
join event e on e.id = b.event_id
where b.status in ('paid','refunded','no_show')
group by b.event_id, e.name, b.channel, b.payment_method, b.status;

-- Cash you should physically be holding at the end of the night.
create or replace view v_cash_expected
with (security_invoker = true) as
select b.event_id, e.name as event_name,
       count(*)::int as cash_sales,
       (sum(b.amount_cents)/100.0)::numeric(10,2) as cash_nzd
from booking b join event e on e.id = b.event_id
where b.payment_method = 'cash' and b.status = 'paid'
group by b.event_id, e.name;

-- Operational views stay staff-only.
revoke all on v_gate_list, v_night_summary, v_cash_expected
  from public, anon, authenticated;
