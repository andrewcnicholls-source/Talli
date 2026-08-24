-- The NPC games run on three tiers, not six. Six is too much to explain on a
-- phone and too much to run at the gate on a first live night.
--
--   Standard  $10   back yard
--   Priority  $12   front lawn, nobody behind you
--   Valet     $15   valet lane
--
-- Standard also widens from 'may_be_blocked' to 'any'. Without that, cutting
-- the other tiers would strand the seven free-exit bays in the back yard that
-- Quick getaway used to sell — ten bays unsellable online instead of three.
with npc as (
  select id from event where name in (
    'Auckland v Bay of Plenty',
    'Auckland v Counties Manukau',
    'Auckland v Manawatu')
)
update offer_tier t set
  active = (t.code in ('standard', 'priority', 'valet')),
  price_cents = case t.code
                  when 'standard' then 1000
                  when 'priority' then 1200
                  when 'valet'    then 1500
                  else t.price_cents end,
  bay_kind = case when t.code = 'standard' then 'any' else t.bay_kind end,
  -- Valet holds keys so the yard can be packed tight. It has never brought
  -- the car back to anyone, and the label should not promise that.
  label = case t.code
            when 'valet' then 'Valet — hand us your keys and we''ll park it for you'
            else t.label end
from event_offer eo
where eo.id = t.event_offer_id and eo.event_id in (select id from npc);

-- All three NPC games sell, not just the first two.
update event set status = 'on_sale' where name = 'Auckland v Manawatu';
