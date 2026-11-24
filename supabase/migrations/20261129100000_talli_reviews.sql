-- =====================================================================
--  Talli — rate us (docs/plans/reviews-and-contact.md, slice 1)
--
--  A customer rates the night from the homepage: stars, an optional
--  comment, name and contact, and optionally where they parked. That
--  makes each review a small review of a site too.
--
--    review              one row per review. Nothing outside the
--                        service role reads or writes it: comments name
--                        people and contact details are personal.
--    review_options()    the sites a customer can pick from, by the name
--                        the gate screen uses ("86 Paice Ave"). Never
--                        the full address or anything about the host.
--    submit_review()     the only way in, through the submit-review edge
--                        function. Checks every field. Given a checkout
--                        session, ties the review to that booking: the
--                        site is where the car actually was
--                        (booking.property_id), the night is the
--                        booking's, and a second send updates the first.
--    review_summary()    what the gate screen's Insights tab shows the
--                        operator: overall, per site, the latest comments.
--
--  Nothing here publishes a review anywhere. Every foreign key is
--  "on delete set null", so a review never blocks deleting a booking,
--  an event or a site, and the test reset is unchanged.
--
--  Additive: one table, four functions.
-- =====================================================================

create table if not exists review (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  rating        smallint not null check (rating between 1 and 5),
  comment       text check (char_length(comment) <= 2000),
  name          text check (char_length(name) <= 120),
  contact       text check (char_length(contact) <= 200),
  property_id   uuid references property(id) on delete set null,
  event_id      uuid references event(id) on delete set null,
  booking_id    uuid unique references booking(id) on delete set null,
  easy_to_find  boolean,
  easy_to_leave boolean,
  source        text not null check (source in ('homepage', 'booking'))
);

create index if not exists review_property_idx on review (property_id);
create index if not exists review_created_idx on review (created_at desc);

comment on table review is
  'A customer''s rating of a night, and of the site they parked at when known. '
  'Service role only: written by submit_review(), read by review_summary().';
comment on column review.contact is
  'An email or phone, given only so we can reply. Never shown anywhere public.';
comment on column review.property_id is
  'Where they parked. From a booking it is booking.property_id (where the car '
  'actually was); from the homepage it is what they picked, or null.';

alter table review enable row level security;
revoke all on review from public, anon, authenticated;

-- --------------------------------------------------------- review_options

create or replace function public.review_options()
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'label', p.name)
         order by p.name), '[]'::jsonb)
    from property p
   where p.active;
$function$;

comment on function public.review_options() is
  'The sites a reviewer can say they parked at: active sites, by name only.';

revoke all on function public.review_options() from public, anon, authenticated;
grant execute on function public.review_options() to service_role;

-- ---------------------------------------------------------- submit_review

