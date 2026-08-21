-- =====================================================================
--  Talli Parking — one line per item, whatever the request looked like
--
--  A payload may name the same item twice: a retry, a hand-built request,
--  two steppers bound to one code. Summing before pricing is both safer
--  (one row per code, so the unique constraint holds) and fairer — two
--  earplugs and then one more is an order of three, which earns the
--  2-for-$5 break instead of paying twice at full unit price.
--
--  Quantities are read defensively. "qty": "lots" is not a number, and the
--  answer to that is zero, not a 500 in the middle of checkout.
-- =====================================================================
create or replace function add_booking_addons(
  p_booking_id uuid,
  p_items      jsonb,
  p_channel    text default 'online'
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_code   text;
  v_wanted bigint;
  v_addon  addon%rowtype;
  v_qty    integer;
  v_amount integer;
  v_total  integer := 0;
begin
  if not exists (select 1 from booking where id = p_booking_id) then
    raise exception 'NO_BOOKING: no such booking' using errcode = 'check_violation';
  end if;

  delete from booking_addon where booking_id = p_booking_id;

  for v_code, v_wanted in
    select item ->> 'code',
           sum(case when item ->> 'qty' ~ '^[0-9]+$'
                    then least((item ->> 'qty')::bigint, 1000)
                    else 0 end)
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item
     where item ->> 'code' is not null
     group by item ->> 'code'
  loop
    select * into v_addon from addon where code = v_code and active;
    if not found then
      raise exception 'NO_SUCH_ADDON: % is not something we sell', v_code
        using errcode = 'check_violation';
    end if;

    v_qty := least(v_wanted, v_addon.max_qty)::integer;
    continue when v_qty <= 0;

    v_amount := addon_price_cents(
      v_addon.price_cents, v_addon.bundle_qty, v_addon.bundle_price_cents, v_qty);

    insert into booking_addon
      (booking_id, addon_id, code, name, qty, unit_price_cents, amount_cents, channel)
    values
      (p_booking_id, v_addon.id, v_addon.code, v_addon.name, v_qty,
       v_addon.price_cents, v_amount, coalesce(p_channel, 'online'));

    v_total := v_total + v_amount;
  end loop;

  update booking set addons_cents = v_total where id = p_booking_id;
  return v_total;
end;
$function$;
