-- Support fifteen minutes of validated mono PCM audio without changing saved
-- recording quotas, request counts, budget settings, or prior usage debits.
-- A 900-second 16kHz PCM16 WAV is 28,800,044 bytes; 30MiB leaves header room.
alter table public.rehearsal_recordings
  drop constraint rehearsal_recordings_duration_seconds_check,
  add constraint rehearsal_recordings_duration_seconds_check check(duration_seconds between 0.5 and 900),
  drop constraint rehearsal_recordings_size_bytes_check,
  add constraint rehearsal_recordings_size_bytes_check check(size_bytes between 44 and 31457280);
update storage.buckets set file_size_limit=31457280 where id='recordings';

-- The managed stream uses 24kHz PCM16. Keep each provider connection bounded
-- at 110 audio seconds / 120 wall seconds, with its existing 125-second lease.
-- Eighteen rotations and an eighteen-minute session allow bounded pauses and
-- final upload time. Existing sessions keep their originally issued deadlines;
-- replay never extends a session. The retired legacy chunk transport stays at
-- its historical ten-minute cap and has no current HTTP entry point.
alter table rehearsal_private.live_sessions
  alter column expires_at set default now()+interval '18 minutes',
  drop constraint live_sessions_stream_segments_check,
  add constraint live_sessions_stream_segments_check check(jsonb_typeof(stream_segments)='array' and jsonb_array_length(stream_segments)<=18),
  drop constraint live_sessions_stream_samples_check,
  add constraint live_sessions_stream_samples_check check(stream_samples between 0 and 21600000),
  drop constraint live_stream_audio_bound,
  add constraint live_stream_audio_bound check(stream_samples+stream_reserved_samples<=21600000);

