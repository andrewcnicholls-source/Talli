-- =====================================================================
--  Talli Parking — the site guide and the Locate Us card (plan A4)
--
--  Andrew holds up a "Locate Us" card at the driveway. Scanning it opens
--  a page on the Talli site, /go/<slug>, with the directions and the next
--  events to book; the same card is the warden's Site guide and prints as
--  a sign. This migration is the data behind that:
--
--    1. A slug on every site and every block, one namespace between them,
--       because both are /go/<slug>. A site's defaults to its street
--       number and the first word of the street ("86 Paice Ave" →
--       86paice), short enough to type from a photo of the card. A
--       block's comes from its name. Filled in by a trigger, so add_site()
--       and the block it may create need no change.
--    2. site_picture: the marked-up pictures of where and how to park,
--       several to a site, each with a caption. Public, because the /go/
--       page shows them (Andrew, 14 Nov 2026).
--    3. The site-pictures bucket, public to read, written only by
--       gate-ops with the service role — as event-pictures is.
--    4. set_place_slug(): Andrew changes an address from the Sites page.
--
--  Additive: two columns, one table, one bucket, new functions. Nothing
--  is restated. property.site_guide_url stays, and is still shown.
--
--  A printed card carries the slug, so changing one strands every card
--  printed with the old address. The Sites page says so; nothing here
--  stops it, because a mistyped slug has to be fixable.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Slugs
-- ---------------------------------------------------------------------
alter table property add column if not exists slug text;
alter table block    add column if not exists slug text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'property_slug_format') then
    alter table property add constraint property_slug_format
      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'block_slug_format') then
    alter table block add constraint block_slug_format
      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40);
  end if;
end;
$$;

create unique index if not exists property_slug_key on property (slug);
create unique index if not exists block_slug_key    on block (slug);

comment on column property.slug is
  'The site''s address on the Talli site, /go/<slug>, printed on its Locate Us '
  'card. Shared namespace with block.slug. Plan A4.';
comment on column block.slug is
  'The block''s address on the Talli site, /go/<slug>: the anchor''s directions '
  'and the block''s next events. Shared namespace with property.slug. Plan A4.';

-- Anything to the words of a slug: lower case, letters and digits, single
-- hyphens. Brackets are dropped first, so "Gribblehurst (test)" is
-- gribblehurst.
create or replace function private.slugify(p_text text)
returns text
language sql immutable set search_path = public as $$
  select left(trim(both '-' from regexp_replace(
           lower(regexp_replace(coalesce(p_text, ''), '\(.*?\)', ' ', 'g')),
           '[^a-z0-9]+', '-', 'g')), 40)
$$;

-- A site's starting slug: the number and first word of its street, from
-- the address before the first comma — "86 Paice Ave, Sandringham" is
-- 86paice, "70A Gribblehurst Rd" is 70agribblehurst. An address with no
-- number falls back to its first part, slugified, then to the name.
create or replace function private.site_slug_base(p_address text, p_name text)
returns text
language plpgsql immutable set search_path = public as $$
declare
  v_part text := lower(trim(split_part(coalesce(p_address, ''), ',', 1)));
  m text[];
  v text;
begin
  -- A unit number ("2/86 Paice Ave") is dropped: the card is for the
  -- driveway, and the street number is what is painted on the letterbox.
  m := regexp_match(v_part, '^(?:\d+[a-z]?\s*/\s*)?(\d+[a-z]?)\s+([a-z]+)');
  if m is not null then
    v := m[1] || m[2];
  else
    v := private.slugify(v_part);
  end if;
  v := trim(both '-' from left(v, 36));
  if v = '' then v := private.slugify(p_name); end if;
  if v = '' then v := 'site'; end if;
  return v;
end;
$$;

-- Whether a slug is in use by any site or block other than p_except.
create or replace function private.go_slug_taken(p_slug text, p_except uuid)
returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from property where slug = p_slug and id is distinct from p_except)
      or exists (select 1 from block    where slug = p_slug and id is distinct from p_except)
$$;

-- The first of base, base-2, base-3 … that nothing else holds.
create or replace function private.go_slug_free(p_base text, p_except uuid)
returns text
language plpgsql stable set search_path = public as $$
declare
  v text := p_base;
  n integer := 1;
begin
  while private.go_slug_taken(v, p_except) loop
    n := n + 1;
    v := left(p_base, 36) || '-' || n;
  end loop;
  return v;
