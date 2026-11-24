-- =====================================================================
--  Contact us (20261130100000_talli_contact).
--
--  Done when: a message with a way to reply is stored, trimmed; one with
--  no message or no way to reply is refused by name; nothing outside the
--  service role reads the table or calls the functions; and the operator
--  can tick a message off and back on. Rolled back.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

delete from contact_message;

-- ------------------------------------------------------------ who may
select ok(not has_table_privilege('anon', 'public.contact_message', 'select'),
  'the public cannot read messages');
select ok(not has_table_privilege('anon', 'public.contact_message', 'insert'),
  'nor write one straight into the table');
select ok(not has_table_privilege('authenticated', 'public.contact_message', 'select'),
  'nor can a signed-in browser');
select ok(not has_function_privilege('anon', 'public.submit_contact(text, text, text, text)', 'execute'),
  'submit_contact is the edge function''s, not the browser''s');
select ok(not has_function_privilege('anon', 'public.contact_messages(int)', 'execute'),
  'the list is service role only');

-- ---------------------------------------------------------- writing
create temp table made (k text primary key, id uuid);
insert into made values ('sam',
  (submit_contact('  Can I book for six cars?  ', ' Sam ', 'sam@example.com', null)->>'id')::uuid);
select is((select row(name, email, phone, message)::text from contact_message
            where id = (select id from made where k = 'sam')),
  row('Sam', 'sam@example.com', null::text, 'Can I book for six cars?')::text,
  'stored as sent, trimmed');

select lives_ok($$ select submit_contact('Call me back', null, null, '021 555 0101') $$,
  'a phone alone is a way to reply');

select throws_like($$ select submit_contact('   ', null, 'a@example.com') $$,
  '%NO_MESSAGE%', 'an empty message is refused');
select throws_like($$ select submit_contact('Hello') $$,
  '%NO_REPLY%', 'a message nobody can answer is refused');
select throws_like($$ select submit_contact('Hello', null, 'not an email') $$,
  '%BAD_EMAIL%', 'an email that is not one is refused');
select throws_like($$ select submit_contact('Hello', null, null, 'call me') $$,
  '%BAD_PHONE%', 'so is a phone that is not one');
select throws_like($$ select submit_contact(repeat('x', 4001), null, 'a@example.com') $$,
  '%TOO_LONG%', 'a message has a limit');

-- ----------------------------------------------------- the operator
select is((contact_messages()->>'open')::int, 2, 'both messages are open');
select set_contact_handled((select id from made where k = 'sam'), true);
select is((contact_messages()->>'open')::int, 1, 'ticking one off leaves one open');
select set_contact_handled((select id from made where k = 'sam'), false);
select is((contact_messages()->>'open')::int, 2, 'and it can be put back');
select throws_like($$ select set_contact_handled(gen_random_uuid(), true) $$,
  '%NOT_FOUND%', 'a message that is not there is said to be not there');

select * from finish();
rollback;
