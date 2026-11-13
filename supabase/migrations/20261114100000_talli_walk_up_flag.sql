-- =====================================================================
--  Walk-ups on the night (plan A3).
--
--  "Sold out online is not sold out" (plan § 3.3). When a block's online
--  share of a type is gone but spaces are still held for the gate, the
--  booking page says walk-ups are still available. It says that there are
--  some, never how many, so the view carries a yes/no and no count.
--
--  v_block_tier_availability gains one column, at the end:
--
--    walk_ups_on_the_night   true when at least one confirmed site in the
--                            block has a space of this type that only the
--                            gate can sell and nobody has bought yet.
--
--  From v_tier_availability (20260918160000), per site:
--    spots_left       capacity - sold - gate_reserve   (0 once online closes)
--    spots_left_gate  capacity - sold
--  so spots_left_gate > spots_left is exactly "a space the website cannot
--  sell and the gate still can". A manually sold-out type is 0 in both.
--
--  Everything else in the view is restated as 20261105100000 left it.
--  Additive: a column on the end, security_invoker re-asserted.
-- =====================================================================

create or replace view v_block_tier_availability
with (security_invoker = true) as
select a.event_id,
       bl.id                    as block_id,
       bl.name                  as block_name,
       anchor.address           as anchor_address,
       anchor.name              as anchor_name,
       bl.lat, bl.lng,
       a.code,
       -- One label, price and window per type: the anchor's if it sells it,
       -- otherwise the first site's. Prices are set collectively per block.
       (array_agg(a.label         order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as label,
       (array_agg(a.price_cents   order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as price_cents,
       (array_agg(a.arrival_from  order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as arrival_from,
       (array_agg(a.arrival_until order by (a.property_id = bl.anchor_property_id) desc, p.name))[1] as arrival_until,
       min(a.sort_order)        as sort_order,
       sum(a.spots_left)::integer as spots_left,
       bl.sort_order            as block_sort,
       coalesce(bool_or(a.spots_left_gate > a.spots_left), false) as walk_ups_on_the_night
  from v_tier_availability a
  join property p     on p.id = a.property_id and p.active
  join block bl       on bl.id = p.block_id and bl.active
  join event_offer o  on o.event_id = a.event_id and o.property_id = a.property_id
  left join property anchor on anchor.id = bl.anchor_property_id
 where o.status = 'confirmed'
 group by a.event_id, bl.id, bl.name, anchor.address, anchor.name, bl.lat, bl.lng,
          a.code, bl.sort_order;

alter view v_block_tier_availability set (security_invoker = true);

comment on view v_block_tier_availability is
  'One row per event, block and type of space: what the booking page sells. '
  'spots_left is the online count summed over the block''s confirmed sites. '
  'walk_ups_on_the_night says whether the gate still has an unsold space of '
  'this type held back from the website; it is a yes/no on purpose (plan A3).';

comment on column v_block_tier_availability.walk_ups_on_the_night is
  'True when a confirmed site in the block holds an unsold space of this type '
  'for the gate. Never a count: the website says there are some, not how many.';

grant select on v_block_tier_availability to anon, authenticated;
