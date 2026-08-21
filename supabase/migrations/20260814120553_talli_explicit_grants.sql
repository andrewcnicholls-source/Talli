-- POLICIES AND GRANTS ARE DIFFERENT THINGS. A policy decides WHICH ROWS a role
-- may see; a GRANT decides whether it may touch the table at all. Supabase
-- grants anon/authenticated broadly across the public schema by default, which
-- left `booking` merely returning zero rows rather than being unreferenceable.
-- Stating the grants explicitly closes that and makes the intent portable.

revoke all on all tables in schema public from anon, authenticated;

-- Catalogue: what the booking page needs to render.
grant select on property, zone, bay, event, event_offer, offer_tier,
                bay_allocation
  to anon, authenticated;

-- Availability views. No personal data, and being security_invoker they still
-- obey the row policies.
grant select on v_bay_inventory, v_tier_availability, v_zone_capacity
  to anon, authenticated;

-- Not granted, deliberately: host, booking, processed_webhook_event,
-- v_gate_list, v_relocatable_to_consent_zone, v_pricing_warnings.
