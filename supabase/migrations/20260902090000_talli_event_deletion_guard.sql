-- =====================================================================
--  Talli Parking — an event with people attached is not deletable
--
--  Taking a fixture off sale and deleting it are different acts, and
--  only one of them is reversible. The gate screen now has a status
--  control, so "this game is off" has a correct answer — cancelled —
--  and deleting the row is never it once anyone is attached to the
--  night.
--
--  WHAT WAS ALREADY SAFE, and stays that way:
--
--    booking.event_id is ON DELETE RESTRICT, so an event that has sold
--    anything already refuses to be deleted. That has been true since
--    the core schema. What it lacks is an explanation: the caller gets
--    a foreign-key violation naming a constraint, not a sentence saying
--    to cancel the event instead.
--
--  WHAT WAS NOT, and is the reason this migration exists:
--
--    event_interest.event_id was ON DELETE CASCADE. Deleting an event
--    silently deleted the list of people who had asked to be told when
--    it went on sale — the one thing 20260819122426 called "the asset
--    here", because it compounds across fixtures that were too early to
--    price. No error, no trace, and nothing to restore from.
--
--  The rule is written as a property of the data, not of the
--  environment, which is why it can be the same on both projects: the
--  reset script under supabase/test-only/ clears bookings and interest
--  before it clears events, so wiping test data still works exactly as
--  before. An event nobody has touched still deletes cleanly, on either
--  project.
--
--  Config attached to an event — event_offer, offer_tier,
--  event_bay_status, event_overflow_limit — keeps cascading. Nobody is
--  attached to a price row.
-- =====================================================================

-- ---------------------------------------------------------------------
--  The guard itself.
--
--  BEFORE DELETE, so it speaks before any cascade runs and before the
--  booking foreign key fires. Both counts are reported rather than
--  just the first, because "there are no bookings" is not the same
--  answer as "there is nothing attached at all", and someone deciding
--  what to do next needs the whole picture.
-- ---------------------------------------------------------------------
create or replace function refuse_to_delete_a_live_event()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_paid     integer;
  v_holds    integer;
  v_interest integer;
begin
  select count(*) filter (where b.status = 'paid'),
         count(*) filter (where b.status <> 'paid')
    into v_paid, v_holds
    from booking b
   where b.event_id = old.id;

  select count(*) into v_interest
    from event_interest i
   where i.event_id = old.id;

  if v_paid = 0 and v_holds = 0 and v_interest = 0 then
    return old;
  end if;

  raise exception
    'EVENT_NOT_EMPTY: "%" has % paid booking(s), % unpaid hold(s) and % '
    'registered interest — take it off sale instead of deleting it '
    '(set status to cancelled or closed; the gate screen does this from '
    'the Tonight tab)',
    old.name, v_paid, v_holds, v_interest
    using errcode = 'restrict_violation';
end;
$function$;

comment on function refuse_to_delete_a_live_event() is
  'An event with money or people attached is taken off sale, never deleted.';

drop trigger if exists event_deletion_guard on event;
create trigger event_deletion_guard
  before delete on event
  for each row
  execute function refuse_to_delete_a_live_event();

-- ---------------------------------------------------------------------
--  And the same rule at the foreign key, so it survives the trigger.
--
--  The trigger is the thing that explains itself, and a trigger can be
--  dropped by one line of SQL. RESTRICT on the interest rows means that
--  even then the mailing list cannot be deleted as a side effect of
--  deleting the fixture — the delete fails instead. This mirrors what
--  booking.event_id has always done.
-- ---------------------------------------------------------------------
alter table event_interest
  drop constraint if exists event_interest_event_id_fkey;

alter table event_interest
  add constraint event_interest_event_id_fkey
  foreign key (event_id) references event(id) on delete restrict;
