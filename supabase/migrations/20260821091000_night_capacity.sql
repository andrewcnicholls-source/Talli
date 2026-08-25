-- =====================================================================
--  Talli Parking — capacity that moves during the night
--
--  The yard on paper is not the yard at 6:40pm. A low car can't take the
--  ramp, someone parks badly and the spot beside them is gone, the
--  neighbour waves you onto their berm. Every event so far has ended a
--  space or two down on the plan.
--
--  So capacity becomes a per-event thing:
--    * "lost"  — a real bay taken out of play for tonight only.
--    * "open"  — a spare (flex) bay switched on for tonight only.
--
--  Both are per event, never destructive, and always reversible. The
--  availability views read through event_bay_status, so a space marked
--  lost stops being sellable online within seconds of the tap.
-- =====================================================================

-- Spare positions that only exist when someone says they do. Dormant by
-- default, so the yard on paper stays honest.
alter table bay
  add column if not exists is_flex boolean not null default false;

comment on column bay.is_flex is
  'Spare capacity. Invisible until opened for a specific event via event_bay_status.';

create table if not exists event_bay_status (
  event_id   uuid not null references event(id) on delete cascade,
  bay_id     uuid not null references bay(id) on delete cascade,
  state      text not null check (state in ('lost', 'open')),
  note       text,
  created_at timestamptz not null default now(),
  primary key (event_id, bay_id)
);

comment on table event_bay_status is
  'Tonight-only deviations from the yard on paper. lost = out of play, open = spare switched on.';

alter table event_bay_status enable row level security;

-- Readable in public for the same reason bay_allocation is: the views are
-- security_invoker, and a space taken out of play has to show up in the
-- counts the booking page renders. Writes stay with the service role.
drop policy if exists "public read bay status" on event_bay_status;
create policy "public read bay status"
  on event_bay_status for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------
--  Inventory now reads through tonight's deviations.
-- ---------------------------------------------------------------------
create or replace view v_bay_inventory as
-- NB: security_invoker is re-asserted after this statement; CREATE OR REPLACE
-- VIEW resets reloptions.
select
  eo.event_id,
  eo.property_id,
  z.id    as zone_id,
  z.code  as zone_code,
  z.label as zone_label,
  z.keys_held,
  z.reservable_in_advance,
  z.requires_consent,
  z.exit_rank,
  b.id    as bay_id,
  b.label as bay_label,
  b.size_class,
  b.blocks_bay_id,
  b.requires_early_departure,
  (b.blocks_bay_id is not null) as blocks_someone,
  -- The bay that would park in behind this one. A blocker that is itself
  -- out of play tonight blocks nobody, so this bay really is clear.
  (select bb.id
     from bay bb
    where bb.blocks_bay_id = b.id and bb.active
      and not exists (select 1 from event_bay_status sb
                       where sb.event_id = eo.event_id and sb.bay_id = bb.id
                         and sb.state = 'lost')) as blocker_bay_id,
  case
    when z.keys_held then 'valet'
    when (select bb.id
            from bay bb
           where bb.blocks_bay_id = b.id and bb.active
             and not exists (select 1 from event_bay_status sb
                              where sb.event_id = eo.event_id and sb.bay_id = bb.id
                                and sb.state = 'lost')) is null then 'free_exit'
    else 'may_be_blocked'
  end as exit_class,
  a.booking_id,
  a.role as allocation_role,
  (a.id is null) as available,
  z.gate_reserve,
  b.is_flex,
  s.state as night_state
from event_offer eo
join zone z on z.property_id = eo.property_id and z.active
join bay  b on b.zone_id = z.id and b.active
left join event_bay_status s on s.event_id = eo.event_id and s.bay_id = b.id
left join bay_allocation  a on a.event_id = eo.event_id and a.bay_id = b.id
where s.state is distinct from 'lost'
  -- A spare only counts once it has been switched on for this event.
  and (not b.is_flex or s.state = 'open');

-- ---------------------------------------------------------------------
--  One row per zone per event: what is there tonight, and what is in it.
-- ---------------------------------------------------------------------
drop view if exists v_night_capacity;
create view v_night_capacity
with (security_invoker = true)
as
select
  eo.event_id,
  z.id    as zone_id,
  z.code  as zone_code,
  z.label as zone_label,
  z.exit_rank,
  z.requires_consent,
  z.reservable_in_advance,
  z.keys_held,
  z.gate_reserve,
  count(i.bay_id)::integer                                  as capacity,
  count(i.bay_id) filter (where not i.available)::integer    as filled,
  count(i.bay_id) filter (where i.available)::integer        as free,
  (select count(*) from event_bay_status s
     join bay lb on lb.id = s.bay_id
    where s.event_id = eo.event_id and lb.zone_id = z.id
      and s.state = 'lost')::integer                         as lost,
  (select count(*) from event_bay_status s
     join bay ob on ob.id = s.bay_id
    where s.event_id = eo.event_id and ob.zone_id = z.id
      and s.state = 'open')::integer                          as opened,
  -- Spares still in the drawer. When this hits zero, "+1" has nothing left
  -- to give and says so rather than failing quietly.
  (select count(*) from bay fb
    where fb.zone_id = z.id and fb.active and fb.is_flex
      and not exists (select 1 from event_bay_status s2
                       where s2.event_id = eo.event_id and s2.bay_id = fb.id))::integer
                                                             as spare_left
