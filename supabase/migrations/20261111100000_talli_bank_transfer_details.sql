-- =====================================================================
--  Bank details a warden shows a walk-up who pays by transfer.
--
--  A warden working a block alone has no terminal, so a walk-up who has
--  no cash pays by bank transfer. The warden's Site info tab shows the
--  account to pay into. The details are not secret to the driver in front
--  of the warden, but they are not for the open web either:
--
--    * Not on payment_setting. That table is readable with the anon key
--      on purpose, because the booking page reads the card surcharge
--      from it.
--    * No policy and no grant to anon or authenticated, so PostgREST
--      serves nothing from it. Only gate-ops reads it, with the service
--      role, and only for a signed-in host or warden.
--    * Never in this repository and never in assets/talli-config.js.
--      The row starts empty. The real values are set by SQL at release;
--      an edit screen comes with the Sites page (plan B3).
--
--  One row, like payment_setting: `id` can only ever be true.
-- =====================================================================

create table if not exists bank_transfer_setting (
  id             boolean primary key default true check (id),
  account_name   text check (account_name is null or length(trim(account_name)) between 1 and 60),
  -- A New Zealand account number: bank, branch, account, suffix.
  account_number text check (account_number is null or
                             account_number ~ '^[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}$'),
  updated_at     timestamptz not null default now()
);

comment on table bank_transfer_setting is
  'The account walk-ups pay into by bank transfer. One row. Read only by '
  'gate-ops for a signed-in host or warden; never readable with the anon key.';

insert into bank_transfer_setting (id) values (true) on conflict (id) do nothing;

alter table bank_transfer_setting enable row level security;
revoke all on bank_transfer_setting from public, anon, authenticated;
grant all on bank_transfer_setting to service_role;
