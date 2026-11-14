-- =====================================================================
--  A night always has something to sell.
--
--  A site joins a night (add_event_offer, from the Sites page or from
--  create_gate_event) by copying the spaces and prices of a site already
--  on that night. A night with no site yet had nothing to copy, so every
--  site added to it came in pending with no tiers at all: no spaces, no
--  prices. The booking page lists only confirmed sites with tiers, so the
--  night offered nothing; the Event tab had no price to move; and nothing
--  on the gate screen could make one. The Blues 2027 nights on test were
--  made that way and sat "on sale" with nothing behind them.
--
--  Three changes:
--
--   1. A site with nothing to copy takes its tiers from the active pricing
--      template for the night's demand tier (the same templates the new
--      event form offers), with the site's own default spaces. The
--      reference site — Talli's own driveway — added as a night's first
--      site is confirmed, as create_gate_event has always done for it.
--      Any other site still waits for a deliberate tap on the Sites page.
--
--   2. set_event_status refuses on_sale for a night where no confirmed
--      site has spaces: NOTHING_TO_SELL. A night is taken off sale freely.
--
--   3. Upcoming nights already caught by it are repaired the same way.
-- =====================================================================

-- ------------------------------------------------ 1. tiers from a template
create or replace function private.seed_offer_tiers(p_offer uuid)
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  o      event_offer%rowtype;
  e      event%rowtype;
  v_tiers jsonb;
  v_end   integer;
  v_n     integer;
begin
  select * into o from event_offer where id = p_offer;
  if not found then return 0; end if;
  -- Only ever fills an empty site: a priced one is never overwritten.
  if exists (select 1 from offer_tier where event_offer_id = p_offer) then return 0; end if;

  select * into e from event where id = o.event_id;

  select t.tiers into v_tiers
    from event_template t
   where t.active
   order by (t.demand_tier = e.demand_tier) desc, t.sort_order, t.name
   limit 1;
  if v_tiers is null then return 0; end if;
  v_tiers := normalise_event_tiers(v_tiers);

  v_end := coalesce((extract(epoch from (e.expected_end_at - e.starts_at)) / 60)::integer, 150);

  insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                          guarantees_clear_exit, arrival_from, arrival_until, departure_by,
                          sort_order, active, manually_sold_out, gate_reserve, capacity)
  select p_offer,
         i ->> 'code',
         i ->> 'label',
         (i ->> 'price_cents')::integer,
         '{}'::text[],
         i ->> 'bay_kind',
         coalesce((i ->> 'guarantees_clear_exit')::boolean, false),
         e.starts_at + make_interval(mins => coalesce((i ->> 'arrival_from_minutes')::integer, -150)),
         e.starts_at + make_interval(mins => coalesce((i ->> 'arrival_until_minutes')::integer, 0)),
         e.starts_at + make_interval(mins => coalesce(
           (i ->> 'departure_by_minutes')::integer,
           default_departure_minutes(i ->> 'code', v_end))),
         (i ->> 'sort_order')::integer,
         true,
         false,
         coalesce(d.capacity - d.online, 0),
         coalesce(d.capacity, 0)
    from jsonb_array_elements(v_tiers) as i
    left join property_tier_default d
      on d.property_id = o.property_id and d.code = i ->> 'code';
  get diagnostics v_n = row_count;

  perform apply_price_offsets(o.event_id);
  return v_n;
end;
$function$;

revoke all on function private.seed_offer_tiers(uuid) from public, anon, authenticated;
grant execute on function private.seed_offer_tiers(uuid) to service_role;

create or replace function add_event_offer(p_event_id uuid, p_property_id uuid)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_offer  uuid;
  v_source uuid;
  v_block  uuid;
  v_first  boolean;
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
  v_first := not exists (select 1 from event_offer where event_id = p_event_id);

  -- A site to copy from: one that has tiers, in this site's block first.
  select o.id into v_source
    from event_offer o join property p on p.id = o.property_id
   where o.event_id = p_event_id
     and exists (select 1 from offer_tier t where t.event_offer_id = o.id)
   order by (p.block_id is not distinct from v_block) desc, o.id
   limit 1;

  insert into event_offer (event_id, property_id, status)
  values (p_event_id, p_property_id,
          case when v_first and p_property_id = reference_property()
               then 'confirmed' else 'pending' end)
  returning id into v_offer;

  if v_source is not null then
    insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                            guarantees_clear_exit, arrival_from, arrival_until, departure_by,
                            sort_order, active, manually_sold_out, gate_reserve, capacity)
    select v_offer, t.code, t.label, t.price_cents, '{}'::text[], t.bay_kind,
           t.guarantees_clear_exit, t.arrival_from, t.arrival_until, t.departure_by,
           t.sort_order, t.active, false,
           coalesce(d.capacity - d.online, 0), coalesce(d.capacity, 0)
      from offer_tier t
      left join property_tier_default d on d.property_id = p_property_id and d.code = t.code
     where t.event_offer_id = v_source;

    perform apply_price_offsets(p_event_id);
  else
    perform private.seed_offer_tiers(v_offer);
  end if;

  return v_offer;
end;
$function$;

-- ------------------------------------------- 2. nothing to sell, no sale
create or replace function set_event_status(
  p_event_id uuid,
  p_status   text
) returns text
language plpgsql
set search_path to 'public'
as $function$
declare v_before text;
begin
  if coalesce(p_status, '') not in
     ('draft','announced','on_sale','closed','cancelled') then
    raise exception 'BAD_STATUS: % is not an event status', p_status
      using errcode = 'check_violation';
  end if;

  select status into v_before from event where id = p_event_id;
  if v_before is null then
    raise exception 'NO_EVENT: no such event'
      using errcode = 'check_violation';
  end if;

  if p_status = 'on_sale' and v_before <> 'on_sale' and not exists (
    select 1 from event_offer o join offer_tier t on t.event_offer_id = o.id
     where o.event_id = p_event_id and o.status = 'confirmed'
       and t.active and coalesce(t.capacity, 0) > 0
  ) then
    raise exception 'NOTHING_TO_SELL: no site is on sale with spaces on this night'
      using errcode = 'check_violation';
  end if;

  update event set status = p_status,
                   is_live = is_live and p_status not in ('draft', 'cancelled')
   where id = p_event_id;
  return p_status;
end;
$function$;

-- ---------------------------------------- 3. the nights already caught
-- The reference site, where it is a night's only hope of selling.
update event_offer o set status = 'confirmed'
 where o.status = 'pending'
   and o.property_id = reference_property()
   and not exists (select 1 from offer_tier t where t.event_offer_id = o.id)
   and not exists (select 1 from event_offer x
                    where x.event_id = o.event_id and x.status = 'confirmed')
   and private.night_is_upcoming(o.event_id);

select private.seed_offer_tiers(o.id)
  from event_offer o
 where not exists (select 1 from offer_tier t where t.event_offer_id = o.id)
   and private.night_is_upcoming(o.event_id);
