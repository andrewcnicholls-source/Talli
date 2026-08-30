-- =====================================================================
--  Talli Parking — the card surcharge
--
--  Card payments cost money to accept; cash does not. So the price on the
--  sign in the driveway is the CASH price, and paying by card adds a
--  percentage on top. That is the rule this migration encodes, and it has
--  three consequences worth stating plainly:
--
--    * offer_tier.price_cents does not change meaning. It is still what
--      the card in the driveway says, and re-pricing on the night still
--      types that number and nothing else.
--    * booking.surcharge_cents is a THIRD money column, beside
--      amount_cents and addons_cents. It is not host earnings and not the
--      platform's share — it is the cost of taking the card, passed on —
--      so folding it into either would misstate both.
--    * The surcharge follows the payment method, not the channel.
--      'stripe' (the website) and 'tap_to_pay' (the terminal in the
--      driveway) attract it. Cash, bank transfer, free and other do not.
--
--  Nothing here re-prices a booking that has already been taken. A price
--  moving on the sign never reaches a sold space, and neither does a
--  change to the rate below.
-- =====================================================================

-- ---------------------------------------------------------------------
--  The rate, in one row, readable by the booking page.
--
--  It has to be public: the surcharge is itemised at checkout before
--  anyone commits, which means the browser needs the number to show it.
--  A percentage is not personal data and this row holds nothing else.
--
--  Basis points, not a percentage, because 2.5% in a numeric column
--  invites rounding arguments and 250 does not.
-- ---------------------------------------------------------------------
create table if not exists payment_setting (
  -- One row, and the type enforces it: `id` can only ever be true.
  id                 boolean primary key default true check (id),
  card_surcharge_bps integer not null default 200
                     check (card_surcharge_bps >= 0 and card_surcharge_bps <= 1000),
  updated_at         timestamptz not null default now()
);

comment on table payment_setting is
  'Payment settings that the booking page must be able to read. One row.';
comment on column payment_setting.card_surcharge_bps is
  'Card surcharge in basis points. 200 = 2.00%. Applies to stripe and tap_to_pay only.';

insert into payment_setting (id) values (true) on conflict (id) do nothing;

alter table payment_setting enable row level security;

drop policy if exists "public read payment settings" on payment_setting;
create policy "public read payment settings" on payment_setting
  for select to anon, authenticated using (true);

-- The blanket revoke in the explicit-grants migration does not reach a
-- table created after it, but say the grant out loud anyway: a policy
-- without a grant is a table nobody can read.
grant select on payment_setting to anon, authenticated;

-- ---------------------------------------------------------------------
--  What each booking was surcharged.
-- ---------------------------------------------------------------------
alter table booking
  add column if not exists surcharge_cents integer not null default 0
    check (surcharge_cents >= 0);

comment on column booking.surcharge_cents is
  'Card surcharge charged on top of amount_cents + addons_cents. Zero for cash. Not host earnings and not platform fee.';

-- ---------------------------------------------------------------------
--  The arithmetic, in one place.
--
--  Both functions are read-only and return a number rather than anything
--  about a person, so the booking page may call them — same reasoning as
--  upgrade_cost_cents().
-- ---------------------------------------------------------------------
create or replace function card_surcharge_bps() returns integer
language sql stable
set search_path to 'public'
as $function$
  select coalesce((select s.card_surcharge_bps from payment_setting s where s.id), 0);
$function$;

create or replace function card_surcharge_cents(
  p_base_cents     integer,
  p_payment_method text
) returns integer
language sql stable
set search_path to 'public'
as $function$
  select case
           when p_payment_method in ('stripe', 'tap_to_pay')
             then round(greatest(coalesce(p_base_cents, 0), 0)::numeric
                        * card_surcharge_bps() / 10000.0)::integer
           else 0
         end;
$function$;

grant execute on function card_surcharge_bps() to anon, authenticated;
grant execute on function card_surcharge_cents(integer, text) to anon, authenticated;

-- ---------------------------------------------------------------------
--  Kept right by a trigger, not by every caller remembering.
--
--  hold_booking() writes amount_cents; add_booking_addons() writes
--  addons_cents afterwards; the gate sells and then adds extras across
--  the bonnet. Each of those is a separate statement, and a surcharge
--  computed by the caller would be stale after the next one. A trigger on
--  the three columns the surcharge depends on cannot be stale, and cannot
--  be forgotten by whatever writes a booking next.
--
--  It fires only when one of those columns is in the UPDATE's SET list,
--  so confirming, checking in, cancelling and refunding all leave the
--  settled figure exactly as it was.
-- ---------------------------------------------------------------------
create or replace function booking_set_surcharge() returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.surcharge_cents := card_surcharge_cents(
    coalesce(new.amount_cents, 0) + coalesce(new.addons_cents, 0),
    new.payment_method);
  return new;
end;
$function$;

drop trigger if exists booking_surcharge on booking;
create trigger booking_surcharge
  before insert or update of amount_cents, addons_cents, payment_method
  on booking
  for each row execute function booking_set_surcharge();

-- ---------------------------------------------------------------------
--  v_gate_list is deliberately NOT touched here.
--
--  It would be the obvious place to expose surcharge_cents, and it is the
--  wrong one. create or replace view has to restate every column, so a
--  migration written against this repo's copy of the view silently drops
--  any column added by work that has not merged yet — and the test project
--  is routinely a branch or two ahead of staging. The gate function reads
--  the figure from booking instead, which no amount of drift can break.
-- ---------------------------------------------------------------------
