-- Chat content exists only in the current browser session and an active request.
-- Preserve admission receipts for duplicate prevention without retaining replies.
drop function public.rehearsal_chat_complete(uuid,uuid,jsonb);
alter table rehearsal_private.chat_jobs drop column response;

create or replace function public.rehearsal_chat_reserve(p_user uuid,p_recording uuid,p_request uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings rehearsal_private.limits; prior rehearsal_private.chat_jobs; usage rehearsal_private.chat_daily_usage;
  today date := (now() at time zone 'UTC')::date; this_minute timestamptz := date_trunc('minute',now()); daily bigint;
begin
  if p_user is null or p_request is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request'; end if;
  select * into settings from rehearsal_private.limits where singleton for update;
  if p_recording is not null and not exists(select 1 from public.rehearsal_recordings where id=p_recording and user_id=p_user and status<>'deleting' and not upload_expired for update) then raise exception 'not_found'; end if;
  update rehearsal_private.chat_jobs set status='expired',finished_at=now()
    where status='reserved' and created_at<=now()-interval '90 seconds';
  select * into prior from rehearsal_private.chat_jobs where user_id=p_user and request_id=p_request;
  if found then
    if prior.recording_id is distinct from p_recording or prior.input_hash<>p_hash then raise exception 'request_conflict'; end if;
    if prior.status='expired' then raise exception 'chat_expired'; end if;
    return jsonb_build_object('state',prior.status);
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

create function public.rehearsal_chat_complete(p_user uuid,p_request uuid)
returns void language plpgsql security definer set search_path='' as $$
declare job rehearsal_private.chat_jobs;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into job from rehearsal_private.chat_jobs where user_id=p_user and request_id=p_request for update;
  if not found then raise exception 'not_found'; end if;
  if job.status='completed' then return; end if;
  if job.status<>'reserved' or job.created_at<=now()-interval '90 seconds' then raise exception 'chat_expired'; end if;
  if job.recording_id is not null and not exists(select 1 from public.rehearsal_recordings where id=job.recording_id and user_id=p_user and status<>'deleting' for update) then raise exception 'not_found'; end if;
  update rehearsal_private.chat_jobs set status='completed',finished_at=now() where user_id=p_user and request_id=p_request;
end $$;

revoke all on function public.rehearsal_chat_reserve(uuid,uuid,uuid,text),public.rehearsal_chat_complete(uuid,uuid) from public,anon,authenticated;
grant execute on function public.rehearsal_chat_reserve(uuid,uuid,uuid,text),public.rehearsal_chat_complete(uuid,uuid) to service_role;

-- Remove prior conversation metadata from saved reports and recovery copies.
update public.rehearsal_recordings set report=report #- '{meta,rehearsalContext}' #- '{input,rehearsalContext}'
  where (report->'meta') ? 'rehearsalContext' or (report->'input') ? 'rehearsalContext';
update rehearsal_private.jobs set response=response #- '{meta,rehearsalContext}' #- '{input,rehearsalContext}'
  where (response->'meta') ? 'rehearsalContext' or (response->'input') ? 'rehearsalContext';
-- Older in-flight code must not restore this field after the cleanup commits.
alter table public.rehearsal_recordings add constraint rehearsal_no_saved_chat
  check (not coalesce((report->'meta') ? 'rehearsalContext',false) and not coalesce((report->'input') ? 'rehearsalContext',false));
alter table rehearsal_private.jobs add constraint rehearsal_no_chat_recovery
  check (not coalesce((response->'meta') ? 'rehearsalContext',false) and not coalesce((response->'input') ? 'rehearsalContext',false));
