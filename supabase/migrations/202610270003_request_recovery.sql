-- Read an already admitted request after a browser refresh without another AI
-- reservation or requiring the student's preparation text to be stored locally.
create function public.rehearsal_get_request(p_user uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job rehearsal_private.jobs; expired boolean;
begin
  select j.* into job from rehearsal_private.jobs j
    join public.rehearsal_recordings r on r.id=j.recording_id and r.user_id=j.user_id
    where j.user_id=p_user and j.request_id=p_request and r.status<>'deleting';
  if not found then raise exception 'not_found'; end if;
  -- Match admission's lease windows without modifying jobs or refunding debits.
  -- Live sessions have a longer lease than ordinary batch requests.
  expired:=job.status='reserved' and job.created_at<=now()-interval '10 minutes'
    and not exists(select 1 from rehearsal_private.live_sessions s
      where s.user_id=p_user and s.request_id=p_request and s.status='active' and s.expires_at>now());
  return jsonb_build_object('recording_id',job.recording_id,'kind',job.kind,
    'state',case when expired then 'expired' else job.status end,
    'created_at',job.created_at,'finished_at',job.finished_at,
    'response',case when job.status='completed' then job.response else null end);
end $$;

revoke all on function public.rehearsal_get_request(uuid,uuid) from public, anon, authenticated;
grant execute on function public.rehearsal_get_request(uuid,uuid) to service_role;

-- A refresh can reach cancellation before the original start request commits.
-- These content-free tombstones stop that delayed start from creating a lease.
create table rehearsal_private.live_cancellations (
  user_id uuid not null references auth.users(id) on delete cascade,
  recording_id uuid not null,
  request_id uuid not null,
  expires_at timestamptz not null default now()+interval '24 hours',
  primary key(user_id,recording_id),
  unique(user_id,request_id)
);
alter table rehearsal_private.live_cancellations enable row level security;
revoke all on rehearsal_private.live_cancellations from public,anon,authenticated;
create index rehearsal_live_cancellation_expiry on rehearsal_private.live_cancellations(expires_at);

create function public.rehearsal_live_cancel(p_user uuid,p_recording uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; recording public.rehearsal_recordings; saved boolean;
begin
  if p_user is null or p_recording is null or p_request is null then raise exception 'invalid_request'; end if;
  -- Use the same admission lock as live_start. Either start wins and we close
  -- that exact lease, or cancellation wins and delayed start cannot reserve.
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording for update;
  if found then
    if session.user_id<>p_user then raise exception 'not_found'; end if;
    if session.request_id<>p_request then raise exception 'request_conflict'; end if;
    perform public.rehearsal_live_close(p_user,p_recording,true);
    select * into session from rehearsal_private.live_sessions where recording_id=p_recording;
    select exists(select 1 from storage.objects o join public.rehearsal_recordings r
      on o.bucket_id='recordings' and o.name=r.storage_path
      where r.id=p_recording and r.user_id=p_user and r.status<>'deleting') into saved;
    return jsonb_build_object('status',session.status,'audio_saved',saved);
  end if;
  select * into recording from public.rehearsal_recordings where id=p_recording;
  if found then
    if recording.user_id<>p_user then raise exception 'not_found'; end if;
    raise exception 'request_conflict';
  end if;
  if exists(select 1 from rehearsal_private.jobs where user_id=p_user and request_id=p_request) then raise exception 'request_conflict'; end if;
  delete from rehearsal_private.live_cancellations where expires_at<=now();
  if exists(select 1 from rehearsal_private.live_cancellations where user_id=p_user
    and (recording_id=p_recording or request_id=p_request) and (recording_id<>p_recording or request_id<>p_request)) then raise exception 'request_conflict'; end if;
  if not exists(select 1 from rehearsal_private.live_cancellations where user_id=p_user and recording_id=p_recording and request_id=p_request) then
    if (select count(*) from rehearsal_private.live_cancellations where user_id=p_user)>=100
      or (select count(*) from rehearsal_private.live_cancellations)>=10000 then raise exception 'recovery_limit'; end if;
    insert into rehearsal_private.live_cancellations(user_id,recording_id,request_id) values(p_user,p_recording,p_request);
  end if;
  return jsonb_build_object('status','cancelled','audio_saved',false);
end $$;
revoke all on function public.rehearsal_live_cancel(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.rehearsal_live_cancel(uuid,uuid,uuid) to service_role;

create or replace function public.rehearsal_live_start(p_user uuid,p_recording uuid,p_request uuid,p_title text,p_hash text,p_cost bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; recording public.rehearsal_recordings; admission jsonb;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  delete from rehearsal_private.live_cancellations where expires_at<=now();
  if exists(select 1 from rehearsal_private.live_cancellations where user_id=p_user
    and (recording_id=p_recording or request_id=p_request)) then raise exception 'live_closed'; end if;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording;
  if found then
    select * into recording from public.rehearsal_recordings where id=p_recording;
    if session.user_id<>p_user or session.request_id<>p_request or recording.title<>p_title then raise exception 'request_conflict'; end if;
    return to_jsonb(session)||jsonb_build_object('storage_path',recording.storage_path);
  end if;
  if exists(select 1 from rehearsal_private.live_sessions where user_id=p_user and status='active' and expires_at>now()) then raise exception 'request_busy'; end if;
  update rehearsal_private.jobs j set status='failed',finished_at=now()
    from rehearsal_private.live_sessions s where s.user_id=p_user and s.status='active' and s.expires_at<=now()
      and j.user_id=s.user_id and j.request_id=s.request_id and j.status='reserved';
  update rehearsal_private.live_sessions set status='failed' where user_id=p_user and status='active' and expires_at<=now();
  if exists(select 1 from public.rehearsal_recordings where id=p_recording) then raise exception 'request_conflict'; end if;
  select * into recording from public.rehearsal_create_recording(p_user,p_recording,p_title,0.5,16044);
  admission:=public.rehearsal_reserve(p_user,p_recording,p_request,'transcribe',p_hash,p_cost);
  if admission->>'state'<>'new' then raise exception 'request_conflict'; end if;
  insert into rehearsal_private.live_sessions(recording_id,user_id,request_id) values(p_recording,p_user,p_request) returning * into session;
  return to_jsonb(session)||jsonb_build_object('storage_path',recording.storage_path);
end $$;