from event_offer eo
join zone z on z.property_id = eo.property_id and z.active
left join v_bay_inventory i on i.event_id = eo.event_id and i.zone_id = z.id
group by eo.event_id, z.id, z.code, z.label, z.exit_rank,
         z.requires_consent, z.reservable_in_advance, z.keys_held, z.gate_reserve;

grant select on v_night_capacity to anon, authenticated, service_role;
alter view v_bay_inventory set (security_invoker = true);

-- ---------------------------------------------------------------------
--  The two buttons on the gate screen.
-- ---------------------------------------------------------------------
create or replace function adjust_zone_capacity(
  p_event_id uuid,
  p_zone_id  uuid,
  p_delta    integer,
  p_note     text default null
) returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_step integer;
  v_bay  uuid;
begin
  if p_delta = 0 then
    raise exception 'NO_CHANGE: delta must not be zero' using errcode = 'check_violation';
  end if;

  for v_step in 1 .. abs(p_delta) loop
    if p_delta < 0 then
      -- Losing one. Prefer undoing a spare we opened earlier — that leaves
      -- the yard closer to the plan than scratching a real bay.
      select i.bay_id into v_bay
        from v_bay_inventory i
       where i.event_id = p_event_id and i.zone_id = p_zone_id
         and i.available and i.is_flex and i.night_state = 'open'
       order by i.bay_label desc
       limit 1;

      if v_bay is not null then
        delete from event_bay_status
         where event_id = p_event_id and bay_id = v_bay;
      else
        -- Otherwise take a free real bay, cheapest first: one with nothing
        -- parked in behind it, and a double-park position before a bay that
        -- somebody else's position depends on.
        select i.bay_id into v_bay
          from v_bay_inventory i
         where i.event_id = p_event_id and i.zone_id = p_zone_id
           and i.available and not i.is_flex
           and (i.blocker_bay_id is null
                or not exists (select 1 from bay_allocation a2
                                where a2.event_id = p_event_id
                                  and a2.bay_id = i.blocker_bay_id))
         order by
           case when i.blocker_bay_id is null then 0 else 1 end,
           case when i.blocks_someone then 0 else 1 end,
           i.bay_label desc
         limit 1;

        if v_bay is null then
          raise exception
            'NOTHING_FREE: every space in that zone is taken — move a car before writing one off'
            using errcode = 'check_violation';
        end if;

        insert into event_bay_status (event_id, bay_id, state, note)
        values (p_event_id, v_bay, 'lost', p_note)
        on conflict (event_id, bay_id)
          do update set state = 'lost', note = excluded.note;
      end if;

    else
      -- Gaining one. Give a written-off bay back before opening a spare.
      select s.bay_id into v_bay
        from event_bay_status s
        join bay b on b.id = s.bay_id
       where s.event_id = p_event_id and b.zone_id = p_zone_id
         and s.state = 'lost' and not b.is_flex
       order by b.label asc
       limit 1;

      if v_bay is not null then
        delete from event_bay_status
         where event_id = p_event_id and bay_id = v_bay;
      else
        select b.id into v_bay
          from bay b
         where b.zone_id = p_zone_id and b.active and b.is_flex
           and not exists (select 1 from event_bay_status s2
                            where s2.event_id = p_event_id and s2.bay_id = b.id)
         order by b.label asc
         limit 1;

        if v_bay is null then
          raise exception 'NO_SPARE: no spare space left to open in that zone'
            using errcode = 'check_violation';
        end if;

        insert into event_bay_status (event_id, bay_id, state, note)
        values (p_event_id, v_bay, 'open', p_note);
      end if;
    end if;
  end loop;

  return (select count(*)::integer
            from v_bay_inventory i
           where i.event_id = p_event_id and i.zone_id = p_zone_id);
end;
$function$;

-- ---------------------------------------------------------------------
--  Spares. Deliberately modest: this is squeezing a car in, not a car park.
-- ---------------------------------------------------------------------
insert into bay (zone_id, label, size_class, is_flex, requires_early_departure)
select z.id, z.label || ' spare ' || g.n, 'compact', true, false
from zone z
cross join lateral (
  select generate_series(1, case z.code
                                when 'back_yard'      then 4
                                when 'front_lawn'     then 2
                                when 'berm'           then 3
                                when 'neighbour_berm' then 4
                                else 2
                              end) as n
) g
where z.active
  and not exists (
    select 1 from bay b
     where b.zone_id = z.id and b.is_flex
       and b.label = z.label || ' spare ' || g.n
  );