create or replace function public.rehearsal_stream_claim(p_user uuid,p_recording uuid,p_request uuid,p_sequence integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; previous jsonb; cap integer;
begin
  if p_user is null or p_recording is null or p_request is null or p_sequence is null or p_sequence not between 0 and 17 then raise exception 'invalid_request'; end if;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if session.request_id<>p_request or session.transport<>'openai-stream' then raise exception 'request_conflict'; end if;
  if session.status<>'active' or session.expires_at<=clock_timestamp() then raise exception 'live_closed'; end if;
  previous:=session.stream_segments->p_sequence;
  if previous is not null then
    return previous||jsonb_build_object('maxSamples',(previous->>'cap')::integer,'consumedSamples',session.stream_samples,
      'transcript',session.transcript,'nextSequence',session.next_sequence);
  end if;
  if session.stream_reserved_samples<>0 or session.next_sequence<>p_sequence or jsonb_array_length(session.stream_segments)<>p_sequence then raise exception 'live_order'; end if;
  cap:=least(2640000,21600000-session.stream_samples);
  if cap<=0 then raise exception 'live_duration'; end if;
  -- Charge the entire possible segment before opening a provider connection.
  -- Only a confirmed completion settles to actual samples. Failure keeps debit.
  update rehearsal_private.live_sessions set stream_reserved_samples=cap,
    stream_segments=stream_segments||jsonb_build_array(jsonb_build_object('state','reserved','cap',cap,'expiresAt',clock_timestamp()+interval '125 seconds')) where recording_id=p_recording;
  return jsonb_build_object('state','new','maxSamples',cap,'consumedSamples',session.stream_samples,'transcript',session.transcript,'nextSequence',p_sequence);
end $$;

create or replace function public.rehearsal_stream_finish(p_user uuid,p_recording uuid,p_request uuid,p_sequence integer,p_text text,p_samples integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; previous jsonb; combined text; result jsonb;
begin
  if p_user is null or p_recording is null or p_request is null or p_sequence is null or p_sequence not between 0 and 17 or p_text is null or char_length(p_text)>60000
    or p_samples is null or p_samples not between 0 and 2640000 or (p_samples=0 and btrim(p_text)<>'') then raise exception 'invalid_request'; end if;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if session.request_id<>p_request or session.transport<>'openai-stream' then raise exception 'request_conflict'; end if;
  previous:=session.stream_segments->p_sequence;
  if session.status<>'active' or session.expires_at<=clock_timestamp() then raise exception 'live_closed'; end if;
  if previous->>'state'='completed' then
    if previous->>'text'<>btrim(p_text) or (previous->>'samples')::integer<>p_samples then raise exception 'request_conflict'; end if;
    return previous||jsonb_build_object('transcript',session.transcript,'nextSequence',session.next_sequence,'consumedSamples',session.stream_samples);
  end if;
  if previous->>'state' is distinct from 'reserved' or session.next_sequence<>p_sequence
    or p_samples>(previous->>'cap')::integer then raise exception 'live_order'; end if;
  combined:=concat_ws(' ',nullif(session.transcript,''),nullif(btrim(p_text),''));
  if char_length(combined)>60000 or session.stream_samples+p_samples>21600000 then raise exception 'invalid_request'; end if;
  result:=previous||jsonb_build_object('state','completed','text',btrim(p_text),'samples',p_samples);
  update rehearsal_private.live_sessions set stream_reserved_samples=0,stream_samples=stream_samples+p_samples,
    next_sequence=next_sequence+1,transcript=combined,stream_segments=jsonb_set(stream_segments,array[p_sequence::text],result) where recording_id=p_recording;
  return result||jsonb_build_object('transcript',combined,'nextSequence',p_sequence+1,'consumedSamples',session.stream_samples+p_samples);
end $$;

create or replace function public.rehearsal_stream_fail(p_user uuid,p_recording uuid,p_request uuid,p_sequence integer)
returns void language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions;
begin
  if p_user is null or p_recording is null or p_request is null then raise exception 'invalid_request'; end if;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if session.request_id<>p_request or session.transport<>'openai-stream' then raise exception 'request_conflict'; end if;
  if p_sequence is null or p_sequence not between 0 and 17 then raise exception 'invalid_request'; end if;
  if session.stream_segments->p_sequence->>'state'='reserved' then
    update rehearsal_private.live_sessions set stream_segments=jsonb_set(stream_segments,array[p_sequence::text,'state'],
      to_jsonb(case when session.status='active' then 'failed'::text else 'cancelled'::text end)) where recording_id=p_recording;
    if session.status='active' then perform public.rehearsal_live_close(p_user,p_recording,false); end if;
  end if;
end $$;

create or replace function public.rehearsal_stream_finalize(p_user uuid,p_recording uuid,p_duration double precision,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions; recording public.rehearsal_recordings; complete boolean; output jsonb;
begin
  -- Same outer lock as cancellation and admission: late socket results cannot
  -- publish after cancellation wins, and saved audio is never deleted here.
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into session from rehearsal_private.live_sessions where recording_id=p_recording and user_id=p_user for update;
  if not found then raise exception 'not_found'; end if;
  if session.transport<>'openai-stream' then raise exception 'request_conflict'; end if;
  select * into recording from public.rehearsal_recordings where id=p_recording and user_id=p_user for update;
  if recording.status='deleting' then raise exception 'live_closed'; end if;
  if p_duration is null or p_duration not between 0.5 and 900 or p_size is null or p_size<>44+(p_duration*32000)::integer then raise exception 'invalid_request'; end if;
  if session.audio_finalized then
    if recording.size_bytes<>p_size or abs(recording.duration_seconds-p_duration)>0.0001 then raise exception 'request_conflict'; end if;
    return jsonb_build_object('complete',session.status='completed','text',case when session.status='completed' then session.transcript else '' end);
  end if;
  if session.status='active' and session.stream_reserved_samples>0 then raise exception 'request_busy'; end if;
  complete:=session.status='active' and session.expires_at>clock_timestamp() and session.next_sequence>0
    and abs(session.stream_samples/24000.0-p_duration)<=0.1;
  if session.status='active' and not complete then raise exception 'live_duration'; end if;
  if not complete and recording.status in ('transcribed','analyzed') then
    -- An old failed-stream response cannot erase a later successful batch retry.
    update rehearsal_private.live_sessions set audio_finalized=true where recording_id=p_recording;
    return jsonb_build_object('complete',false,'text','');
  end if;
  update public.rehearsal_recordings set duration_seconds=p_duration,size_bytes=p_size,status=case when complete then 'transcribed' else 'pending' end,
    transcript=case when complete then session.transcript else null end,report=null,updated_at=now() where id=p_recording;
  update rehearsal_private.live_sessions set status=case when complete then 'completed' else status end,audio_finalized=true where recording_id=p_recording;
  output:=jsonb_build_object('complete',complete,'text',case when complete then session.transcript else '' end);
  perform public.rehearsal_finish(p_user,session.request_id,complete,output);
  return output;
end $$;

revoke all on function public.rehearsal_stream_claim(uuid,uuid,uuid,integer),
  public.rehearsal_stream_finish(uuid,uuid,uuid,integer,text,integer),public.rehearsal_stream_fail(uuid,uuid,uuid,integer),
  public.rehearsal_stream_finalize(uuid,uuid,double precision,integer) from public,anon,authenticated;
grant execute on function public.rehearsal_stream_claim(uuid,uuid,uuid,integer),
  public.rehearsal_stream_finish(uuid,uuid,uuid,integer,text,integer),public.rehearsal_stream_fail(uuid,uuid,uuid,integer),
  public.rehearsal_stream_finalize(uuid,uuid,double precision,integer) to service_role;
