-- Going live on the NPC games deliberately: small crowds, bonus money, a real
-- rehearsal well before anything that matters. The Bledisloe is none of those
-- things and was sitting on_sale, so it would have gone on sale the moment the
-- booking page shipped. Off sale until the first NPC night has been run for
-- real. One word puts it back.
update event set status = 'draft'
where name = 'All Blacks v Australia (Bledisloe Cup)';
