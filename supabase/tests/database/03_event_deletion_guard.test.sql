-- =====================================================================
--  An event with people attached is taken off sale, never deleted
--  (20260902090000_talli_event_deletion_guard; CLAUDE.md).
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(4);

select hold_booking('7e57e000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222223',
                    'standard', 'buyer@example.com', 'Buyer', null, 'DEL1');

select throws_like($$ delete from event where id = '7e57e000-0000-4000-8000-000000000001' $$,
  'EVENT_NOT_EMPTY%', 'a night with a booking on it cannot be deleted');

insert into event_interest (event_id, email)
values ('7e57e000-0000-4000-8000-000000000002', 'interested@example.com');
select throws_like($$ delete from event where id = '7e57e000-0000-4000-8000-000000000002' $$,
  'EVENT_NOT_EMPTY%', 'nor can a night somebody registered interest in');

insert into event (id, name, starts_at, status)
values ('7e57e000-0000-4000-8000-0000000000ff', 'TEST — nobody touched this', now() + interval '60 days', 'draft');
select lives_ok($$ delete from event where id = '7e57e000-0000-4000-8000-0000000000ff' $$,
  'a night nobody touched still deletes');

select lives_ok($$ select set_event_status('7e57e000-0000-4000-8000-000000000001', 'cancelled') $$,
  'and a busy night can always be cancelled instead');

select * from finish();
rollback;
