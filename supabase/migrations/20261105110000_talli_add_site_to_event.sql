-- =====================================================================
--  Talli Parking — add a host's driveway to an event from the phone
--
--  Until now a second site at an event meant SQL. This is the button:
--  pick a property, and it joins the event as *pending* (not sold online)
--  with the same types of space the event already sells — same labels,
--  arrival windows and prices, because pricing is collective per block —
--  and no spaces yet. Andrew then sets the counts on Tonight and puts it
--  on sale once the host has said yes.
--
--  Additive only: one new function.
-- =====================================================================

create or replace function public.add_event_offer(p_event_id uuid, p_property_id uuid)
 returns uuid
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_offer uuid;
  v_source uuid;
  v_block uuid;
begin
  if not exists (select 1 from property where id = p_property_id and active) then
    raise exception 'NO_SUCH_SITE: that property is not active'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from event_offer where event_id = p_event_id and property_id = p_property_id) then
    raise exception 'ALREADY_ADDED: that site is already part of this event'
      using errcode = 'check_violation';
  end if;

  select block_id into v_block from property where id = p_property_id;

  -- The types of space to copy: from a site in the same block if one is
  -- already selling this event (its prices are the block's), otherwise
  -- from any site at the event.
  select o.id into v_source
    from event_offer o join property p on p.id = o.property_id
   where o.event_id = p_event_id
   order by (p.block_id is not distinct from v_block) desc, o.id
   limit 1;

  insert into event_offer (event_id, property_id, status)
  values (p_event_id, p_property_id, 'pending')
  returning id into v_offer;

  if v_source is not null then
    insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                            guarantees_clear_exit, arrival_from, arrival_until, departure_by,
                            sort_order, active, manually_sold_out, gate_reserve, capacity)
    select v_offer, t.code, t.label, t.price_cents, '{}'::text[], t.bay_kind,
           t.guarantees_clear_exit, t.arrival_from, t.arrival_until, t.departure_by,
           t.sort_order, t.active, false, 0, 0
      from offer_tier t
     where t.event_offer_id = v_source;
  end if;

  return v_offer;
end;
$function$;

comment on function public.add_event_offer(uuid, uuid) is
  'Adds a property to an event as pending, copying the event''s types of space '
  'with no spaces set. Gate screen: Tonight → Sites tonight → Add a site.';

revoke all on function public.add_event_offer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_event_offer(uuid, uuid) to service_role;
