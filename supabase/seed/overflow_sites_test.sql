-- =====================================================================
--  Test-environment seed: two places to send a car
--
--  A site is somewhere we do NOT hold bays for. We hand the car over and
--  the destination decides where it goes. That is what separates it from
--  the berm zones in the yard model, which we allocate bay by bay.
--
--  The neighbour's verge appears in both models today — as three bays in
--  the neighbour_berm zone, and as the site below. On any given night use
--  one or the other, or the same grass gets sold twice.
-- =====================================================================

insert into public.overflow_site
  (code, name, address, walk_minutes, contact_name, contact_phone,
   their_price_cents, referral_fee_cents, customer_pays_site,
   default_spots, notes, sort_order)
values
  ('paice_84_berm', '84 Paice verge (we run it)',
   '84 Paice Avenue, Sandringham', 12, 'Talli', null,
   null, 0, false, 3,
   'The neighbour''s verge we already look after. Nothing to refund — the money stays with us.', 1),

  ('test_partner_92', 'TEST partner — 92 Paice Ave',
   '92 Paice Avenue, Sandringham', 13, 'Test Neighbour', '021 000 0000',
   1000, 100, true, 4,
   'Stand-in for a referred house. They take the money at their gate, we book $1 for the introduction.', 2)
on conflict (code) do nothing;
