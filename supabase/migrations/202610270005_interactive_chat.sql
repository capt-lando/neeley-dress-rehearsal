-- A chat reply is separate from a paid analysis, but shares the same atomic
-- project budget. No browser role can call these functions or read chat cache.
create table rehearsal_private.chat_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  recording_id uuid references public.rehearsal_recordings(id) on delete cascade,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'reserved' check (status in ('reserved','completed','failed','expired')),
  response jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (user_id,request_id)
);
create index rehearsal_chat_jobs_created on rehearsal_private.chat_jobs(created_at);
create table rehearsal_private.chat_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  request_count integer not null default 0 check (request_count>=0),
  minute timestamptz not null default date_trunc('minute',now()),
  minute_count integer not null default 0 check (minute_count>=0),
  primary key (user_id,day)
);
alter table rehearsal_private.chat_jobs enable row level security;
alter table rehearsal_private.chat_daily_usage enable row level security;
revoke all on rehearsal_private.chat_jobs,rehearsal_private.chat_daily_usage from public,anon,authenticated;

create function public.rehearsal_chat_reserve(p_user uuid,p_recording uuid,p_request uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings rehearsal_private.limits; prior rehearsal_private.chat_jobs; usage rehearsal_private.chat_daily_usage;
  today date := (now() at time zone 'UTC')::date; this_minute timestamptz := date_trunc('minute',now()); daily bigint;
begin
  if p_user is null or p_request is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request'; end if;
  -- Same lock as speech and analysis; concurrent functions cannot overspend.
  select * into settings from rehearsal_private.limits where singleton for update;
  if p_recording is not null and not exists(select 1 from public.rehearsal_recordings where id=p_recording and user_id=p_user and status<>'deleting' and not upload_expired for update) then raise exception 'not_found'; end if;
  -- Retain hashes as idempotency tombstones while expiring cached text in a day.
  update rehearsal_private.chat_jobs set status='expired',response=null,finished_at=coalesce(finished_at,now())
    where (status='reserved' and created_at<=now()-interval '90 seconds')
      or (status='completed' and created_at<=now()-interval '24 hours');
  select * into prior from rehearsal_private.chat_jobs where user_id=p_user and request_id=p_request;
  if found then
    if prior.recording_id is distinct from p_recording or prior.input_hash<>p_hash then raise exception 'request_conflict'; end if;
    if prior.status='expired' then raise exception 'chat_expired'; end if;
    return jsonb_build_object('state',prior.status,'response',prior.response);
  end if;
  if exists(select 1 from rehearsal_private.chat_jobs where user_id=p_user and status='reserved') then raise exception 'chat_busy'; end if;
  if (select count(*) from rehearsal_private.chat_jobs)>=10000 then raise exception 'chat_limit'; end if;
  insert into rehearsal_private.chat_daily_usage(user_id,day,minute) values(p_user,today,this_minute) on conflict do nothing;
  select * into usage from rehearsal_private.chat_daily_usage where user_id=p_user and day=today;
  if usage.request_count>=60 then raise exception 'chat_limit'; end if;
  if usage.minute=this_minute and usage.minute_count>=6 then raise exception 'rate_limited'; end if;
  insert into rehearsal_private.daily_usage(day) values(today) on conflict do nothing;
  select reserved_microusd into daily from rehearsal_private.daily_usage where day=today;
  if daily+20000>settings.daily_budget_microusd then raise exception 'budget_exhausted'; end if;
  update rehearsal_private.daily_usage set reserved_microusd=reserved_microusd+20000 where day=today;
  update rehearsal_private.chat_daily_usage set request_count=request_count+1,minute=this_minute,
    minute_count=case when minute=this_minute then minute_count+1 else 1 end where user_id=p_user and day=today;
  insert into rehearsal_private.chat_jobs(user_id,request_id,recording_id,input_hash) values(p_user,p_request,p_recording,p_hash);
  return jsonb_build_object('state','new');
end $$;

create function public.rehearsal_chat_complete(p_user uuid,p_request uuid,p_response jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job rehearsal_private.chat_jobs;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into job from rehearsal_private.chat_jobs where user_id=p_user and request_id=p_request for update;
  if not found then raise exception 'not_found'; end if;
  if job.status='completed' then return job.response; end if;
  if job.status<>'reserved' or job.created_at<=now()-interval '90 seconds' then raise exception 'chat_expired'; end if;
  if job.recording_id is not null and not exists(select 1 from public.rehearsal_recordings where id=job.recording_id and user_id=p_user and status<>'deleting' for update) then raise exception 'not_found'; end if;
  if p_response is null or jsonb_typeof(p_response)<>'object' or octet_length(p_response::text)>20000
    or p_response->>'requestId' is distinct from p_request::text or p_response->>'model' is distinct from 'gpt-6-luna'
    or jsonb_typeof(p_response->'reply') is distinct from 'string' or char_length(p_response->>'reply') not between 1 and 4000
    or (p_response - array['requestId','model','reply'])<>'{}'::jsonb then raise exception 'invalid_request'; end if;
  update rehearsal_private.chat_jobs set status='completed',response=p_response,finished_at=now() where user_id=p_user and request_id=p_request;
  return p_response;
end $$;

create function public.rehearsal_chat_fail(p_user uuid,p_request uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  update rehearsal_private.chat_jobs set status='failed',finished_at=now() where user_id=p_user and request_id=p_request and status='reserved';
  -- An uncertain provider call may be billed. Never refund its admission.
end $$;

revoke all on function public.rehearsal_chat_reserve(uuid,uuid,uuid,text),public.rehearsal_chat_complete(uuid,uuid,jsonb),public.rehearsal_chat_fail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.rehearsal_chat_reserve(uuid,uuid,uuid,text),public.rehearsal_chat_complete(uuid,uuid,jsonb),public.rehearsal_chat_fail(uuid,uuid) to service_role;
