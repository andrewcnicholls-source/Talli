-- Priority exit sells the three free-exit bays on the front lawn. One of them
-- was being held back for walk-ups, which left only two on sale online.
-- Andrew wants all three sellable in advance; walk-ups get the berm, which is
-- gate-only anyway and has far more room than the reserve was protecting.
update zone set gate_reserve = 0 where code = 'front_lawn';