create or replace function public.submit_review(
  p_rating        int,
  p_comment       text default null,
  p_name          text default null,
  p_contact       text default null,
  p_property_id   uuid default null,
  p_easy_to_find  boolean default null,
  p_easy_to_leave boolean default null,
  p_session_id    text default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_comment  text := nullif(trim(coalesce(p_comment, '')), '');
  v_name     text := nullif(trim(coalesce(p_name, '')), '');
  v_contact  text := nullif(trim(coalesce(p_contact, '')), '');
  v_session  text := nullif(trim(coalesce(p_session_id, '')), '');
  v_booking  record;
  v_id       uuid;
  v_updated  boolean := false;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'BAD_RATING: A rating is 1 to 5 stars.';
  end if;
  if char_length(v_comment) > 2000 then
    raise exception 'TOO_LONG: That comment is too long.';
  end if;
  if char_length(v_name) > 120 or char_length(v_contact) > 200 then
    raise exception 'TOO_LONG: That name or contact is too long.';
  end if;

  if v_session is not null then
    select b.id, b.property_id, b.event_id, b.status
      into v_booking
      from booking b
     where b.stripe_checkout_session_id = v_session;
    -- A hold that was never paid for is not a night anyone had.
    if not found or v_booking.status in ('held', 'expired') then
      raise exception 'NO_BOOKING: That booking link is not one we recognise.';
    end if;

    -- The car's actual site, never the one in the request: a booking
    -- knows where it parked better than a dropdown does.
    insert into review (rating, comment, name, contact, property_id, event_id,
                        booking_id, easy_to_find, easy_to_leave, source)
    values (p_rating, v_comment, v_name, v_contact, v_booking.property_id,
            v_booking.event_id, v_booking.id, p_easy_to_find, p_easy_to_leave, 'booking')
    on conflict (booking_id) do update
       set rating = excluded.rating,
           comment = excluded.comment,
           name = excluded.name,
           contact = excluded.contact,
           easy_to_find = excluded.easy_to_find,
           easy_to_leave = excluded.easy_to_leave,
           updated_at = now()
    returning id, (xmax <> 0) into v_id, v_updated;

    return jsonb_build_object('ok', true, 'id', v_id, 'updated', v_updated,
                              'from_booking', true);
  end if;

  if p_property_id is not null
     and not exists (select 1 from property where id = p_property_id and active) then
    raise exception 'NO_SITE: That site is not one of ours.';
  end if;

  insert into review (rating, comment, name, contact, property_id,
                      easy_to_find, easy_to_leave, source)
  values (p_rating, v_comment, v_name, v_contact, p_property_id,
          p_easy_to_find, p_easy_to_leave, 'homepage')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'updated', false,
                            'from_booking', false);
end;
$function$;

comment on function public.submit_review(int, text, text, text, uuid, boolean, boolean, text) is
  'The one way a review is written. With a checkout session it is tied to that '
  'booking (its site and night, one per booking); without, it is a homepage review.';

revoke all on function public.submit_review(int, text, text, text, uuid, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.submit_review(int, text, text, text, uuid, boolean, boolean, text)
  to service_role;

-- --------------------------------------------------------- review_summary

create or replace function public.review_summary(p_limit int default 50)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'overall', (
      select jsonb_build_object(
               'count', count(*),
               'average', round(avg(rating)::numeric, 1))
        from review),
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'property_id', s.property_id,
               'label', s.label,
               'count', s.n,
               'average', s.average,
               'find_yes', s.find_yes, 'find_no', s.find_no,
               'leave_yes', s.leave_yes, 'leave_no', s.leave_no)
             order by s.n desc, s.label)
        from (
          select r.property_id,
                 coalesce(p.name, 'Not said') as label,
                 count(*) as n,
                 round(avg(r.rating)::numeric, 1) as average,
                 count(*) filter (where r.easy_to_find) as find_yes,
                 count(*) filter (where r.easy_to_find = false) as find_no,
                 count(*) filter (where r.easy_to_leave) as leave_yes,
                 count(*) filter (where r.easy_to_leave = false) as leave_no
            from review r
            left join property p on p.id = r.property_id
           group by r.property_id, p.name
        ) s), '[]'::jsonb),
    'latest', coalesce((
      select jsonb_agg(x order by x->>'created_at' desc)
        from (
          select jsonb_build_object(
                   'id', r.id,
                   'created_at', r.created_at,
                   'rating', r.rating,
                   'comment', r.comment,
                   'name', r.name,
                   'contact', r.contact,
                   'site', p.name,
                   'event', e.name,
                   'event_starts_at', e.starts_at,
                   'easy_to_find', r.easy_to_find,
                   'easy_to_leave', r.easy_to_leave,
                   'source', r.source) as x
            from review r
            left join property p on p.id = r.property_id
            left join event e on e.id = r.event_id
           order by r.created_at desc
           limit greatest(1, least(coalesce(p_limit, 50), 200))
        ) latest), '[]'::jsonb));
$function$;

comment on function public.review_summary(int) is
  'The operator''s view of reviews: overall average, per site, and the latest. '
  'Called by gate-ops (action reviews, operator only).';

revoke all on function public.review_summary(int) from public, anon, authenticated;
grant execute on function public.review_summary(int) to service_role;
