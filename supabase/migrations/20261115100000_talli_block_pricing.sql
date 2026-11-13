-- =====================================================================
--  Talli Parking — one price per block (plan B1)
--
--  Plan § 3.4: each block has a price adjustment per type of park,
--  measured from the reference site (86 Paice Ave, the operator's own).
--  Every site in a block charges the same, so the price the booking page
--  shows for a block is the price whichever driveway in it is picked.
--  Andrew moves the reference price (a surge decision) and every block
--  follows at its adjustment. Nobody prices one site on its own.
--
--  What changes:
--
--    1. block_tier_offset (block_id, code, offset_cents). The reference
--       site's block is always zero.
--    2. apply_price_offsets() prices every site from its BLOCK's
--       adjustment for that type. property.price_offset_cents stays in
--       the table and nothing reads it any more.
--    3. set_tier_price() refuses any site but the reference site, and
--       moves every other site with it in the same transaction.
--       apply_price_template() also re-prices every block before it
--       returns, so a template can no longer leave blocks out of step.
--    4. set_block_offsets() saves a block's adjustments and re-prices
--       every upcoming night its sites sell.
--
--  The checkout guard (the page's price as an expectation) is in the
--  create-checkout function, not here: the amount it compares against is
--  booking.amount_cents, which hold_booking already writes from the tier.
--
--  Additive: one table, functions restated with their signatures as they
--  were, one new function. No view is touched.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. The adjustments
-- ---------------------------------------------------------------------
create table if not exists block_tier_offset (
  block_id     uuid not null references block(id) on delete cascade,
  code         text not null check (code in ('standard', 'priority', 'valet')),
  offset_cents integer not null default 0 check (abs(offset_cents) <= 10000),
  updated_at   timestamptz not null default now(),
  primary key (block_id, code)
);

comment on table block_tier_offset is
  'A block''s price for each type of park, as a difference from the reference '
  'site (the operator''s own). Every site in the block charges reference + '
  'this. A missing row is zero. The reference site''s block is always zero.';

alter table block_tier_offset enable row level security;
-- Read and written only through gate-ops and the functions below. The
-- default privileges Supabase gives a new table would let the anon key
-- query it (RLS would return nothing, but there is no reason to ask).
revoke all on block_tier_offset from public, anon, authenticated;
grant all on block_tier_offset to service_role;

-- Start each block where its anchor stood. Today every site's offset is
-- zero on both projects, so this writes zeros; it is here so a block
-- whose anchor had been given a difference keeps it.
insert into block_tier_offset (block_id, code, offset_cents)
select b.id, c.code, coalesce(p.price_offset_cents, 0)
  from block b
  cross join (values ('standard'), ('priority'), ('valet')) as c(code)
  left join property p on p.id = b.anchor_property_id
 where b.id is distinct from (select block_id from property where id = reference_property())
on conflict (block_id, code) do nothing;

comment on column property.price_offset_cents is
  'Retired by block pricing (20261115100000): nothing reads it. A site is '
  'priced from its block''s adjustment in block_tier_offset.';

-- ---------------------------------------------------------------------
--  2. Re-price every site at an event from the reference site
-- ---------------------------------------------------------------------
-- Every site but the reference, including the reference's own neighbours
-- (whose block adjustment is zero, so they match it exactly). A site in
-- no block is priced as the reference. Never below $1. Returns how many
-- prices changed. An event the reference site is not part of has nothing
-- to measure from and is left alone.
create or replace function public.apply_price_offsets(p_event_id uuid)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_ref uuid := reference_property();
  v_n integer;
begin
  if v_ref is null then
    return 0;
  end if;

  with ref as (
    select t.code, t.price_cents
      from offer_tier t join event_offer o on o.id = t.event_offer_id
     where o.event_id = p_event_id and o.property_id = v_ref
  ),
  want as (
    select t.id,
           greatest(100, ref.price_cents + coalesce(bto.offset_cents, 0)) as price_cents
      from offer_tier t
      join event_offer o on o.id = t.event_offer_id
      join property p    on p.id = o.property_id
      join ref           on ref.code = t.code
      left join block_tier_offset bto on bto.block_id = p.block_id and bto.code = t.code
     where o.event_id = p_event_id
       and o.property_id <> v_ref
  )
  update offer_tier t
     set price_cents = want.price_cents,
         price_updated_at = now()
    from want
   where t.id = want.id
     and t.price_cents is distinct from want.price_cents;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------------
--  3. One price moves them all
-- ---------------------------------------------------------------------
-- Same signature and bounds as 20260821092000. A price is set on the
-- reference site only; every other site follows in this transaction, so
-- there is no moment at which two sites in a block disagree.
create or replace function public.set_tier_price(
  p_event_id    uuid,
  p_property_id uuid,
  p_tier_code   text,
  p_price_cents integer
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id  uuid;
  v_ref uuid;
begin
  -- A price typed on a wet phone. $1 and $500 are both almost certainly a
  -- slip, and a slip here sells the whole yard at the wrong number.
  if p_price_cents is null or p_price_cents < 100 or p_price_cents > 50000 then
    raise exception 'BAD_PRICE: a price must be between $1 and $500'
      using errcode = 'check_violation';
  end if;

  v_ref := reference_property();
  if v_ref is not null and p_property_id is distinct from v_ref then
    raise exception 'REFERENCE_PRICE_ONLY: prices are set on the reference site; '
                    'every other site follows at its block''s adjustment'
      using errcode = 'check_violation';
  end if;

  select t.id into v_id
    from offer_tier t
    join event_offer o on o.id = t.event_offer_id
   where o.event_id = p_event_id and o.property_id = p_property_id
     and t.code = p_tier_code and t.active;

  if v_id is null then
    raise exception 'NO_TIER: no active tier "%" for that event', p_tier_code
      using errcode = 'check_violation';
  end if;

  update offer_tier
     set price_cents = p_price_cents, price_updated_at = now()
   where id = v_id;

  perform apply_price_offsets(p_event_id);

  return p_price_cents;
end;
$function$;

-- As 20260902110000, with the blocks put back at their adjustments before
-- it returns. A template names one price per type; applied to every site
-- at once it would otherwise flatten every block to the reference price.
create or replace function public.apply_price_template(
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

  perform apply_price_offsets(p_event_id);

  return v_applied;
end;
$function$;

-- ---------------------------------------------------------------------
--  4. Setting a block's adjustments
-- ---------------------------------------------------------------------
-- p_offsets: [{code, offset_cents}, ...]. Types not named keep what they
-- had. Re-prices every upcoming night any of the block's sites sell.
-- Returns how many nights were re-priced.
create or replace function public.set_block_offsets(p_block_id uuid, p_offsets jsonb)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_item jsonb;
  v_code text;
  v_cents integer;
  v_events integer := 0;
  r record;
begin
  if not exists (select 1 from block where id = p_block_id) then
    raise exception 'NO_SUCH_BLOCK: that area does not exist' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_offsets, '[]'::jsonb)) loop
    v_code := lower(v_item->>'code');
    if v_code not in ('standard', 'priority', 'valet') then
      raise exception 'BAD_TYPE: no type of park called "%"', v_code using errcode = 'check_violation';
    end if;
    begin
      v_cents := (v_item->>'offset_cents')::integer;
    exception when others then
      v_cents := null;
    end;
    if v_cents is null or abs(v_cents) > 10000 then
      raise exception 'BAD_OFFSET: an adjustment must be within $100' using errcode = 'check_violation';
    end if;
    -- The reference site's block is what every other price is measured
    -- from. An adjustment there would move the reference's neighbours
    -- away from the reference itself.
    if v_cents <> 0 and p_block_id = (select block_id from property where id = reference_property()) then
      raise exception 'REFERENCE_BLOCK: the reference site''s area is the price everything '
                      'is measured from; its adjustment is always zero'
        using errcode = 'check_violation';
    end if;

    insert into block_tier_offset (block_id, code, offset_cents, updated_at)
    values (p_block_id, v_code, v_cents, now())
    on conflict (block_id, code) do update
      set offset_cents = excluded.offset_cents, updated_at = now();
  end loop;

  for r in
    select distinct o.event_id
      from event_offer o
      join property p on p.id = o.property_id
      join event e on e.id = o.event_id
     where p.block_id = p_block_id
       and e.starts_at > now()
       and e.status not in ('closed', 'cancelled')
  loop
    perform apply_price_offsets(r.event_id);
    v_events := v_events + 1;
  end loop;

  return v_events;
end;
$function$;

revoke all on function public.apply_price_offsets(uuid) from public, anon, authenticated;
revoke all on function public.set_block_offsets(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_price_offsets(uuid) to service_role;
grant execute on function public.set_block_offsets(uuid, jsonb) to service_role;
