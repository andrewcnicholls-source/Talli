-- =====================================================================
--  Talli Parking — put security_invoker back on the replaced views
--
--  CREATE OR REPLACE VIEW resets reloptions. Replacing v_bay_inventory,
--  v_gate_list and v_tier_availability therefore dropped security_invoker
--  and left them running as SECURITY DEFINER — meaning an anon reader would
--  have bypassed RLS on everything they join, including seeing tiers and
--  prices for events still in draft.
--
--  Restored here, and the setting belongs beside any future replacement of
--  these views rather than being trusted to survive one.
-- =====================================================================

alter view v_bay_inventory     set (security_invoker = true);
alter view v_gate_list         set (security_invoker = true);
alter view v_tier_availability set (security_invoker = true);

-- An unqualified search_path lets a caller with a same-named object in an
-- earlier schema decide what this resolves to. Pin it, as the other functions
-- in this schema already do.
create or replace function addon_price_cents(
  p_unit_cents   integer,
  p_bundle_qty   integer,
  p_bundle_cents integer,
  p_qty          integer
) returns integer
language sql immutable
set search_path to 'public'
as $$
  select case
    when coalesce(p_qty, 0) <= 0 then 0
    when p_bundle_qty is null or p_bundle_cents is null then p_unit_cents * p_qty
    else least(
      p_unit_cents * p_qty,
      (p_qty / p_bundle_qty) * p_bundle_cents + (p_qty % p_bundle_qty) * p_unit_cents
    )
  end::integer;
$$;

-- booking_addon is as private as booking: it names a customer's order. RLS with
-- no policy already denies every anon read, but booking itself also has the
-- grant revoked, so a future policy added in haste cannot quietly open it.
-- Match that.
revoke all on booking_addon from anon, authenticated;