end;
$$;

-- Every site and block has a slug: one is made if none is given, and one
-- that is given must be well formed and free across both tables.
create or replace function private.go_slug_fill()
returns trigger
-- Definer, so whoever inserts a site (add_site under the service role, a
-- seed as postgres) reaches the private helpers above without a grant.
language plpgsql security definer set search_path = public as $$
begin
  if new.slug is null or trim(new.slug) = '' then
    new.slug := private.go_slug_free(
      case when tg_table_name = 'property'
           then private.site_slug_base(to_jsonb(new)->>'address', new.name)
           else coalesce(nullif(private.slugify(new.name), ''), 'area') end,
      new.id);
    return new;
  end if;

  new.slug := lower(trim(new.slug));
  if new.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(new.slug) > 40 then
    raise exception 'BAD_SLUG: an address is letters, numbers and single hyphens, up to 40'
      using errcode = 'check_violation';
  end if;
  if private.go_slug_taken(new.slug, new.id) then
    raise exception 'SLUG_TAKEN: another site or area already has /go/%', new.slug
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists property_go_slug on property;
create trigger property_go_slug
  before insert or update of slug on property
  for each row execute function private.go_slug_fill();

drop trigger if exists block_go_slug on block;
create trigger block_go_slug
  before insert or update of slug on block
  for each row execute function private.go_slug_fill();

-- Existing rows, oldest first, so the first site on a street keeps the
-- plain address and a later one gets -2.
do $$
declare r record;
begin
  for r in select id from property where slug is null order by created_at, id loop
    update property set slug = null where id = r.id;
  end loop;
  for r in select id from block where slug is null order by sort_order, created_at, id loop
    update block set slug = null where id = r.id;
  end loop;
end;
$$;

alter table property alter column slug set not null;
alter table block    alter column slug set not null;

revoke all on function private.slugify(text) from public, anon, authenticated;
revoke all on function private.site_slug_base(text, text) from public, anon, authenticated;
revoke all on function private.go_slug_taken(text, uuid) from public, anon, authenticated;
revoke all on function private.go_slug_free(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  2. Pictures of where and how to park
-- ---------------------------------------------------------------------
create table if not exists site_picture (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references property(id) on delete cascade,
  -- The path within the site-pictures bucket, never a full address: the
  -- host differs between projects, and a page builds it from its own.
  path        text not null check (path ~ '^site/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  caption     text check (caption is null or length(caption) <= 200),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists site_picture_property_idx on site_picture (property_id, sort_order);

comment on table site_picture is
  'Marked-up pictures of where and how to park at a site, with captions, in '
  'order. Shown on the warden''s Site guide and on the public /go/ page. '
  'Written only by gate-ops. Plan A4.';

alter table site_picture enable row level security;
drop policy if exists "public read pictures of active sites" on site_picture;
create policy "public read pictures of active sites" on site_picture
  for select to anon, authenticated
  using (exists (select 1 from property p where p.id = site_picture.property_id and p.active));
grant select on site_picture to anon, authenticated;
grant all on site_picture to service_role;

-- ---------------------------------------------------------------------
--  3. The bucket. Public to read, because the pictures are on a public
--     page; written only by gate-ops with the service role, so no storage
--     policy grants a browser anything. Skipped where storage is not
--     installed.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('site-pictures', 'site-pictures', true, 5242880,
            array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = true,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
--  4. Changing an address, from the Sites page
-- ---------------------------------------------------------------------
create or replace function public.set_place_slug(p_kind text, p_id uuid, p_slug text)
returns text
language plpgsql set search_path = public as $$
declare
  v text := nullif(lower(trim(coalesce(p_slug, ''))), '');
  v_out text;
begin
  if v is null then
    raise exception 'BAD_SLUG: an address is needed' using errcode = 'check_violation';
  end if;
  if p_kind = 'site' then
    update property set slug = v where id = p_id returning slug into v_out;
  elsif p_kind = 'block' then
    update block set slug = v where id = p_id returning slug into v_out;
  else
    raise exception 'BAD_KIND: a site or an area' using errcode = 'check_violation';
  end if;
  if v_out is null then
    raise exception 'NOT_FOUND: nothing to give that address to' using errcode = 'no_data_found';
  end if;
  return v_out;
end;
$$;

revoke all on function public.set_place_slug(text, uuid, text) from public, anon, authenticated;
grant execute on function public.set_place_slug(text, uuid, text) to service_role;
