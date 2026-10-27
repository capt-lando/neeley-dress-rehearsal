alter table rehearsal_private.jobs drop constraint jobs_status_check;
alter table rehearsal_private.jobs add constraint jobs_status_check check(status in ('reserved','completed','failed','cancelled'));

create table rehearsal_private.request_cancellations (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  recording_id uuid not null references public.rehearsal_recordings(id) on delete cascade,
  expires_at timestamptz not null default now()+interval '24 hours',
  primary key(user_id,request_id)
);
alter table rehearsal_private.request_cancellations enable row level security;
revoke all on rehearsal_private.request_cancellations from public,anon,authenticated;
create index rehearsal_request_cancellation_expiry on rehearsal_private.request_cancellations(expires_at);

create function public.rehearsal_cancel_request(p_user uuid,p_recording uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job rehearsal_private.jobs; previous rehearsal_private.request_cancellations;
begin
  if p_user is null or p_recording is null or p_request is null then raise exception 'invalid_request'; end if;
  perform 1 from rehearsal_private.limits where singleton for update;
  if not exists(select 1 from public.rehearsal_recordings where id=p_recording and user_id=p_user and status<>'deleting') then raise exception 'not_found'; end if;
  select * into job from rehearsal_private.jobs where user_id=p_user and request_id=p_request for update;
  if found then
    if job.recording_id<>p_recording then raise exception 'request_conflict'; end if;
    if exists(select 1 from rehearsal_private.live_sessions where user_id=p_user and request_id=p_request) then raise exception 'request_conflict'; end if;
    if job.status='reserved' then
      update rehearsal_private.jobs set status='cancelled',finished_at=now(),response=null where user_id=p_user and request_id=p_request;
      job.status:='cancelled';
    end if;
    return jsonb_build_object('state',job.status,'kind',job.kind);
  end if;
  delete from rehearsal_private.request_cancellations where expires_at<=now();
  select * into previous from rehearsal_private.request_cancellations where user_id=p_user and request_id=p_request;
  if found then
    if previous.recording_id<>p_recording then raise exception 'request_conflict'; end if;
  else
    if (select count(*) from rehearsal_private.request_cancellations where user_id=p_user)>=100
      or (select count(*) from rehearsal_private.request_cancellations)>=10000 then raise exception 'recovery_limit'; end if;
    insert into rehearsal_private.request_cancellations(user_id,recording_id,request_id) values(p_user,p_recording,p_request);
  end if;
  return jsonb_build_object('state','cancelled','kind',null);
end $$;

create or replace function public.rehearsal_reserve(p_user uuid,p_recording uuid,p_request uuid,p_kind text,p_hash text,p_cost bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare limits rehearsal_private.limits; previous rehearsal_private.jobs; daily bigint; used integer; today date := (now() at time zone 'UTC')::date;
begin
  if p_cost is null or p_cost<=0 or p_cost>100000000 or p_kind not in ('transcribe','coach') or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request'; end if;
  select * into limits from rehearsal_private.limits where singleton for update;
  if not exists(select 1 from public.rehearsal_recordings where id=p_recording and user_id=p_user and status<>'deleting' for update) then raise exception 'not_found'; end if;
  delete from rehearsal_private.request_cancellations where expires_at<=now();
  if exists(select 1 from rehearsal_private.request_cancellations where user_id=p_user and request_id=p_request) then raise exception 'request_cancelled'; end if;
  select * into previous from rehearsal_private.jobs where user_id=p_user and request_id=p_request;
  if found then
    if previous.recording_id<>p_recording or previous.kind<>p_kind or previous.input_hash<>p_hash then raise exception 'request_conflict'; end if;
    return jsonb_build_object('state',previous.status,'response',previous.response);
  end if;
  if exists(select 1 from rehearsal_private.live_sessions where user_id=p_user and status='active' and expires_at>now()) then raise exception 'request_busy'; end if;
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

-- Recording writes and job completion commit together under the cancellation
-- lock. A response from canceled inference can never overwrite a saved take.
create function public.rehearsal_complete_request(p_user uuid,p_request uuid,p_response jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job rehearsal_private.jobs;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into job from rehearsal_private.jobs where user_id=p_user and request_id=p_request for update;
  if not found then raise exception 'not_found'; end if;
  if job.status='cancelled' then raise exception 'request_cancelled'; end if;
  if job.status='completed' then return job.response; end if;
  if job.status<>'reserved' then raise exception 'request_conflict'; end if;
  if p_response is null or jsonb_typeof(p_response)<>'object' then raise exception 'invalid_request'; end if;
  if not exists(select 1 from public.rehearsal_recordings where id=job.recording_id and user_id=p_user and status<>'deleting' for update) then raise exception 'not_found'; end if;
  if job.kind='transcribe' then
    update public.rehearsal_recordings set status='transcribed',transcript=p_response->>'text',
      duration_seconds=(p_response->>'durationSeconds')::double precision,report=null,updated_at=now()
      where id=job.recording_id and user_id=p_user;
  else
    update public.rehearsal_recordings set status='analyzed',transcript=p_response->>'transcript',report=p_response,updated_at=now()
      where id=job.recording_id and user_id=p_user;
  end if;
  update rehearsal_private.jobs set status='completed',response=p_response,finished_at=now() where user_id=p_user and request_id=p_request;
  return p_response;
end $$;

revoke all on function public.rehearsal_cancel_request(uuid,uuid,uuid),public.rehearsal_complete_request(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.rehearsal_cancel_request(uuid,uuid,uuid),public.rehearsal_complete_request(uuid,uuid,jsonb) to service_role;
