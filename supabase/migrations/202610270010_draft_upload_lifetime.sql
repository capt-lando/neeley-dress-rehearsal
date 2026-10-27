-- A recoverable encrypted draft must retain its existing private upload slot
-- for the same bounded lifetime. Other upload reservations stay at one hour.
create function rehearsal_private.retain_draft_upload_lease()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.draft_key is not null and new.draft_key_expires_at is not null then
    update public.rehearsal_recordings set upload_expires_at=greatest(upload_expires_at,new.draft_key_expires_at)
      where id=new.recording_id and user_id=new.user_id and status='pending' and not upload_expired;
  end if;
  return new;
end $$;
create trigger retain_draft_upload_lease after insert or update of draft_key,draft_key_expires_at on rehearsal_private.live_sessions
  for each row execute function rehearsal_private.retain_draft_upload_lease();
revoke all on function rehearsal_private.retain_draft_upload_lease() from public,anon,authenticated;

update public.rehearsal_recordings r set upload_expires_at=greatest(r.upload_expires_at,s.draft_key_expires_at)
  from rehearsal_private.live_sessions s where s.recording_id=r.id and s.user_id=r.user_id
    and s.draft_key is not null and s.draft_key_expires_at>clock_timestamp() and r.status='pending' and not r.upload_expired;
