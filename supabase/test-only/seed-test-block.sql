-- =====================================================================
--  TEST PROJECT ONLY — a second block to rehearse multi-site nights on.
--
--  Invented fixtures: "Gribblehurst (test)" with two host sites, offered at the
--  TEST — Robbie Williams event, plus one warden invitation who can see
--  only that block. Safe to re-run. Never run against production.
-- =====================================================================

insert into host (id, name, email, platform_share, payout_method)
values ('11111111-1111-1111-1111-1111111111a1', 'TEST Host A', 'host.a@example.com', 0.5, 'manual_bank'),
       ('11111111-1111-1111-1111-1111111111a2', 'TEST Host B', 'host.b@example.com', 0.5, 'manual_bank')
on conflict (id) do nothing;

insert into block (name, sort_order) values ('Gribblehurst (test)', 10)
on conflict (name) do nothing;

insert into property (id, host_id, name, address, walk_minutes, active, block_id)
values
  ('22222222-2222-2222-2222-2222222222a1', '11111111-1111-1111-1111-1111111111a1',
   'TEST Gribblehurst anchor', 'Gribblehurst Road, Sandringham, Auckland (test site)', 9, true,
   (select id from block where name = 'Gribblehurst (test)')),
  ('22222222-2222-2222-2222-2222222222a2', '11111111-1111-1111-1111-1111111111a2',
   'TEST Gribblehurst neighbour', 'Gribblehurst Road, Sandringham, Auckland (test site 2)', 9, true,
   (select id from block where name = 'Gribblehurst (test)'))
on conflict (id) do nothing;

update block set anchor_property_id = '22222222-2222-2222-2222-2222222222a1'
 where name = 'Gribblehurst (test)';

-- Offer both sites at the Robbie Williams test event: Site A confirmed,
-- Site B pending (so it only sells at the gate until confirmed).
insert into event_offer (event_id, property_id, status)
values ('ede22026-0000-4000-8000-000000000006', '22222222-2222-2222-2222-2222222222a1', 'confirmed'),
       ('ede22026-0000-4000-8000-000000000006', '22222222-2222-2222-2222-2222222222a2', 'pending')
on conflict (event_id, property_id) do nothing;

-- Arrival windows are copied from the Paice Ave tiers for the same event.
insert into offer_tier (event_offer_id, code, label, price_cents, zone_codes, bay_kind,
                        guarantees_clear_exit, sort_order, active, capacity, gate_reserve,
                        arrival_from, arrival_until, departure_by)
select o.id, v.code, v.label, v.price, '{}'::text[], v.kind, false, v.sort, true, v.cap, v.reserve,
       src.arrival_from, src.arrival_until, src.departure_by
  from event_offer o
  cross join (values
    ('standard', 'Standard — best value, expect to wait for the drive to clear', 4000, 'no_clear_exit', 4, 3, 0),
    ('priority', 'Priority exit — near the road, nobody parked in behind you',   5000, 'free_exit',     2, 2, 1)
  ) as v(code, label, price, kind, sort, cap, reserve)
  join lateral (
    select t.arrival_from, t.arrival_until, t.departure_by
      from offer_tier t join event_offer po on po.id = t.event_offer_id
     where po.event_id = o.event_id and t.code = v.code
       and po.property_id = (select id from property where name = '86 Paice Ave' limit 1)
  ) src on true
 where o.event_id = 'ede22026-0000-4000-8000-000000000006'
   and o.property_id in ('22222222-2222-2222-2222-2222222222a1',
                         '22222222-2222-2222-2222-2222222222a2')
   and not exists (select 1 from offer_tier t where t.event_offer_id = o.id and t.code = v.code);

-- A warden who can see only the Gribblehurst (test) block. Claimed by the first Google
-- sign-in with this address; change it to a real test account to try it.
insert into host_user (host_id, email, role, scope, active)
select h.id, 'warden.test@example.com', 'staff', 'blocks', true
  from host h where h.is_operator
   and not exists (select 1 from host_user where email = 'warden.test@example.com');

insert into staff_block_access (host_user_id, block_id)
select hu.id, b.id from host_user hu, block b
 where hu.email = 'warden.test@example.com' and b.name = 'Gribblehurst (test)'
on conflict do nothing;

-- Positions for the booking page map: Site A stands in for the Gribblehurst
-- anchor, Site B a driveway about 20m along.
update property set lat = -36.880692, lng = 174.742279 where id = '22222222-2222-2222-2222-2222222222a1';
update property set lat = -36.880780, lng = 174.742480 where id = '22222222-2222-2222-2222-2222222222a2';

-- Invented bank details for the warden's Site info tab. The real account
-- is entered on production at release and never written anywhere in this
-- repository.
update bank_transfer_setting
   set account_name = 'TEST Talli', account_number = '00-0000-0000000-00', updated_at = now()
 where id;
