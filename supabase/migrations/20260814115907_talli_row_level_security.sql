-- Row Level Security.
--
-- The anon/publishable key ships inside your website, so treat it as public.
-- Rule: the CATALOGUE is world-readable (that is what the booking page needs),
-- and everything containing a person is unreachable without the service role
-- key, which only ever lives server-side in an Edge Function.
--
-- RLS with no policy = deny all. That is deliberate for host and booking.

alter table host                    enable row level security;
alter table property                enable row level security;
alter table zone                    enable row level security;
alter table bay                     enable row level security;
alter table event                   enable row level security;
alter table event_offer             enable row level security;
alter table offer_tier              enable row level security;
alter table booking                 enable row level security;
alter table bay_allocation          enable row level security;
alter table processed_webhook_event enable row level security;

-- ---- Public catalogue: what the booking page legitimately needs to render.

create policy "public read active properties" on property
  for select to anon, authenticated using (active);

create policy "public read active zones" on zone
  for select to anon, authenticated using (active);

create policy "public read active bays" on bay
  for select to anon, authenticated using (active);

-- Draft events stay hidden until you put them on sale.
create policy "public read events on sale" on event
  for select to anon, authenticated using (status in ('on_sale','closed'));

create policy "public read offers" on event_offer
  for select to anon, authenticated using (true);

create policy "public read active tiers" on offer_tier
  for select to anon, authenticated using (active);

-- Needed for availability. Contains no personal data — just which bay is taken
-- for which event, which is exactly what the availability display shows.
create policy "public read allocations" on bay_allocation
  for select to anon, authenticated using (true);

-- ---- No policies at all on host, booking and processed_webhook_event.
--      Names, emails, phone numbers, vehicle regos and Stripe identifiers are
--      reachable only with the service role key.

-- ---- Functions.
-- Everything that mutates is server-side only. hold_booking would fail on the
-- booking insert anyway under RLS, but revoking is clearer than relying on it.

revoke execute on function hold_booking(uuid, uuid, text, text, text, text, text, int, text, boolean) from public, anon, authenticated;
revoke execute on function reassign_booking(uuid, uuid)      from public, anon, authenticated;
revoke execute on function release_booking(uuid, text)       from public, anon, authenticated;
revoke execute on function confirm_booking(uuid, text)       from public, anon, authenticated;
revoke execute on function expire_stale_holds()              from public, anon, authenticated;

-- Read-only and harmless: it returns a price, not a person.
grant execute on function upgrade_cost_cents(uuid, uuid, text) to anon, authenticated;
