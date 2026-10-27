-- One paid admission and one private recording for an entire live rehearsal.
-- Chunks are private idempotency records, never independent quota entries.
create table rehearsal_private.live_sessions (
  recording_id uuid primary key references public.rehearsal_recordings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  status text not null default 'active' check (status in ('active','completed','failed','cancelled')),
  prepare_state text not null default 'idle' check (prepare_state in ('idle','reserved','completed','failed')),
  expires_at timestamptz not null default now()+interval '12 minutes',
  next_sequence integer not null default 0 check (next_sequence between 0 and 60),
  samples integer not null default 0 check (samples between 0 and 9600000),
  final_received boolean not null default false,
  chunks jsonb not null default '[]'::jsonb check (jsonb_typeof(chunks)='array' and jsonb_array_length(chunks)<=60),
  transcript text not null default '' check (char_length(transcript)<=60000),
  audio_finalized boolean not null default false,
  unique(user_id,request_id),
  foreign key(user_id,request_id) references rehearsal_private.jobs(user_id,request_id) on delete cascade
);
alter table rehearsal_private.live_sessions enable row level security;
revoke all on rehearsal_private.live_sessions from public, anon, authenticated;
create index rehearsal_live_owner on rehearsal_private.live_sessions(user_id,status,expires_at);

