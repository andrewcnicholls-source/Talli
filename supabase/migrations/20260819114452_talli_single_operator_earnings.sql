-- platform_share defaulted to 1.0, so every booking recorded the whole fare as
-- a platform fee and the host as earning nothing. Andrew is both the platform
-- and the host here: there is no cut to take. Setting his share to zero makes
-- host_earnings_cents the number that actually means something — what Talli
-- made on the night.
--
-- The neighbour's berm is left alone until the split for it is agreed. It is a
-- gate-only zone, so nothing can be sold against it online in the meantime.
update host set platform_share = 0 where name = 'Talli Limited';
