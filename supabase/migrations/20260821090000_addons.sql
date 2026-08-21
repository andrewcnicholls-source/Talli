-- =====================================================================
--  Talli Parking — pre-purchased extras
--
--  Ponchos, earplugs and lolly bags used to be a cash conversation in the
--  driveway. This lets someone add them while they are already paying, so
--  the gate hands over a bag instead of taking money in the rain.
--
--  Two prices per item, because the signage already works that way:
--  a unit price, and an optional "n for $x" bundle. addon_price_cents is
--  the one place that arithmetic lives.
-- =====================================================================

create table if not exists addon (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  blurb              text,
  image_path         text,
  price_cents        integer not null check (price_cents > 0),
  bundle_qty         integer check (bundle_qty > 1),
  bundle_price_cents integer check (bundle_price_cents > 0),
  max_qty            integer not null default 10 check (max_qty > 0),
  sort_order         integer not null default 0,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  -- A bundle needs both halves or neither.
  constraint addon_bundle_is_whole
    check ((bundle_qty is null) = (bundle_price_cents is null))
);

comment on column addon.bundle_qty is
  'Multi-buy break, e.g. 2 for $5. Null means the unit price always applies.';
comment on column addon.max_qty is
  'Most one booking may pre-purchase. Keeps a fat-fingered stepper from ordering 400 ponchos.';

-- Bundles first, remainder at the unit price — and never more than buying
-- singles would have cost, so a badly-entered bundle can't overcharge.
create or replace function addon_price_cents(
  p_unit_cents   integer,
  p_bundle_qty   integer,
  p_bundle_cents integer,
  p_qty          integer
) returns integer
language sql immutable
as $$
  select case
    when coalesce(p_qty, 0) <= 0 then 0
    when p_bundle_qty is null or p_bundle_cents is null then p_unit_cents * p_qty
    else least(
      p_unit_cents * p_qty,
      (p_qty / p_bundle_qty) * p_bundle_cents + (p_qty % p_bundle_qty) * p_unit_cents
    )
  end::integer;
$$;

-- What a booking bought. Name and price are snapshotted: the catalogue may
-- be re-priced next week, but this receipt should not move.
create table if not exists booking_addon (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references booking(id) on delete cascade,
  addon_id          uuid references addon(id),
  code              text not null,
  name              text not null,
  qty               integer not null check (qty > 0),
  unit_price_cents  integer not null check (unit_price_cents >= 0),
  amount_cents      integer not null check (amount_cents >= 0),
  channel           text not null default 'online'
                      check (channel in ('online', 'gate')),
  handed_over_at    timestamptz,
  created_at        timestamptz not null default now(),
  unique (booking_id, code)
);

create index if not exists booking_addon_booking_idx on booking_addon (booking_id);

-- Kept beside amount_cents rather than folded into it: amount_cents is the
-- parking, and the platform share is calculated on the parking alone. The
-- ponchos are the host's own stock.
alter table booking
  add column if not exists addons_cents integer not null default 0
    check (addons_cents >= 0);

comment on column booking.addons_cents is
  'Pre-purchased extras total. Separate from amount_cents: no platform share is taken on stock the host bought.';

alter table addon         enable row level security;
alter table booking_addon enable row level security;

-- The catalogue is a shop window; the order lines are not. booking_addon
-- gets no public policy at all, exactly like booking.
drop policy if exists "public read active addons" on addon;
create policy "public read active addons"
  on addon for select to anon, authenticated using (active);

insert into addon (code, name, blurb, image_path, price_cents, bundle_qty, bundle_price_cents, max_qty, sort_order)
values
  ('poncho_adult', 'Lightweight poncho (adult)',
   'Eden Park in the rain, solved. One size, fits over a jacket.',
   'assets/poncho.jpg', 500, null, null, 8, 1),
  ('poncho_child', 'Child poncho',
   'Same idea, smaller. Sized for kids up to about ten.',
   'assets/child-poncho.jpg', 500, null, null, 8, 2),
  ('earplugs', 'Ear plugs',
   'Foam pairs. Worth it anywhere near the drums.',
   'assets/earplugs.jpg', 300, 2, 500, 10, 3),
  ('lollies', 'Pick & mix lolly bag',
   'A decent handful. Keeps small people going through the second half.',
   'assets/lollies.jpg', 300, 2, 500, 10, 4)
on conflict (code) do nothing;
