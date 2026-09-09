-- =====================================================================
--  Talli — record that a booking's confirmation email has gone out.
--
--  The webhook claims this column before it calls the mail provider and
--  clears it again if the send fails. That ordering is the whole point:
--  Stripe re-delivers events, and two deliveries racing each other must
--  not produce two emails. A claim that succeeds is the right to send.
--
--  It is deliberately a timestamp rather than a boolean. "When did we
--  tell them" is a question that gets asked when a customer says they
--  never heard from us, and a boolean cannot answer it.
-- =====================================================================

alter table booking
  add column if not exists confirmation_email_sent_at timestamptz;

comment on column booking.confirmation_email_sent_at is
  'When the booking confirmation email was accepted by the mail provider. '
  'Claimed before sending and cleared if the send fails, so it doubles as '
  'the lock that stops a Stripe re-delivery emailing the customer twice. '
  'Null on bookings taken before confirmation emails existed, and on gate '
  'sales, which are confirmed face to face.';

-- Finding the bookings that never got an email is the query that matters
-- when something has gone wrong, and it is always narrow.
create index if not exists booking_awaiting_confirmation_email
  on booking (paid_at)
  where status = 'paid' and confirmation_email_sent_at is null;
