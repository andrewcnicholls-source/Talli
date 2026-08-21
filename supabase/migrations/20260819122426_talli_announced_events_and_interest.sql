-- Events people know about long before a price exists. "draft" hides them and
-- "on_sale" sells them; neither says "this is happening, we just aren't ready".
alter table event drop constraint event_status_check;
alter table event add constraint event_status_check
  check (status = any (array['draft','announced','on_sale','closed','cancelled']));

-- The list of people waiting on an event is the asset here. It compounds:
-- every fixture too early to price still leaves you someone to mail the day
-- you open it.
create table if not exists event_interest (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references event(id) on delete cascade,
  email       text not null,
  name        text,
  created_at  timestamptz not null default now(),
  notified_at timestamptz
);

-- One person, one event. Asking twice must not make two rows — and the case
-- of what they typed is not a difference worth keeping.
create unique index if not exists event_interest_once_per_person
  on event_interest (event_id, lower(email));
create index if not exists event_interest_event_idx on event_interest (event_id);

-- Written only by the register-interest function under the service role, and
-- never readable from the browser: it is a list of customer email addresses.
alter table event_interest enable row level security;
grant select on event_interest to service_role;

-- Announced events have to be publicly visible or nothing can express
-- interest in them.
drop policy if exists "public read events on sale" on event;
create policy "public read listed events" on event
  for select to anon, authenticated
  using (status = any (array['announced','on_sale','closed']));

create or replace view v_event_interest as
  select e.id as event_id, e.name, e.starts_at, e.status,
         count(i.id)::int as interested,
         count(i.id) filter (where i.notified_at is null)::int as not_yet_told
    from event e
    left join event_interest i on i.event_id = e.id
   group by e.id, e.name, e.starts_at, e.status;
