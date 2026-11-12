-- =====================================================================
--  LOCAL STACK ONLY — the password the automated tests sign in with.
--
--  Loaded first by `supabase start` / `supabase db reset` on a developer's
--  machine or a CI runner (supabase/config.toml), so seed-test-users.sql
--  has a password to give its accounts. That stack exists only on the
--  machine running the tests, so a password written here protects nothing
--  and needs to protect nothing.
--
--  NEVER run this against a hosted project. On talli-test the accounts get
--  a password Andrew chooses, typed into the SQL Editor and written down
--  nowhere in this repository (DEPLOYMENT.md § 0c). seed-test-users.sql
--  refuses the password below unless `talli.local_stack` is also set,
--  which only this file does.
-- =====================================================================
-- Session settings: the seed files after this one run on the same
-- connection, and nothing about them outlives it.
select set_config('talli.local_stack', 'on', false),
       set_config('talli.test_password', 'talli-test-only', false);

