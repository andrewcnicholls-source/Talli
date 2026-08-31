-- =====================================================================
--  Talli Parking — the card surcharge goes to 4%
--
--  2% never covered the cost of the card. Stripe's New Zealand fee is a
--  percentage PLUS a fixed 30c, and on the sort of money a driveway
--  takes the fixed part dominates: a $20 space billed at $20.40 costs
--  84c to accept online, of which 2% recovered 40c. The night was
--  quietly paying about 44c a car to be paid by card.
--
--  4% is not the break-even figure — at $20 that is about 4.26%, at $10
--  about 5.8%, at $40 about 3.5%, because no single percentage can
--  recover a fixed fee. It is the round number that covers most of it
--  without a second column and a second sum on every screen.
--
--  Nothing here re-prices a booking that has already been taken. The
--  trigger fires on amount_cents, addons_cents and payment_method, so a
--  sale made at 2% keeps the 2% it was charged.
-- =====================================================================

update payment_setting set card_surcharge_bps = 400, updated_at = now();

-- The default matters for a project built from these migrations rather
-- than restored from a dump: a fresh row should start where the live one
-- is, not where it started in August.
alter table payment_setting
  alter column card_surcharge_bps set default 400;

comment on column payment_setting.card_surcharge_bps is
  'Card surcharge in basis points. 400 = 4.00%. Applies to stripe and tap_to_pay only. Never displayed as a percentage — every screen shows the dollar amount only.';
