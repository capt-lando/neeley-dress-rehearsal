-- Local recovery audio is ciphertext. Its independent key is available only
-- through the authenticated gateway for the exact owner/session pair.
create extension if not exists pgcrypto with schema extensions;

alter table rehearsal_private.live_sessions
  add column draft_key text check(draft_key is null or draft_key ~ '^[A-Za-z0-9_-]{43}$'),
  add column draft_key_expires_at timestamptz,
  add constraint live_draft_key_pair check((draft_key is null)=(draft_key_expires_at is null));

create or replace function public.rehearsal_stream_start(p_user uuid,p_recording uuid,p_request uuid,p_title text,p_hash text,p_cost bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous rehearsal_private.live_sessions; key_value text; key_expiry timestamptz;
begin
  perform 1 from rehearsal_private.limits where singleton for update;
  select * into previous from rehearsal_private.live_sessions where recording_id=p_recording;
  if found and previous.transport<>'openai-stream' then raise exception 'request_conflict'; end if;
  result:=public.rehearsal_live_start(p_user,p_recording,p_request,p_title,p_hash,p_cost);
  update rehearsal_private.live_sessions set transport='openai-stream',prepare_state='completed',
    draft_key=case when audio_finalized then null else coalesce(draft_key,translate(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+/','-_')) end,
    draft_key_expires_at=case when audio_finalized then null else coalesce(draft_key_expires_at,clock_timestamp()+interval '24 hours') end
    where recording_id=p_recording and user_id=p_user returning draft_key,draft_key_expires_at into key_value,key_expiry;
  return result||jsonb_build_object('transport','openai-stream','prepare_state','completed','draft_key',key_value,'draft_key_expires_at',key_expiry);
end $$;

create function public.rehearsal_live_draft_key(p_user uuid,p_recording uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session rehearsal_private.live_sessions;
begin
  if p_user is null or p_recording is null or p_request is null then raise exception 'invalid_request'; end if;
  select s.* into session from rehearsal_private.live_sessions s
    join public.rehearsal_recordings r on r.id=s.recording_id and r.user_id=s.user_id
    where s.recording_id=p_recording and s.user_id=p_user and s.request_id=p_request
      and s.transport='openai-stream' and not s.audio_finalized and r.status<>'deleting'
      and s.draft_key is not null and s.draft_key_expires_at>clock_timestamp();
  -- Foreign owners, wrong requests, finalized/deleted sessions and expired keys
  -- have the same response; none discloses whether another user's key exists.
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('draft_key',session.draft_key);
end $$;

create function rehearsal_private.clear_finalized_draft_key()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.audio_finalized then new.draft_key:=null;new.draft_key_expires_at:=null;end if;
  return new;
end $$;
create trigger clear_finalized_draft_key before update on rehearsal_private.live_sessions
  for each row execute function rehearsal_private.clear_finalized_draft_key();

revoke all on function public.rehearsal_stream_start(uuid,uuid,uuid,text,text,bigint),
  public.rehearsal_live_draft_key(uuid,uuid,uuid),rehearsal_private.clear_finalized_draft_key() from public,anon,authenticated;
grant execute on function public.rehearsal_stream_start(uuid,uuid,uuid,text,text,bigint),
  public.rehearsal_live_draft_key(uuid,uuid,uuid) to service_role;
