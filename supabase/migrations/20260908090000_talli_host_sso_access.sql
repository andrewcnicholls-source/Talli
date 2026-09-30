-- ---------------------------------------------------------------------
--  Talli — who is allowed to open the gate screen
--
--  Until now the answer was "whoever knows the passphrase". One operator,
--  one phone, one shared secret typed in the rain. That works for exactly
--  as long as there is one host.
--
--  Talli is heading somewhere else: other people hosting their own car
--  parks on the platform. A shared secret cannot express that. It cannot
--  say who did something, cannot be taken away from one person without
--  being changed for everyone, and cannot ever be the basis for showing
--  one host their own nights and not somebody else's.
--
--  So access becomes an identity. A person signs in with Google, Supabase
--  Auth vouches for the email, and this table is the only thing that turns
--  that verified email into a host.
--
--  WHAT THIS MIGRATION DOES NOT DO, deliberately:
--
--    * It does not scope data. Every host_user still sees every event,
--      exactly as the passphrase did. Talli has one real host today, and
--      inventing a filter nobody can test against a second host is how you
--      get a filter that is wrong when the second host arrives. The
--      identity is now in the request, which is the part that had to come
--      first; the scoping has a place to hang off when it is wanted.
--
--    * It does not model a platform administrator. `role` below is a role
--      within a host, not above one. A Talli-wide super admin is a
--      different idea and gets its own table when it is real.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
--  host_user — a person who may act for a host
--
--  One row is both the invitation and the link, which is the reason there
--  is no second table. Written with an email and no user_id, it is an
--  invitation: nobody has signed in yet. The first time someone signs in
--  with a Google account carrying that verified email, host_access_for()
--  fills in user_id and the row becomes the link.
--
--  That matters for the very first sign-in. There is no bootstrap admin
--  screen, no console step, no window where the gate screen is open to
--  anyone — the invitation is seeded below, and it is claimed by exactly
--  the person whose email Google confirms.
-- ---------------------------------------------------------------------
create table host_user (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references host(id) on delete cascade,

  -- The invitation, and the key the claim matches on. Compared case-
  -- insensitively via the index below; stored as typed so a person's own
  -- capitalisation survives being shown back to them.
  email       text not null,

  -- Null until first sign-in. ON DELETE SET NULL rather than CASCADE:
  -- deleting the auth user should revoke the session, not silently
  -- withdraw an invitation somebody deliberately granted.
  user_id     uuid unique references auth.users(id) on delete set null,

  -- Within a host, not above one. Both values mean the same thing today —
  -- full access to that host's gate screen — and exist so that the day
  -- "the marshal can check cars in but not change prices" is wanted, there
  -- is somewhere to say it.
  role        text not null default 'host'
              check (role in ('host', 'staff')),

  -- Revoking access without destroying the record of who had it.
  active      boolean not null default true,

  invited_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  last_seen_at timestamptz
);

-- One person, one host row. Also what makes the claim unambiguous: there
-- can never be two invitations competing for the same verified email.
create unique index host_user_email_key on host_user (lower(email));
create index on host_user (host_id);

comment on table host_user is
  'People who may open the gate screen for a host. A row with no user_id is an unclaimed invitation; the first sign-in with that verified email claims it.';
comment on column host_user.email is
  'Matched against the email Supabase Auth verified. Never trusted from a request body.';

-- ---------------------------------------------------------------------
--  RLS: deny all, same as host and booking
--
--  Nothing reads this table from a browser. gate-ops reaches it only
--  through host_access_for() below, under the service role. Enabling RLS
--  with no policy is what makes an accidental grant later still land on a
--  closed door.
-- ---------------------------------------------------------------------
alter table host_user enable row level security;
revoke all on host_user from anon, authenticated;

-- ---------------------------------------------------------------------
--  host_access_for — the only way a verified identity becomes access
--
--  Called by gate-ops once per request, with a user id and an email that
--  came out of Supabase Auth's own /user endpoint. Never with anything a
--  caller typed.
--
--  Three things in one round trip, in this order, because each depends on
--  the last: claim any unclaimed invitation for this email; stamp the
--  visit; return what this person may act as.
--
--  Returns zero rows for someone with a perfectly good Google account and
--  no invitation. That is the intended answer, and gate-ops turns it into
--  a 403.
-- ---------------------------------------------------------------------
create or replace function host_access_for(p_user_id uuid, p_email text)
returns table (
  host_user_id uuid,
  host_id      uuid,
  host_name    text,
  email        text,
  role         text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or coalesce(trim(p_email), '') = '' then
    return;
  end if;

  -- The claim. Guarded on user_id is null so a second person signing in
  -- with a lookalike address can never take over a row already linked,
  -- and on active so a revoked invitation stays revoked.
  update host_user hu
     set user_id    = p_user_id,
         claimed_at = now()
   where hu.user_id is null
     and hu.active
     and lower(hu.email) = lower(trim(p_email));

  update host_user hu
     set last_seen_at = now()
   where hu.user_id = p_user_id
     and hu.active;

  return query
    select hu.id, hu.host_id, h.name, hu.email, hu.role
      from host_user hu
      join host h on h.id = hu.host_id
     where hu.user_id = p_user_id
       and hu.active;
end;
$$;

comment on function host_access_for(uuid, text) is
  'Turns a Supabase-verified identity into host access, claiming an unclaimed invitation for that email on the way. Returns no rows for a signed-in person who is not a host.';

-- Service role only. Nothing here should be reachable from a browser
-- session, even a legitimately signed-in one — the email argument is the
-- whole security boundary, and only the edge function knows it came from
-- Supabase Auth rather than from a text box.
revoke all on function host_access_for(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  The first host
--
--  Andrew is host #1, and the point of this whole change is that he stops
--  being a special case in the code and becomes a row instead. Seeded as
--  an unclaimed invitation against the host that already exists, so the
--  first Google sign-in after this deploys simply works.
--
--  Matched on the host's email rather than its id: both projects were
--  seeded from the same migration, but pinning a literal uuid here would
--  be a promise about data this migration did not write.
-- ---------------------------------------------------------------------
insert into host_user (host_id, email, role)
select h.id, 'andrew.c.nicholls@gmail.com', 'host'
  from host h
 where lower(h.email) = 'andrew.c.nicholls@gmail.com'
 order by h.name
 limit 1
on conflict do nothing;
