-- Remember welcome preferences per account and count distinct, real sign-ins.
-- Refresh tokens reuse auth.sessions.id. Visits and token refreshes never count.
-- Keep at most four IDs: the only threshold the welcome UI needs is >3.
-- Supabase removes sessions on sign-out, so copy the retained history now and
-- preserve observed IDs independently. Already deleted historical sessions
-- cannot be reconstructed when database Auth audit logging was disabled.
create table rehearsal_private.welcome_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sign_in_sessions uuid[] not null default '{}'::uuid[],
  dont_show_again boolean not null default false,
  check (cardinality(sign_in_sessions) between 0 and 4),
  check (array_position(sign_in_sessions,null) is null)
);
alter table rehearsal_private.welcome_preferences enable row level security;
revoke all on rehearsal_private.welcome_preferences from public,anon,authenticated;
grant all on rehearsal_private.welcome_preferences to service_role;

insert into rehearsal_private.welcome_preferences(user_id,sign_in_sessions)
select u.id,array(select s.id from auth.sessions s where s.user_id=u.id order by s.created_at,s.id limit 4)
from auth.users u;

-- Only the verified gateway can supply p_user. A lock serializes simultaneous
-- tabs, preference updates, and newly observed logins for the same account.
create function public.rehearsal_welcome_preference(p_user uuid,p_dont_show_again boolean default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  seen uuid[];
  hidden boolean;
begin
  if p_user is null or not exists(select 1 from auth.users where id=p_user) then
    raise exception 'invalid_request';
  end if;
  insert into rehearsal_private.welcome_preferences(user_id) values(p_user) on conflict do nothing;
  select sign_in_sessions,dont_show_again into seen,hidden
    from rehearsal_private.welcome_preferences where user_id=p_user for update;
  if cardinality(seen)<4 then
    seen := array(
      select distinct sessions.id from (
        select unnest(seen) as id
        union all
        select s.id from auth.sessions s where s.user_id=p_user
      ) sessions order by sessions.id limit 4
    );
  end if;
  hidden := coalesce(p_dont_show_again,hidden);
  update rehearsal_private.welcome_preferences
    set sign_in_sessions=seen,dont_show_again=hidden where user_id=p_user;
  return jsonb_build_object('signInCount',cardinality(seen),'dontShowAgain',hidden);
end $$;
revoke all on function public.rehearsal_welcome_preference(uuid,boolean) from public,anon,authenticated;
grant execute on function public.rehearsal_welcome_preference(uuid,boolean) to service_role;
