begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Metadata-only fixtures; no provider or real audio object is created. All
-- allowance changes and synthetic rows disappear with the final rollback.
insert into auth.users(id,email) values
 ('f1111111-1111-4111-8111-111111111111','fifteen-minute@example.test');
update rehearsal_private.limits set daily_budget_microusd=coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)+1000000,
 requests_per_user_day=10,max_saved_recordings=10,max_total_recordings=100000;

select ok((select not public and file_size_limit=31457280 and allowed_mime_types=array['audio/wav'] from storage.buckets where id='recordings'),
 'private WAV bucket permits the 30MiB envelope required by fifteen minutes');
select lives_ok($$select public.rehearsal_create_recording('f1111111-1111-4111-8111-111111111111','f3333333-3333-4333-8333-333333333333','Fifteen-minute upload',900,28800044)$$,
 'exact 900-second canonical WAV metadata fits storage admission');
select lives_ok($$select public.rehearsal_create_recording('f1111111-1111-4111-8111-111111111111','f3333333-3333-4333-8333-333333333333','Fifteen-minute upload',900,28800044)$$,
 'replayed maximum-length upload admission remains idempotent');
select throws_ok($$select public.rehearsal_create_recording('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444','One extra sample',900.0000625,28800046)$$,
 '23514',null,'one 16kHz sample beyond fifteen minutes is rejected by the table constraint');
select throws_ok($$select public.rehearsal_create_recording('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444','Oversize envelope',900,31457281)$$,
 '23514',null,'one byte beyond 30MiB is rejected by the table constraint');
select is((select count(*) from public.rehearsal_recordings where user_id='f1111111-1111-4111-8111-111111111111'),1::bigint,
 'invalid and replayed reservations create no extra rows');
select is((select recording_count from rehearsal_private.user_daily_usage where user_id='f1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date),1,
 'invalid and replayed reservations consume no extra recording allowance');

select is(public.rehearsal_stream_start('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444','f5555555-5555-4555-8555-555555555555','Fifteen-minute stream',repeat('f',64),300000)->>'status','active',
 'managed stream starts with its unchanged single admission estimate');
select is((select expires_at-now() from rehearsal_private.live_sessions where recording_id='f4444444-4444-4444-8444-444444444444'),interval '18 minutes',
 'new live lease allows fifteen minutes of audio plus bounded pause and finalization time');
create temporary table fifteen_minute_lifetime as
 select s.expires_at,s.draft_key,s.draft_key_expires_at,r.upload_expires_at
 from rehearsal_private.live_sessions s join public.rehearsal_recordings r on r.id=s.recording_id
 where s.recording_id='f4444444-4444-4444-8444-444444444444';
select is(public.rehearsal_stream_start('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444','f5555555-5555-4555-8555-555555555555','Fifteen-minute stream',repeat('f',64),300000)->>'status','active',
 'replayed stream admission retains the same session');
select ok((select s.expires_at=b.expires_at and s.draft_key=b.draft_key and s.draft_key_expires_at=b.draft_key_expires_at and r.upload_expires_at=b.upload_expires_at
 from rehearsal_private.live_sessions s join public.rehearsal_recordings r on r.id=s.recording_id cross join fifteen_minute_lifetime b
 where s.recording_id='f4444444-4444-4444-8444-444444444444'),
 'replay never extends the live/upload deadline or rotates the draft recovery key');
select ok((select s.draft_key_expires_at between now()+interval '23 hours 59 minutes' and now()+interval '24 hours 1 minute' and r.upload_expires_at>=s.draft_key_expires_at
 from rehearsal_private.live_sessions s join public.rehearsal_recordings r on r.id=s.recording_id where s.recording_id='f4444444-4444-4444-8444-444444444444'),
 'fifteen-minute admission preserves the bounded 24-hour draft recovery window');
select is((select request_count from rehearsal_private.user_daily_usage where user_id='f1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date),1,
 'stream replay does not consume a second AI admission');
select is((select reserved_microusd from rehearsal_private.jobs where user_id='f1111111-1111-4111-8111-111111111111' and request_id='f5555555-5555-4555-8555-555555555555'),300000::bigint,
 'longer stream keeps the unchanged 300000-microusd reservation');

update rehearsal_private.jobs set created_at=now()-interval '13 minutes'
 where user_id='f1111111-1111-4111-8111-111111111111' and request_id='f5555555-5555-4555-8555-555555555555';
select is(public.rehearsal_get_request('f1111111-1111-4111-8111-111111111111','f5555555-5555-4555-8555-555555555555')->>'state','reserved',
 'an active extended live lease outlives the ten-minute batch recovery window');
select throws_ok($$select public.rehearsal_prepare_delete('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444')$$,
 'P0001','request_busy','active extended lease continues to protect recording deletion');

-- Replaying a session admitted before the rollout must keep its issued lease.
update rehearsal_private.live_sessions set expires_at=now()+interval '12 minutes'
 where recording_id='f4444444-4444-4444-8444-444444444444';
select is((public.rehearsal_stream_start('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444','f5555555-5555-4555-8555-555555555555','Fifteen-minute stream',repeat('f',64),300000)->>'expires_at')::timestamptz,
 now()+interval '12 minutes','replaying a pre-rollout session does not extend its issued deadline');
update rehearsal_private.live_sessions set expires_at=clock_timestamp()-interval '1 second'
 where recording_id='f4444444-4444-4444-8444-444444444444';
select throws_ok($$select public.rehearsal_stream_claim('f1111111-1111-4111-8111-111111111111','f4444444-4444-4444-8444-444444444444','f5555555-5555-4555-8555-555555555555',0)$$,
 'P0001','live_closed','pause allowance remains finite and an expired stream cannot claim compute');

select * from finish();
rollback;
