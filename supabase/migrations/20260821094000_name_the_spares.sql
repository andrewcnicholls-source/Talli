-- =====================================================================
--  Talli Parking — spares that say where to put the car
--
--  The label is what the marshal reads at 6:40pm, so "Overflow — street
--  verge spare 2" is no help to anyone.
--
--  The neighbour's verge is modelled as its own property, and no event has
--  ever offered it, so bays sitting over there were unreachable. The berm
--  zone carries exactly the flags it would — consent required, never sold
--  in advance — so the neighbour's spaces live there as spares instead:
--  tap +1 on Overflow when they wave you on, and the space is real and
--  sellable within seconds.
-- =====================================================================

delete from bay b
 using zone z
 where z.id = b.zone_id and z.code = 'neighbour_berm' and b.is_flex
   and not exists (select 1 from bay_allocation a where a.bay_id = b.id);

update bay b
   set label = 'Overflow — neighbour''s berm ' ||
               regexp_replace(b.label, '^.* spare ', '')
  from zone z
 where z.id = b.zone_id and z.code = 'berm' and b.is_flex
   and b.label like '% spare %';

update bay b
   set label = 'Back yard — squeeze ' || regexp_replace(b.label, '^.* spare ', '')
  from zone z
 where z.id = b.zone_id and z.code = 'back_yard' and b.is_flex
   and b.label like '% spare %';

update bay b
   set label = 'Front lawn — squeeze ' || regexp_replace(b.label, '^.* spare ', '')
  from zone z
 where z.id = b.zone_id and z.code = 'front_lawn' and b.is_flex
   and b.label like '% spare %';

update bay b
   set label = 'Valet lane — squeeze ' || regexp_replace(b.label, '^.* spare ', '')
  from zone z
 where z.id = b.zone_id and z.code = 'valet' and b.is_flex
   and b.label like '% spare %';
