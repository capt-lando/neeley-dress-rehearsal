-- Release abandoned upload slots without deleting metadata, audio, or reports.
alter table public.rehearsal_recordings
  add column upload_expires_at timestamptz not null default now()+interval '1 hour',
  add column upload_expired boolean not null default false;
alter table rehearsal_private.daily_usage
  add column recording_count integer not null default 0 check(recording_count>=0),
  add column event_count integer not null default 0 check(event_count>=0);
alter table rehearsal_private.user_daily_usage
  add column recording_count integer not null default 0 check(recording_count>=0),
  add column event_count integer not null default 0 check(event_count>=0);

-- Seed only the new counters. Existing financial/request accounting is untouched.
insert into rehearsal_private.daily_usage(day,recording_count)
  select (created_at at time zone 'UTC')::date,count(*) from public.rehearsal_recordings group by 1
  on conflict(day) do update set recording_count=excluded.recording_count;
insert into rehearsal_private.user_daily_usage(user_id,day,recording_count)
  select user_id,(created_at at time zone 'UTC')::date,count(*) from public.rehearsal_recordings group by 1,2
  on conflict(user_id,day) do update set recording_count=excluded.recording_count;
insert into rehearsal_private.daily_usage(day,event_count)
  select (created_at at time zone 'UTC')::date,count(*) from public.rehearsal_events group by 1
  on conflict(day) do update set event_count=excluded.event_count;
insert into rehearsal_private.user_daily_usage(user_id,day,event_count)
  select user_id,(created_at at time zone 'UTC')::date,count(*) from public.rehearsal_events group by 1,2
  on conflict(user_id,day) do update set event_count=excluded.event_count;

-- Bounded distributed request counters: one project row and existing profiles.
-- The gateway admits globally before token verification, then by verified user.
create table rehearsal_private.request_rate (
  singleton boolean primary key default true check(singleton),
  window_start timestamptz not null default clock_timestamp(),
  request_count integer not null default 0 check(request_count>=0)
);
insert into rehearsal_private.request_rate(singleton) values(true);
alter table rehearsal_private.request_rate enable row level security;
revoke all on rehearsal_private.request_rate from public,anon,authenticated;
alter table public.rehearsal_profiles
  add column request_window_start timestamptz not null default clock_timestamp(),
  add column request_window_count integer not null default 0 check(request_window_count>=0);
