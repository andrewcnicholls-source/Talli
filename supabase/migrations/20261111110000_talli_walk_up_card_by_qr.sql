-- =====================================================================
--  Walk-up card payments by QR code (plan B4)
--
--  A warden has no card terminal and must never need Andrew's Stripe
--  account. So a walk-up who wants to pay by card is saved as owing
--  (the existing 'unpaid' gate sale: status 'held', no hold clock), and
--  gate-ops makes a Stripe Checkout Session for exactly what the booking
--  owes. The screen shows its link as a QR code; the driver pays on their
--  own phone. Nothing about the sale is trusted from the screen.
--
--  This function is the other end: stripe-webhook calls it when that
--  session completes. It is deliberately narrow:
--
--    * Only a booking that still owes, and only for the session that was
--      made for it. A walk-up who gave up and paid cash, or a link that
--      was replaced by a newer one, is not quietly marked paid twice: the
--      webhook is told, and writes a note a person will see.
--    * payment_method becomes 'stripe', because the money is in the
--      Stripe payout and that is where the night is reconciled. channel
--      stays 'gate'. The booking_surcharge trigger re-works the card
--      surcharge from the new method, the same figure gate-ops charged.
--    * A walk-up who gave no email has a gate+… placeholder. Stripe
--      Checkout asks for an email, so the real one replaces the
--      placeholder, and the confirmation email can reach them.
--
--  An expired or abandoned link changes nothing here: the car is parked,
--  so the booking keeps owing, exactly like a pay-later walk-up. The
--  webhook only notes it.
--
--  Additive: one function. Service role only.
-- =====================================================================

create or replace function confirm_gate_card_payment(
  p_booking_id        uuid,
  p_session_id        text,
  p_payment_intent_id text default null,
  p_email             text default null
) returns text
language plpgsql set search_path = public as $$
declare
  b       booking%rowtype;
  v_email text;
begin
  select * into b from booking where id = p_booking_id for update;
  if not found then
    return 'no_booking';
  end if;

  -- Stripe re-delivers. The second delivery finds its own work done.
  if b.status = 'paid' and b.payment_method = 'stripe'
     and b.stripe_checkout_session_id = p_session_id then
    return 'already_paid';
  end if;

  if b.channel <> 'gate' or b.status <> 'held' or b.payment_method <> 'unpaid'
     or b.hold_expires_at is not null
     or b.stripe_checkout_session_id is distinct from p_session_id then
    return 'not_owing';
  end if;

  v_email := lower(nullif(trim(coalesce(p_email, '')), ''));
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    v_email := null;
  end if;

  update booking set
    payment_method = 'stripe',
    status = 'paid',
    paid_at = now(),
    hold_expires_at = null,
    checkout_expires_at = null,
    stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
    customer_email = case
      when v_email is not null and customer_email ~* '^gate\+[0-9a-f]+@talli\.co\.nz$'
        then v_email
      else customer_email end
  where id = b.id;

  insert into booking_change (booking_id, kind, before, after)
  select b.id, 'payment',
         jsonb_build_object('payment_method', 'unpaid', 'status', 'held',
                            'surcharge_cents', b.surcharge_cents),
         jsonb_build_object('payment_method', n.payment_method, 'status', n.status,
                            'surcharge_cents', n.surcharge_cents, 'via', 'card_qr')
    from booking n where n.id = b.id;

  return 'paid';
end;
$$;

comment on function confirm_gate_card_payment(uuid, text, text, text) is
  'Marks an owing walk-up paid when the card-by-QR Checkout Session made for it '
  'completes. Returns paid, already_paid, not_owing or no_booking.';

revoke all on function confirm_gate_card_payment(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function confirm_gate_card_payment(uuid, text, text, text) to service_role;
