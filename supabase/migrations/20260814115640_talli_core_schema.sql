-- Talli Parking — core booking & inventory schema
--
-- A property has ZONES (berm, front lawn, back yard, valet lane). Each zone
-- holds BAYS. Most bays are independent — the car can leave whenever it likes.
-- A bay whose blocks_bay_id is set is a DOUBLE-PARK position: a car there
-- physically prevents one specific other car from leaving, so it can only be
-- sold to someone who commits to going early. A zone with keys_held = true is
-- valet: you shuffle those cars on demand, so nothing parked there constrains
-- anyone at all.
--
-- WHAT ACTUALLY COSTS YOU MONEY: exactly one thing — promising a customer that
-- nobody will be parked in behind them. That means holding the double-park
-- position behind their bay empty, so it costs whatever that position would
-- have sold for, but only on nights you would actually have sold it.

create table host (
  id             uuid primary key default gen_random_uuid(),
  name           text        not null,
  email          text        not null,
  phone          text,
  -- Fraction of each booking Talli retains. 1.0 for Talli's own property,
  -- e.g. 0.20 for a neighbour on an 80/20 split.
  platform_share numeric(5,4) not null default 0.2000
                 check (platform_share >= 0 and platform_share <= 1),
  -- Unused until Stripe Connect.
  stripe_account_id text unique,
  payout_method  text        not null default 'manual_bank'
                 check (payout_method in ('manual_bank','stripe_connect','none')),
  payouts_enabled boolean    not null default false,
  notes          text,
  created_at     timestamptz not null default now()
);

create table property (
  id           uuid primary key default gen_random_uuid(),
  host_id      uuid not null references host(id) on delete restrict,
  name         text not null,
  address      text not null,
  walk_minutes int  check (walk_minutes >= 0),
  access_notes text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index on property (host_id);

create table zone (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references property(id) on delete cascade,
  code        text not null,
  label       text not null,

  -- TRUE = you hold the keys and shuffle on demand. Cars here impose no
  -- constraint on anyone and are never themselves blocked.
  keys_held   boolean not null default false,

  -- FALSE = never allocated to an online booking. For space you don't control
  -- and therefore can't promise — the council berm. Still fully usable as
  -- placement on the night, via the gate channel or reassign_booking().
  reservable_in_advance boolean not null default true,

  -- TRUE = the customer must have opted in before you put them here.
  requires_consent boolean not null default false,
  consent_prompt   text,

  exit_rank   int not null default 1,   -- 1 = quickest out
  exit_note   text,
  active      boolean not null default true,
  unique (property_id, code)
);
create index on zone (property_id);

create table bay (
  id         uuid primary key default gen_random_uuid(),
  zone_id    uuid not null references zone(id) on delete cascade,
  label      text not null,
  -- DOUBLE-PARK LINK. Set = a car here physically prevents the car in
  -- blocks_bay_id from leaving. A nose-to-tail driveway is a chain of these.
  blocks_bay_id uuid references bay(id) on delete set null,
  size_class text not null default 'standard'
             check (size_class in ('compact','standard','large')),
  active     boolean not null default true,
  check (blocks_bay_id is null or blocks_bay_id <> id)
);
create index on bay (zone_id);
create unique index on bay (blocks_bay_id) where blocks_bay_id is not null;

create table event (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  venue           text not null default 'Eden Park',
  starts_at       timestamptz not null,
  gates_open_at   timestamptz,
  expected_end_at timestamptz,
  demand_tier     text not null default 'standard'
                  check (demand_tier in ('low','standard','high','premium')),
  status          text not null default 'draft'
                  check (status in ('draft','on_sale','closed','cancelled')),
  created_at      timestamptz not null default now()
);
create index on event (starts_at);
create index on event (status);

create table event_offer (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references event(id) on delete cascade,
  property_id uuid not null references property(id) on delete cascade,
  notes       text,
  unique (event_id, property_id)
);

create table offer_tier (
  id             uuid primary key default gen_random_uuid(),
  event_offer_id uuid not null references event_offer(id) on delete cascade,
  code           text not null,
  label          text not null,
  price_cents    int  not null check (price_cents > 0),

  -- WHERE this tier may be fulfilled. A LIST, because you sell a promise and
  -- fill it from whatever is free. 'priority' names both the lawn and the
  -- berm; online bookings only ever land on the lawn.
  zone_codes     text[],

  -- clear = ordinary bay · blocking = double-park position · any = either
  bay_kind       text not null default 'clear'
                 check (bay_kind in ('clear','blocking','any')),

  -- THE ONLY SETTING THAT COSTS YOU INVENTORY.
  guarantees_clear_exit boolean not null default false,

  arrival_from   timestamptz not null,
  arrival_until  timestamptz not null,
  departure_by   timestamptz,
  sort_order     int not null default 0,
  active         boolean not null default true,

  unique (event_offer_id, code),
  check (arrival_until > arrival_from),
  check (bay_kind <> 'blocking' or departure_by is not null)
);

create table booking (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references event(id)    on delete restrict,
  property_id    uuid not null references property(id) on delete restrict,
  tier_code      text not null,

  customer_email text not null,
  customer_name  text,
  customer_phone text,
  vehicle_rego   text,
  vehicle_size   text not null default 'standard'
                 check (vehicle_size in ('compact','standard','large')),

  -- Captured by a checkbox at checkout. Without it you may not place this car
  -- in any zone marked requires_consent.
  accepts_street_parking boolean not null default false,

  -- Copied from the tier at purchase so the confirmation, the gate list and
  -- any dispute all agree on what was promised.
  arrival_from   timestamptz,
  arrival_until  timestamptz,
  must_depart_by timestamptz,

  amount_cents   int  not null check (amount_cents >= 0),
  currency       text not null default 'nzd',
  host_earnings_cents int not null default 0,
  platform_fee_cents  int not null default 0,

  channel        text not null default 'online'
                 check (channel in ('online','gate')),
  status         text not null default 'held'
                 check (status in ('held','paid','cancelled','expired','refunded','no_show')),
  hold_expires_at timestamptz,

  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text,

  created_at     timestamptz not null default now(),
  paid_at        timestamptz
);
create index on booking (event_id, status);
create index on booking (status, hold_expires_at) where status = 'held';
create index on booking (customer_email);

-- The inventory engine. unique(event_id, bay_id) makes overselling impossible.
create table bay_allocation (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references event(id)   on delete cascade,
  bay_id     uuid not null references bay(id)     on delete cascade,
  booking_id uuid not null references booking(id) on delete cascade,
  role       text not null default 'occupied'
             check (role in ('occupied','blocked_reserve')),
  created_at timestamptz not null default now(),
  unique (event_id, bay_id)
);
create index on bay_allocation (booking_id);

-- Stripe occasionally delivers the same event twice. Insert here first; a
-- conflict means you already processed it.
create table processed_webhook_event (
  stripe_event_id text primary key,
  type            text not null,
  received_at     timestamptz not null default now()
);