create function public.rehearsal_live_start(p_user uuid,p_recording uuid,p_request uuid,p_title text,p_hash text,p_cost bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; recording public.rehearsal_recordings; admission jsonb;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording;
  if found then
    select * into recording from public.rehearsal_recordings where id=p_recording;
    if session.user_id<>p_user or session.request_id<>p_request or recording.title<>p_title then raise exception 'request_conflict'; end if;
    return to_jsonb(session)||jsonb_build_object('storage_path',recording.storage_path);
  end if;
  if exists(select 1 from rehearsal_private.live_sessions where user_id=p_user and status='active' and expires_at>now()) then raise exception 'request_busy'; end if;
  -- An abandoned session cannot indefinitely lock its owner. Debits are retained.
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

create function public.rehearsal_live_get(p_user uuid,p_recording uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions;
begin
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user;
  if not found then raise exception 'not_found'; end if;
  return to_jsonb(session);
end $$;

create function public.rehearsal_live_prepare(p_user uuid,p_recording uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions;
begin
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if session.prepare_state='completed' then return jsonb_build_object('state','completed'); end if;
  if session.status<>'active' or session.expires_at<=now() then raise exception 'live_closed'; end if;
  if session.prepare_state<>'idle' then return jsonb_build_object('state',session.prepare_state); end if;
  update rehearsal_private.live_sessions set prepare_state='reserved' where recording_id=p_recording;
  return jsonb_build_object('state','new');
end $$;

create function public.rehearsal_live_prepared(p_user uuid,p_recording uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  update rehearsal_private.live_sessions set prepare_state='completed'
    where recording_id=p_recording and user_id=p_user and status='active' and prepare_state='reserved';
  if not found then raise exception 'live_closed'; end if;
end $$;

create function public.rehearsal_live_chunk(p_user uuid,p_recording uuid,p_sequence integer,p_hash text,p_samples integer,p_final boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; previous jsonb;
begin
  if p_sequence is null or p_sequence not between 0 and 59 or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
    or p_samples is null or p_samples not between 1 and 160000 or p_final is null or (not p_final and p_samples<>160000) then raise exception 'invalid_request'; end if;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  previous:=session.chunks->p_sequence;
  if previous is not null then
    if previous->>'hash'<>p_hash or (previous->>'samples')::integer<>p_samples or (previous->>'final')::boolean<>p_final then raise exception 'request_conflict'; end if;
    return previous;
  end if;
  if session.status<>'active' or session.expires_at<=now() then raise exception 'live_closed'; end if;
  if session.prepare_state<>'completed' then raise exception 'request_busy'; end if;
  if session.final_received or session.next_sequence<>p_sequence or jsonb_array_length(session.chunks)<>p_sequence then raise exception 'live_order'; end if;
  if session.samples+p_samples>9600000 then raise exception 'live_duration'; end if;
  update rehearsal_private.live_sessions set samples=samples+p_samples,final_received=p_final,
    chunks=chunks||jsonb_build_array(jsonb_build_object('state','reserved','hash',p_hash,'samples',p_samples,'final',p_final))
    where recording_id=p_recording;
  return jsonb_build_object('state','new');
end $$;

create function public.rehearsal_live_chunk_done(p_user uuid,p_recording uuid,p_sequence integer,p_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; previous jsonb; combined_text text; result jsonb;
begin
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  previous:=session.chunks->p_sequence;
  if previous->>'state'='completed' then return previous; end if;
  if session.status<>'active' or previous->>'state' is distinct from 'reserved' or session.next_sequence<>p_sequence then raise exception 'live_closed'; end if;
  combined_text:=concat_ws(' ',nullif(session.transcript,''),nullif(btrim(p_text),''));
  if p_text is null or char_length(combined_text)>60000 then raise exception 'invalid_request'; end if;
  result:=previous||jsonb_build_object('state','completed','text',btrim(p_text));
  update rehearsal_private.live_sessions set next_sequence=next_sequence+1,transcript=combined_text,
    chunks=jsonb_set(chunks,array[p_sequence::text],result) where recording_id=p_recording;
  return result;
end $$;

create function public.rehearsal_live_close(p_user uuid,p_recording uuid,p_cancel boolean)
returns void language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions;
begin
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if session.status='active' then
    update rehearsal_private.live_sessions set status=case when p_cancel then 'cancelled' else 'failed' end,
      prepare_state=case when prepare_state='reserved' then 'failed' else prepare_state end where recording_id=p_recording;
    perform public.rehearsal_finish(p_user,session.request_id,false,null);
  end if;
end $$;

create function public.rehearsal_live_finish(p_user uuid,p_recording uuid,p_duration double precision,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; complete boolean; output jsonb; recording public.rehearsal_recordings;
begin
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  select * into recording from public.rehearsal_recordings where id=p_recording and user_id=p_user for update;
  if recording.status='deleting' then raise exception 'live_closed'; end if;
  if p_duration is null or p_duration not between 0.5 and 600 or p_size is null or p_size<>44+(p_duration*32000)::integer then raise exception 'invalid_request'; end if;
  if session.audio_finalized then
    if recording.size_bytes<>p_size or abs(recording.duration_seconds-p_duration)>0.0001 then raise exception 'request_conflict'; end if;
    return jsonb_build_object('complete',session.status='completed','text',case when session.status='completed' then session.transcript else '' end);
  end if;
  if session.status='active' and (session.prepare_state='reserved' or exists(select 1 from jsonb_array_elements(session.chunks) c where c->>'state'='reserved')) then raise exception 'request_busy'; end if;
  complete:=session.status='active' and session.next_sequence>0 and session.samples=(p_size-44)/2;
  if session.status='active' and not complete then raise exception 'live_duration'; end if;
  update public.rehearsal_recordings set duration_seconds=p_duration,size_bytes=p_size,
    status=case when complete then 'transcribed' else 'pending' end,
    transcript=case when complete then session.transcript else null end,report=null,updated_at=now() where id=p_recording;
  update rehearsal_private.live_sessions set status=case when complete then 'completed' else status end,audio_finalized=true where recording_id=p_recording;
  output:=jsonb_build_object('complete',complete,'text',case when complete then session.transcript else '' end);
  perform public.rehearsal_finish(p_user,session.request_id,complete,output);
  return output;
end $$;

revoke all on function public.rehearsal_live_start(uuid,uuid,uuid,text,text,bigint),public.rehearsal_live_get(uuid,uuid),public.rehearsal_live_prepare(uuid,uuid),public.rehearsal_live_prepared(uuid,uuid),public.rehearsal_live_chunk(uuid,uuid,integer,text,integer,boolean),public.rehearsal_live_chunk_done(uuid,uuid,integer,text),public.rehearsal_live_close(uuid,uuid,boolean),public.rehearsal_live_finish(uuid,uuid,double precision,integer) from public, anon, authenticated;
grant execute on function public.rehearsal_live_start(uuid,uuid,uuid,text,text,bigint),public.rehearsal_live_get(uuid,uuid),public.rehearsal_live_prepare(uuid,uuid),public.rehearsal_live_prepared(uuid,uuid),public.rehearsal_live_chunk(uuid,uuid,integer,text,integer,boolean),public.rehearsal_live_chunk_done(uuid,uuid,integer,text),public.rehearsal_live_close(uuid,uuid,boolean),public.rehearsal_live_finish(uuid,uuid,double precision,integer) to service_role;

-- Live leases also protect ordinary batch admission and deletion.
create or replace function public.rehearsal_reserve(p_user uuid,p_recording uuid,p_request uuid,p_kind text,p_hash text,p_cost bigint)
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

create or replace function public.rehearsal_prepare_delete(p_user uuid,p_recording uuid)
returns text language plpgsql security definer set search_path='' as $$
declare path text;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select storage_path into path from public.rehearsal_recordings where id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if exists(select 1 from rehearsal_private.live_sessions where recording_id=p_recording and status='active' and expires_at>now()) then raise exception 'request_busy'; end if;
  if exists(select 1 from rehearsal_private.jobs where recording_id=p_recording and status='reserved' and created_at>now()-interval '10 minutes') then raise exception 'request_busy'; end if;
  update public.rehearsal_recordings set status='deleting',updated_at=now() where id=p_recording;
  return path;
end $$;
