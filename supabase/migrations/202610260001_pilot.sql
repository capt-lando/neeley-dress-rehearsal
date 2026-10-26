-- Private student history, opt-in usage analytics, and prepaid request admission.
create schema if not exists rehearsal_private;
revoke all on schema rehearsal_private from public, anon, authenticated;

create table public.rehearsal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cohort text check (cohort in ('pdc', 'professor', 'speech_debate')),
  created_at timestamptz not null default now()
);
create table public.rehearsal_recordings (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  duration_seconds double precision not null check (duration_seconds between 0.5 and 600),
  size_bytes integer not null check (size_bytes between 44 and 20971520),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending','transcribing','transcribed','analyzed','failed','deleting')),
  transcript text check (char_length(transcript) <= 60000),
  report jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (storage_path = user_id::text || '/' || id::text || '/audio.wav')
);
create index rehearsal_recordings_user on public.rehearsal_recordings(user_id, created_at desc);
create table public.rehearsal_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  session_id uuid not null,
  name text not null check (name in ('session_started','section_engaged','recording_completed','analysis_requested','analysis_completed','analysis_failed')),
  section text not null check (section in ('prepare','rehearse','feedback')),
  active_seconds double precision not null default 0 check (active_seconds between 0 and 60),
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  check (name = 'section_engaged' or active_seconds = 0)
);
create index rehearsal_events_created on public.rehearsal_events(created_at);
create table rehearsal_private.limits (
  singleton boolean primary key default true check (singleton),
  daily_budget_microusd bigint not null default 0 check (daily_budget_microusd >= 0),
  requests_per_user_day integer not null default 10 check (requests_per_user_day between 0 and 1000),
  max_saved_recordings integer not null default 10 check (max_saved_recordings between 1 and 1000),
  max_total_recordings integer not null default 40 check (max_total_recordings between 1 and 100000)
);
insert into rehearsal_private.limits(singleton) values (true);
create table rehearsal_private.daily_usage (
  day date primary key,
  reserved_microusd bigint not null default 0 check (reserved_microusd >= 0)
);
create table rehearsal_private.user_daily_usage (
  user_id uuid references auth.users(id) on delete cascade,
  day date,
  request_count integer not null default 0,
  primary key(user_id, day)
);
create table rehearsal_private.jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  recording_id uuid not null references public.rehearsal_recordings(id) on delete cascade,
  kind text not null check (kind in ('transcribe','coach')),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  reserved_microusd bigint not null check (reserved_microusd > 0),
  status text not null default 'reserved' check (status in ('reserved','completed','failed')),
  response jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (user_id, request_id)
);
create index rehearsal_jobs_recording on rehearsal_private.jobs(recording_id);
create index rehearsal_jobs_created on rehearsal_private.jobs(created_at);

alter table public.rehearsal_profiles enable row level security;
alter table public.rehearsal_recordings enable row level security;
alter table public.rehearsal_events enable row level security;
alter table rehearsal_private.limits enable row level security;
alter table rehearsal_private.daily_usage enable row level security;
alter table rehearsal_private.user_daily_usage enable row level security;
alter table rehearsal_private.jobs enable row level security;
revoke all on public.rehearsal_profiles, public.rehearsal_recordings, public.rehearsal_events from public, anon, authenticated;
grant select on public.rehearsal_profiles, public.rehearsal_recordings to authenticated;
grant all on public.rehearsal_profiles, public.rehearsal_recordings, public.rehearsal_events to service_role;
create policy own_profile on public.rehearsal_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy own_recordings on public.rehearsal_recordings for select to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 20971520, array['audio/wav'])
on conflict(id) do update set public=false, file_size_limit=20971520, allowed_mime_types=array['audio/wav'];
create policy rehearsal_upload on storage.objects for insert to authenticated with check (
  bucket_id='recordings' and exists (select 1 from public.rehearsal_recordings r
    where r.storage_path=name and r.user_id=(select auth.uid()) and r.status='pending')
);
-- Storage's upload-permission probe does not contain measured metadata.size.
-- Bucket size plus admitted object counts bound storage; the gateway checks
-- actual bytes against the reservation before any speech-worker request.
create policy rehearsal_read on storage.objects for select to authenticated using (
  bucket_id='recordings' and exists (select 1 from public.rehearsal_recordings r
    where r.storage_path=name and r.user_id=(select auth.uid()) and r.status <> 'deleting')
);

-- Only the verified gateway may create records or admit paid work. Every function
-- has an empty search path and is explicitly unavailable to browser roles.
create function public.rehearsal_create_recording(p_user uuid, p_id uuid, p_title text, p_duration double precision, p_size integer)
returns public.rehearsal_recordings language plpgsql security definer set search_path='' as $$
declare result public.rehearsal_recordings; max_saved integer; max_total integer;
begin
  select max_saved_recordings,max_total_recordings into max_saved,max_total from rehearsal_private.limits where singleton for update;
  select * into result from public.rehearsal_recordings where id=p_id;
  if found then
    if result.user_id<>p_user or result.title<>p_title or result.duration_seconds<>p_duration or result.size_bytes<>p_size then
      raise exception 'request_conflict';
    end if;
    return result;
  end if;
  if (select count(*) from public.rehearsal_recordings where user_id=p_user)>=max_saved then raise exception 'storage_limit'; end if;
  if (select count(*) from public.rehearsal_recordings)>=max_total then raise exception 'storage_limit'; end if;
  insert into public.rehearsal_recordings(id,user_id,title,duration_seconds,size_bytes,storage_path)
  values(p_id,p_user,p_title,p_duration,p_size,p_user::text || '/' || p_id::text || '/audio.wav') returning * into result;
  return result;
