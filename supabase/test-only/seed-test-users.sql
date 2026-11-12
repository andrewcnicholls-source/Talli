-- =====================================================================
--  TEST ONLY — the people the automated tests sign in as.
--
--  Loaded into the local stack by `supabase start` (see config.toml),
--  and run by hand against the test project so that "sign in as a test
--  user" works on staging. NEVER run against production: production is
--  Google sign-in only, its email-and-password provider is switched off,
--  and `scripts/check.sh` fails if any of these addresses turns up in a
--  migration.
--
--  Why passwords and not a bypass: gate-ops must do for these sessions
--  exactly what it does for a Google one — resolve the token with the
--  auth server, require a confirmed email, look the email up in
--  host_user. A password session is a real session, so the three checks
--  are exercised rather than skipped. There is no test switch in any
--  server code.
--
--  THE PASSWORD IS NOT IN THIS FILE. It is read from the setting
--  `talli.test_password`, and the script stops if that is not set:
--
--    * Local stack: local-stack-password.sql sets it, first.
--    * Test project: Andrew sets it in the SQL Editor, in the same run,
--      with a password he chooses and keeps (DEPLOYMENT.md § 0c):
--
--          select set_config('talli.test_password', '<choose one>', false);
--          -- then the whole of this file
--
--      Running it again with a different password changes it for every
--      test account. The local stack's password is refused here unless
--      the local-stack marker is set too, so it cannot end up on staging
--      by copying the wrong file.
--
--      operator.test@example.com         scope all, on the operator host
--      warden.test@example.com           scope blocks: Gribblehurst (test)
--                                        (row comes from seed-test-block.sql;
--                                        left unclaimed so the first sign-in
--                                        exercises the claim)
--      warden.paice.test@example.com     scope blocks: Paice Ave
--      warden.nogrants.test@example.com  scope blocks, every grant off
--      outsider.test@example.com         signed in, not a host at all
--
--  Re-runnable. Needs seed-test-block.sql first (the Gribblehurst block).
-- =====================================================================

-- ---- The password, from the session — never from this file.
do $$
declare pw text := coalesce(current_setting('talli.test_password', true), '');
begin
  if length(pw) < 12 then
    raise exception 'TEST_PASSWORD_REQUIRED: run select set_config(''talli.test_password'', ''<at least 12 characters>'', false); first, in the same run';
  end if;
  if pw = 'talli-test-only' and coalesce(current_setting('talli.local_stack', true), '') <> 'on' then
    raise exception 'LOCAL_PASSWORD_REFUSED: that is the local stack''s published password; choose your own for this project';
  end if;
end $$;

-- ---- Supabase Auth users, confirmed, with the email provider identity.
with people(id, email) as (values
  ('7e570000-0000-4000-8000-000000000001'::uuid, 'operator.test@example.com'),
  ('7e570000-0000-4000-8000-000000000002'::uuid, 'warden.test@example.com'),
  ('7e570000-0000-4000-8000-000000000003'::uuid, 'warden.paice.test@example.com'),
  ('7e570000-0000-4000-8000-000000000004'::uuid, 'warden.nogrants.test@example.com'),
  ('7e570000-0000-4000-8000-000000000005'::uuid, 'outsider.test@example.com')
)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select '00000000-0000-0000-0000-000000000000', p.id, 'authenticated', 'authenticated', p.email,
       extensions.crypt(current_setting('talli.test_password'), extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
       '', '', '', '', '', '', '', ''
  from people p
 where not exists (select 1 from auth.users u where u.id = p.id or lower(u.email) = p.email);

-- Re-running with a new password changes it.
update auth.users
   set encrypted_password = extensions.crypt(current_setting('talli.test_password'), extensions.gen_salt('bf')),
       updated_at = now()
 where id between '7e570000-0000-4000-8000-000000000001' and '7e570000-0000-4000-8000-000000000005';

insert into auth.identities (id, provider_id, user_id, identity_data, provider,
                             last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), now(), now()
  from auth.users u
 where u.id between '7e570000-0000-4000-8000-000000000001' and '7e570000-0000-4000-8000-000000000005'
   and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- ---- Who each of them is on the gate screen. Invitations, claimed on
--      first sign-in exactly as a Google account's would be.
insert into host_user (host_id, email, role, scope, active)
select h.id, v.email, v.role, v.scope, true
  from host h
  cross join (values
    ('operator.test@example.com',        'host',  'all'),
    ('warden.paice.test@example.com',    'staff', 'blocks'),
    ('warden.nogrants.test@example.com', 'staff', 'blocks')
  ) as v(email, role, scope)
 where h.is_operator
   and not exists (select 1 from host_user hu where lower(hu.email) = v.email);

insert into staff_block_access (host_user_id, block_id, active)
select hu.id, b.id, true from host_user hu, block b
 where hu.email = 'warden.paice.test@example.com' and b.name = 'Paice Ave'
on conflict do nothing;

-- A warden whose only grant is switched off: refused NO_BLOCKS, never
-- widened to everything.
insert into staff_block_access (host_user_id, block_id, active)
select hu.id, b.id, false from host_user hu, block b
 where hu.email = 'warden.nogrants.test@example.com' and b.name = 'Gribblehurst (test)'
on conflict (host_user_id, block_id) do update set active = false;
