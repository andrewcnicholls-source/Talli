-- =====================================================================
--  Event series (plan A1).
--
--  A series is what a customer looks for: "Bruno Mars", "Auckland". A
--  night is one event in it: "Second show", "v Bay of Plenty". For sport
--  the series is the team. The series' slug is the address its page will
--  have (plan A2), so once made it does not change when the name does.
--
--    * event_series is public, active rows only, like the event list.
--      Writes go through gate-ops (Andrew only), with the service role.
--    * Every event belongs to a series. A new event that names none is
--      put in one by its name (event_series_parts below), so nothing that
--      makes events — create_gate_event, the test seeds, a hand-written
--      insert — has to know about series. Andrew moves it on the screen
--      if the guess is wrong.
--    * Pictures live in the public `event-pictures` bucket. A night may
--      have its own; otherwise it shows the series'. The row holds the
--      path within the bucket, never a full address, so it means the same
--      on test and production: a page puts its own Supabase URL in front
--      (`/storage/v1/object/public/event-pictures/<path>`).
--
--  Additive: no existing column, function or view is restated.
-- =====================================================================

create table if not exists event_series (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique
              check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name        text not null check (length(trim(name)) between 1 and 120),
  kind        text not null default 'concert'
              check (kind in ('concert', 'sport', 'other')),
  venue       text not null default 'Eden Park',
  summary     text check (summary is null or length(summary) <= 600),
  picture_path text,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- One series per name, whatever the case: "find or make" depends on it.
create unique index if not exists event_series_name_key on event_series (lower(name));

comment on table event_series is
  'What a customer looks for: an act, a tour, a team. Each event is one '
  'night of a series. The slug is the series page address (plan A2).';

alter table event_series enable row level security;
revoke all on event_series from public, anon, authenticated;
grant select on event_series to anon, authenticated;
grant all on event_series to service_role;

drop policy if exists "public read active series" on event_series;
create policy "public read active series" on event_series
  for select to anon, authenticated
  using (active);

alter table event add column if not exists series_id uuid references event_series(id);
alter table event add column if not exists night_label text
  check (night_label is null or length(trim(night_label)) between 1 and 80);
alter table event add column if not exists picture_path text;
create index if not exists event_series_id_idx on event (series_id);

-- ---------------------------------------------------------------------
--  Which series a name belongs to, and what the night is called.
--
--    "Auckland v Bay of Plenty"                    → Auckland, sport,
--                                                    "v Bay of Plenty"
--    "Bruno Mars (The Romantic Tour, second show)" → Bruno Mars,
--                                                    "Second show"
--    "Bruno Mars - Night 3"                        → Bruno Mars,
--                                                    "Night 3"
--
--  The test project's "TEST" prefix (the word, then a dash) stays with the
--  series, so a test series reads as one.
--  Immutable and side-effect free: the guess is easy to test, and wrong
--  guesses are corrected on the screen, not here.
-- ---------------------------------------------------------------------
create or replace function event_series_parts(p_name text,
  out series_name text, out kind text, out night_label text)
language plpgsql immutable
set search_path = public
as $$
declare
  n    text := regexp_replace(trim(coalesce(p_name, '')), '\s+[-–—]\s+', ' — ', 'g');
  pre  text := '';
  head text;
  m    text[];
begin
  if n ~ '^TEST\s—\s' then
    pre := substr(n, 1, 7);
    n := substr(n, 8);
  end if;
  kind := case when n ~* '\s(v|vs)\.?\s' then 'sport' else 'concert' end;
  head := trim(split_part(n, ' (', 1));

  -- Sport, with the team first: the series is the team.
  m := regexp_match(head, '^(.+?)\s+(v|vs)\.?\s+(.+)$', 'i');
  if m is not null then
    series_name := pre || trim(m[1]);
    night_label := 'v ' || trim(regexp_replace(n, '^.+?\s+(v|vs)\.?\s+', '', 'i'));
    return;
  end if;

  -- "… — Night 3"
  m := regexp_match(head, '^(.+?) — (night\s*\d+)$', 'i');
  if m is not null then
    series_name := pre || trim(m[1]);
    night_label := initcap(m[2]);
    return;
  end if;

  -- "Act (Tour, second show)": the night is the last part in brackets.
  m := regexp_match(n, '^.+?\((.+)\)\s*$');
  if m is not null then
    series_name := pre || head;
    night_label := trim(regexp_replace(m[1], '^.*,\s*', ''));
    night_label := upper(left(night_label, 1)) || substr(night_label, 2);
    return;
  end if;

  series_name := pre || n;
  night_label := null;
end;
$$;

-- A slug from a name, unique among series.
create or replace function event_series_slug(p_name text, p_except uuid default null)
returns text
language plpgsql stable
set search_path = public
as $$
declare
  base text := left(trim(both '-' from
                 regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')), 70);
  v_slug text;
  n    integer := 1;
begin
  base := trim(both '-' from base);
  if base = '' then base := 'series'; end if;
  v_slug := base;
  while exists (select 1 from event_series s
                 where s.slug = v_slug
                   and s.id is distinct from p_except) loop
    n := n + 1;
    v_slug := base || '-' || n;
  end loop;
  return v_slug;
end;
$$;

-- The series an event of this name belongs to, made if there is none.
create or replace function ensure_event_series(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  p   record;
  sid uuid;
begin
  select * into p from event_series_parts(p_name);
  select id into sid from event_series where lower(name) = lower(p.series_name);
  if sid is not null then return sid; end if;
  insert into event_series (slug, name, kind)
  values (event_series_slug(p.series_name), p.series_name, p.kind)
  on conflict ((lower(name))) do nothing
  returning id into sid;
  if sid is null then
    select id into sid from event_series where lower(name) = lower(p.series_name);
  end if;
  return sid;
end;
$$;

revoke all on function ensure_event_series(text) from public, anon, authenticated;
grant execute on function ensure_event_series(text) to service_role;

-- Every new event lands in a series. One that names its own keeps it.
create or replace function event_series_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.series_id is null then
    new.series_id := ensure_event_series(new.name);
    if new.night_label is null then
      new.night_label := (event_series_parts(new.name)).night_label;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists event_series_default on event;
create trigger event_series_default
  before insert on event
  for each row execute function event_series_default();

-- Backfill, oldest night first.
do $$
declare
  e record;
begin
  for e in select id, name from event where series_id is null order by starts_at, id loop
    update event
       set series_id = ensure_event_series(e.name),
           night_label = coalesce(night_label, (event_series_parts(e.name)).night_label)
     where id = e.id;
  end loop;
end;
$$;

alter table event alter column series_id set not null;

-- ---------------------------------------------------------------------
--  Writing a series: what gate-ops calls for Andrew. Named errors, so the
--  screen can say what was wrong.
-- ---------------------------------------------------------------------
create or replace function save_event_series(
  p_id uuid, p_name text, p_kind text, p_venue text, p_summary text,
  p_sort_order integer, p_active boolean, p_slug text default null)
returns event_series
language plpgsql
security definer
set search_path = public
as $$
declare
  s     event_series;
  nm    text := trim(coalesce(p_name, ''));
  v_slug text := nullif(trim(lower(coalesce(p_slug, ''))), '');
begin
  if nm = '' then raise exception 'SERIES_NAME_REQUIRED: a series needs a name'; end if;
  if coalesce(p_kind, 'concert') not in ('concert', 'sport', 'other') then
    raise exception 'BAD_KIND: kind is concert, sport or other';
  end if;
  if exists (select 1 from event_series x
              where lower(x.name) = lower(nm) and x.id is distinct from p_id) then
    raise exception 'SERIES_NAME_TAKEN: there is already a series called %', nm;
  end if;
  if v_slug is not null and v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'BAD_SLUG: lower-case letters, numbers and single dashes only';
  end if;
  if v_slug is not null and exists (select 1 from event_series x
                                   where x.slug = v_slug
                                     and x.id is distinct from p_id) then
    raise exception 'SLUG_TAKEN: another series has the address %', v_slug;
  end if;

  if p_id is null then
    insert into event_series (slug, name, kind, venue, summary, sort_order, active)
    values (coalesce(v_slug, event_series_slug(nm)), nm, coalesce(p_kind, 'concert'),
            coalesce(nullif(trim(p_venue), ''), 'Eden Park'), nullif(trim(p_summary), ''),
            coalesce(p_sort_order, 0), coalesce(p_active, true))
    returning * into s;
  else
    update event_series x
       set name = nm,
           -- The address stays put through a rename; it changes only when
           -- asked, because a printed link may already point at it.
           slug = coalesce(v_slug, x.slug),
           kind = coalesce(p_kind, x.kind),
           venue = coalesce(nullif(trim(p_venue), ''), x.venue),
           summary = nullif(trim(p_summary), ''),
           sort_order = coalesce(p_sort_order, x.sort_order),
           active = coalesce(p_active, x.active)
     where x.id = p_id
    returning * into s;
    if s.id is null then raise exception 'NO_SUCH_SERIES: that series does not exist'; end if;
  end if;
  return s;
end;
$$;

revoke all on function save_event_series(uuid, text, text, text, text, integer, boolean, text)
  from public, anon, authenticated;
grant execute on function save_event_series(uuid, text, text, text, text, integer, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------
--  Pictures. Public to read, because they are on public pages; written
--  only by gate-ops with the service role, so no storage policy grants a
--  browser anything. Skipped where storage is not installed.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('event-pictures', 'event-pictures', true, 5242880,
            array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = true,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