end $$;

create function public.rehearsal_reserve(p_user uuid,p_recording uuid,p_request uuid,p_kind text,p_hash text,p_cost bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare limits rehearsal_private.limits; previous rehearsal_private.jobs; daily bigint; used integer; today date := (now() at time zone 'UTC')::date;
begin
  if p_cost is null or p_cost<=0 or p_cost>100000000 or p_kind not in ('transcribe','coach') or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request'; end if;
  select * into limits from rehearsal_private.limits where singleton for update;
  if not exists(select 1 from public.rehearsal_recordings where id=p_recording and user_id=p_user and status<>'deleting' for update) then raise exception 'not_found'; end if;
  select * into previous from rehearsal_private.jobs where user_id=p_user and request_id=p_request;
  if found then
    if previous.recording_id<>p_recording or previous.kind<>p_kind or previous.input_hash<>p_hash then raise exception 'request_conflict'; end if;
    return jsonb_build_object('state',previous.status,'response',previous.response);
  end if;
  if exists(select 1 from rehearsal_private.jobs where user_id=p_user and status='reserved' and created_at>now()-interval '10 minutes') then raise exception 'request_busy'; end if;
  insert into rehearsal_private.daily_usage(day) values(today) on conflict do nothing;
  insert into rehearsal_private.user_daily_usage(user_id,day) values(p_user,today) on conflict do nothing;
  select reserved_microusd into daily from rehearsal_private.daily_usage where day=today;
  select request_count into used from rehearsal_private.user_daily_usage where user_id=p_user and day=today;
  if daily+p_cost>limits.daily_budget_microusd then raise exception 'budget_exhausted'; end if;
  if used>=limits.requests_per_user_day then raise exception 'daily_limit'; end if;
  update rehearsal_private.daily_usage set reserved_microusd=reserved_microusd+p_cost where day=today;
  update rehearsal_private.user_daily_usage set request_count=request_count+1 where user_id=p_user and day=today;
  insert into rehearsal_private.jobs(user_id,request_id,recording_id,kind,input_hash,reserved_microusd) values(p_user,p_request,p_recording,p_kind,p_hash,p_cost);
  return jsonb_build_object('state','new');
end $$;

create function public.rehearsal_finish(p_user uuid,p_request uuid,p_ok boolean,p_response jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  update rehearsal_private.jobs set status=case when p_ok then 'completed' else 'failed' end,
    response=case when p_ok then p_response else null end, finished_at=now()
  where user_id=p_user and request_id=p_request and status='reserved';
  -- No refund: a canceled or failed network response may still have been billed.
end $$;

create function public.rehearsal_prepare_delete(p_user uuid,p_recording uuid)
returns text language plpgsql security definer set search_path='' as $$
declare path text;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select storage_path into path from public.rehearsal_recordings where id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if exists(select 1 from rehearsal_private.jobs where recording_id=p_recording and status='reserved' and created_at>now()-interval '10 minutes') then raise exception 'request_busy'; end if;
  update public.rehearsal_recordings set status='deleting',updated_at=now() where id=p_recording;
  return path;
end $$;

create function public.rehearsal_ingest_events(p_user uuid,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare accepted integer;
begin
  if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>20 then raise exception 'invalid_request'; end if;
  perform 1 from public.rehearsal_profiles where user_id=p_user for update;
  if (select count(*) from public.rehearsal_events where user_id=p_user and created_at>now()-interval '1 minute')+jsonb_array_length(p_events)>120 then raise exception 'daily_limit'; end if;
  insert into public.rehearsal_events(user_id,id,session_id,name,section,active_seconds)
    select p_user,(e->>'id')::uuid,(e->>'sessionId')::uuid,e->>'name',e->>'section',coalesce((e->>'activeSeconds')::double precision,0)
    from jsonb_array_elements(p_events) e on conflict(user_id,id) do nothing;
  get diagnostics accepted = row_count;
  return accepted;
end $$;

revoke all on function public.rehearsal_create_recording(uuid,uuid,text,double precision,integer),public.rehearsal_reserve(uuid,uuid,uuid,text,text,bigint),public.rehearsal_finish(uuid,uuid,boolean,jsonb),public.rehearsal_prepare_delete(uuid,uuid),public.rehearsal_ingest_events(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.rehearsal_create_recording(uuid,uuid,text,double precision,integer),public.rehearsal_reserve(uuid,uuid,uuid,text,text,bigint),public.rehearsal_finish(uuid,uuid,boolean,jsonb),public.rehearsal_prepare_delete(uuid,uuid),public.rehearsal_ingest_events(uuid,jsonb) to service_role;
