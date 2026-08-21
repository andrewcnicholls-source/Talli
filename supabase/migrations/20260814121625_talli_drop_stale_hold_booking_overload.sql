-- The 11-argument hold_booking (with p_payment_method) supersedes the
-- 10-argument one. Postgres keeps both as overloads, which is dangerous here:
-- the old signature ignores the walk-up reserve and the online cutoff, so a
-- caller passing 10 arguments would silently oversell. Drop it.
drop function if exists hold_booking(uuid, uuid, text, text, text, text, text, int, text, boolean);
