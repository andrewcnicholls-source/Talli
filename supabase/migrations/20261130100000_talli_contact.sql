-- =====================================================================
--  Talli — contact us (docs/plans/reviews-and-contact.md, slice 2)
--
--  The "Get in touch" form on the homepage. Each message is stored here
--  and emailed to bookings@ by the submit-contact edge function, with
--  Reply-To set to the sender, so answering it is just replying. Storing
--  it as well means a message is never lost to a mail problem, and the
--  test project, which sends no email, can still be tested: messages
--  show on the gate screen's Insights tab.
--
--    contact_message        one row per message. Service role only:
--                           every row is someone's email or phone.
--    submit_contact()       the only way in. A message, and at least one
--                           way to reply.
--    contact_emailed()      submit-contact records that the email went.
--    contact_messages()     the operator's list, newest first.
--    set_contact_handled()  tick a message off, or back on.
--
--  Additive: one table, four functions.
-- =====================================================================

create table if not exists contact_message (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text check (char_length(name) <= 120),
  email       text check (char_length(email) <= 254),
  phone       text check (char_length(phone) <= 40),
  message     text not null check (char_length(message) between 1 and 4000),
  emailed_at  timestamptz,
  handled_at  timestamptz,
  constraint contact_message_reply_check check (email is not null or phone is not null)
);

create index if not exists contact_message_created_idx on contact_message (created_at desc);

comment on table contact_message is
  'Messages from the homepage contact form. Service role only: written by '
  'submit_contact(), read by contact_messages() for the operator.';
comment on column contact_message.emailed_at is
  'When submit-contact emailed it to bookings@. Null on the test project, '
  'which has no mail key, and when sending failed.';

alter table contact_message enable row level security;
revoke all on contact_message from public, anon, authenticated;

-- --------------------------------------------------------- submit_contact

create or replace function public.submit_contact(
  p_message text,
  p_name    text default null,
  p_email   text default null,
  p_phone   text default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_message text := nullif(trim(coalesce(p_message, '')), '');
  v_name    text := nullif(trim(coalesce(p_name, '')), '');
  v_email   text := nullif(trim(coalesce(p_email, '')), '');
  v_phone   text := nullif(trim(coalesce(p_phone, '')), '');
  v_id      uuid;
begin
  if v_message is null then
    raise exception 'NO_MESSAGE: Write a message first.';
  end if;
  if char_length(v_message) > 4000 then
    raise exception 'TOO_LONG: That message is too long.';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'NO_REPLY: Leave an email or a phone number so we can reply.';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'BAD_EMAIL: That email address does not look right.';
  end if;
  if v_phone is not null and v_phone !~ '^[0-9+() .-]{6,40}$' then
    raise exception 'BAD_PHONE: That phone number does not look right.';
  end if;
  if char_length(v_name) > 120 or char_length(v_email) > 254 then
    raise exception 'TOO_LONG: That name or email is too long.';
  end if;

  insert into contact_message (name, email, phone, message)
  values (v_name, v_email, v_phone, v_message)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

comment on function public.submit_contact(text, text, text, text) is
  'The one way a contact message is written: a message and at least one way to reply.';

revoke all on function public.submit_contact(text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_contact(text, text, text, text) to service_role;

-- -------------------------------------------------------- contact_emailed

create or replace function public.contact_emailed(p_id uuid)
returns void
language sql
set search_path to 'public'
as $function$
  update contact_message set emailed_at = now() where id = p_id;
$function$;

revoke all on function public.contact_emailed(uuid) from public, anon, authenticated;
grant execute on function public.contact_emailed(uuid) to service_role;

-- ------------------------------------------------------- contact_messages

create or replace function public.contact_messages(p_limit int default 50)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'open', (select count(*) from contact_message where handled_at is null),
    'messages', coalesce((
      select jsonb_agg(x order by x->>'created_at' desc)
        from (
          select jsonb_build_object(
                   'id', m.id,
                   'created_at', m.created_at,
                   'name', m.name,
                   'email', m.email,
                   'phone', m.phone,
                   'message', m.message,
                   'emailed', m.emailed_at is not null,
                   'handled', m.handled_at is not null) as x
            from contact_message m
           order by m.created_at desc
           limit greatest(1, least(coalesce(p_limit, 50), 200))
        ) latest), '[]'::jsonb));
$function$;

comment on function public.contact_messages(int) is
  'The operator''s list of contact messages, newest first, and how many are open. '
  'Called by gate-ops (action contact_messages, operator only).';

revoke all on function public.contact_messages(int) from public, anon, authenticated;
grant execute on function public.contact_messages(int) to service_role;

-- ---------------------------------------------------- set_contact_handled

create or replace function public.set_contact_handled(p_id uuid, p_handled boolean)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
begin
  update contact_message
     set handled_at = case when p_handled then coalesce(handled_at, now()) end
   where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: That message is not there any more.';
  end if;
  return jsonb_build_object('ok', true, 'handled', p_handled);
end;
$function$;

revoke all on function public.set_contact_handled(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_contact_handled(uuid, boolean) to service_role;