create function public.rehearsal_admit_request(p_user uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare started timestamptz; used integer; current_time_at_gate timestamptz;
begin
  if p_user is null then
    select window_start,request_count into started,used from rehearsal_private.request_rate where singleton for update;
  else
    insert into public.rehearsal_profiles(user_id) values(p_user) on conflict do nothing;
    select request_window_start,request_window_count into started,used from public.rehearsal_profiles where user_id=p_user for update;
    if not found then raise exception 'invalid_request'; end if;
  end if;
  current_time_at_gate:=clock_timestamp();
  if started<=current_time_at_gate-interval '1 minute' then started:=current_time_at_gate; used:=0; end if;
  if used>=(case when p_user is null then 1200 else 120 end) then raise exception 'rate_limited'; end if;
  if p_user is null then
    update rehearsal_private.request_rate set window_start=started,request_count=used+1 where singleton;
  else
    update public.rehearsal_profiles set request_window_start=started,request_window_count=used+1 where user_id=p_user;
  end if;
end $$;
revoke all on function public.rehearsal_admit_request(uuid) from public,anon,authenticated;
grant execute on function public.rehearsal_admit_request(uuid) to service_role;

-- Audio is uploaded only by the verified gateway after canonical WAV validation.
-- Enforce the lease on the privileged final INSERT, serialized with admission.
create function rehearsal_private.guard_recording_upload()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.bucket_id='recordings' then
    perform 1 from rehearsal_private.limits where singleton for update;
    if not exists(select 1 from public.rehearsal_recordings r where r.storage_path=new.name
      and r.status='pending' and not r.upload_expired and r.upload_expires_at>clock_timestamp()) then
      raise exception 'upload_expired' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function rehearsal_private.guard_recording_upload() from public,anon,authenticated;
create trigger rehearsal_upload_lease before insert on storage.objects
  for each row execute function rehearsal_private.guard_recording_upload();
drop policy rehearsal_upload on storage.objects;

create or replace function public.rehearsal_create_recording(p_user uuid,p_id uuid,p_title text,p_duration double precision,p_size integer)
returns public.rehearsal_recordings language plpgsql security definer set search_path='' as $$
declare result public.rehearsal_recordings; limits rehearsal_private.limits;
  today date:=(now() at time zone 'UTC')::date;
begin
  select * into limits from rehearsal_private.limits where singleton for update;
  select * into result from public.rehearsal_recordings where id=p_id;
  if found then
    if result.user_id<>p_user or result.title<>p_title or result.duration_seconds<>p_duration or result.size_bytes<>p_size
      or result.upload_expired then raise exception 'request_conflict'; end if;
    return result;
  end if;
  update public.rehearsal_recordings r set upload_expired=true
    where r.status='pending' and not r.upload_expired and r.upload_expires_at<=clock_timestamp()
      and not exists(select 1 from storage.objects o where o.bucket_id='recordings' and o.name=r.storage_path)
      and not exists(select 1 from rehearsal_private.live_sessions s
        where s.recording_id=r.id and s.status='active' and s.expires_at>clock_timestamp());
  if (select count(*) from public.rehearsal_recordings where not upload_expired and user_id=p_user)>=limits.max_saved_recordings
    or (select count(*) from public.rehearsal_recordings where not upload_expired)>=limits.max_total_recordings
    or (select count(*) from public.rehearsal_recordings)>=10000 then raise exception 'storage_limit'; end if;
  insert into rehearsal_private.daily_usage(day) values(today) on conflict do nothing;
  insert into rehearsal_private.user_daily_usage(user_id,day) values(p_user,today) on conflict do nothing;
  if (select recording_count from rehearsal_private.daily_usage where day=today)>=400
    or (select recording_count from rehearsal_private.user_daily_usage where user_id=p_user and day=today)>=40 then
    raise exception 'daily_limit';
  end if;
  insert into public.rehearsal_recordings(id,user_id,title,duration_seconds,size_bytes,storage_path)
    values(p_id,p_user,p_title,p_duration,p_size,p_user::text||'/'||p_id::text||'/audio.wav') returning * into result;
  update rehearsal_private.daily_usage set recording_count=recording_count+1 where day=today;
  update rehearsal_private.user_daily_usage set recording_count=recording_count+1 where user_id=p_user and day=today;
  return result;
end $$;

-- No automatic analytics/content deletion. Stop accepting events at the retained
-- row ceiling until an explicit retention/aggregation policy has been approved.
create or replace function public.rehearsal_ingest_events(p_user uuid,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare accepted integer; fresh jsonb; today date:=(now() at time zone 'UTC')::date;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 20 then raise exception 'invalid_request'; end if;
  perform 1 from rehearsal_private.limits where singleton for update;
  if not exists(select 1 from public.rehearsal_profiles where user_id=p_user) then raise exception 'invalid_request'; end if;
  select coalesce(jsonb_agg(e),'[]'::jsonb) into fresh from (
    select distinct on ((v->>'id')::uuid) v as e from jsonb_array_elements(p_events) v
      where not exists(select 1 from public.rehearsal_events old where old.user_id=p_user and old.id=(v->>'id')::uuid)
  ) incoming;
  accepted:=jsonb_array_length(fresh);
  if accepted=0 then return 0; end if;
  insert into rehearsal_private.daily_usage(day) values(today) on conflict do nothing;
  insert into rehearsal_private.user_daily_usage(user_id,day) values(p_user,today) on conflict do nothing;
  if (select count(*) from public.rehearsal_events where user_id=p_user and created_at>now()-interval '1 minute')+accepted>120
    or (select event_count from rehearsal_private.user_daily_usage where user_id=p_user and day=today)+accepted>1000
    or (select event_count from rehearsal_private.daily_usage where day=today)+accepted>10000
    or (select count(*) from public.rehearsal_events)+accepted>100000 then raise exception 'daily_limit'; end if;
  insert into public.rehearsal_events(user_id,id,session_id,name,section,active_seconds)
    select p_user,(e->>'id')::uuid,(e->>'sessionId')::uuid,e->>'name',e->>'section',coalesce((e->>'activeSeconds')::double precision,0)
      from jsonb_array_elements(fresh) e;
  update rehearsal_private.daily_usage set event_count=event_count+accepted where day=today;
  update rehearsal_private.user_daily_usage set event_count=event_count+accepted where user_id=p_user and day=today;
  return accepted;
end $$;
