begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email) values
 ('a1111111-1111-4111-8111-111111111111','security-a@example.test'),
 ('a2222222-2222-4222-8222-222222222222','security-b@example.test');
select lives_ok($$select public.rehearsal_admit_request('a1111111-1111-4111-8111-111111111111')$$,'verified first request creates its profile');
select public.rehearsal_admit_request('a2222222-2222-4222-8222-222222222222');
select is((select request_window_count from public.rehearsal_profiles where user_id='a1111111-1111-4111-8111-111111111111'),1,'first request counts once');
update rehearsal_private.limits set max_saved_recordings=2,max_total_recordings=100000,
 daily_budget_microusd=1000000+coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0),requests_per_user_day=10;

select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b1111111-1111-4111-8111-111111111111','Uploaded',1,32044);
select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222','Abandoned',1,32044);
select throws_ok($$select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','Replacement',1,32044)$$,'P0001','storage_limit','unexpired pending uploads occupy their slots');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('recordings','a1111111-1111-4111-8111-111111111111/b1111111-1111-4111-8111-111111111111/audio.wav','{"size":32044}')$$,'42501',null,'direct owner upload is denied even with audio/wav metadata');
select throws_ok($$insert into storage.objects(bucket_id,name) values('recordings','a1111111-1111-4111-8111-111111111111/orphan/audio.wav')$$,'42501',null,'unreserved upload is rejected');
select throws_ok($$select public.rehearsal_admit_request(null)$$,'42501',null,'browser cannot reset or call request admission');
select throws_ok($$select * from rehearsal_private.request_rate$$,'42501',null,'distributed request counters are private');
select throws_ok($$select * from public.rehearsal_events$$,'42501',null,'raw analytics remain private');
reset role;
set local role service_role;
select lives_ok($$insert into storage.objects(bucket_id,name,metadata) values('recordings','a1111111-1111-4111-8111-111111111111/b1111111-1111-4111-8111-111111111111/audio.wav','{"size":32044}')$$,'verified gateway can commit exact reserved audio after format validation');
reset role;

update public.rehearsal_recordings set upload_expires_at=clock_timestamp()-interval '1 second'
 where id in ('b1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222');
select lives_ok($$select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','Replacement',1,32044)$$,'expired empty reservation releases its slot');
select ok((select upload_expired from public.rehearsal_recordings where id='b2222222-2222-4222-8222-222222222222'),'abandoned metadata is marked expired');
select is((select title from public.rehearsal_recordings where id='b2222222-2222-4222-8222-222222222222'),'Abandoned','expired metadata is retained');
select ok((select not upload_expired from public.rehearsal_recordings where id='b1111111-1111-4111-8111-111111111111'),'uploaded audio never loses its storage slot');
select is((select count(*) from storage.objects where name='a1111111-1111-4111-8111-111111111111/b1111111-1111-4111-8111-111111111111/audio.wav'),1::bigint,'expiry does not delete audio');

set local role authenticated;
select throws_ok($$insert into storage.objects(bucket_id,name) values('recordings','a1111111-1111-4111-8111-111111111111/b2222222-2222-4222-8222-222222222222/audio.wav')$$,'42501','upload_expired','late owner upload cannot reclaim an expired slot');
select set_config('request.jwt.claims','{"sub":"a2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
select is((select count(*) from public.rehearsal_recordings),0::bigint,'second account cannot read first-account history');
select is((select count(*) from storage.objects where bucket_id='recordings'),0::bigint,'second account cannot read first-account audio');
select throws_ok($$insert into storage.objects(bucket_id,name) values('recordings','a1111111-1111-4111-8111-111111111111/b3333333-3333-4333-8333-333333333333/audio.wav')$$,'42501',null,'cross-user exact-path write is rejected');
select throws_ok($$update public.rehearsal_recordings set transcript='Forged'$$,'42501',null,'browser cannot alter transcript rows directly');
select throws_ok($$delete from public.rehearsal_recordings$$,'42501',null,'browser cannot bypass owned deletion gateway');
reset role;
set local role service_role;
select throws_ok($$insert into storage.objects(bucket_id,name) values('recordings','a1111111-1111-4111-8111-111111111111/b2222222-2222-4222-8222-222222222222/audio.wav')$$,'42501','upload_expired','privileged final storage insert also rechecks lease');
select throws_ok($$select public.rehearsal_prepare_delete('a2222222-2222-4222-8222-222222222222','b1111111-1111-4111-8111-111111111111')$$,'P0001','not_found','gateway cannot delete a foreign recording');
select throws_ok($$select public.rehearsal_reserve('a2222222-2222-4222-8222-222222222222','b1111111-1111-4111-8111-111111111111','c1111111-1111-4111-8111-111111111111','transcribe',repeat('a',64),75000)$$,'P0001','not_found','foreign-owner compute admission fails');
reset role;

update rehearsal_private.limits set max_saved_recordings=1000;
select public.rehearsal_live_start('a2222222-2222-4222-8222-222222222222','b4444444-4444-4444-8444-444444444444','c2222222-2222-4222-8222-222222222222','Live',repeat('b',64),300000);
update public.rehearsal_recordings set upload_expires_at=clock_timestamp()-interval '1 second' where id='b4444444-4444-4444-8444-444444444444';
select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b5555555-5555-4555-8555-555555555555','Another',1,32044);
select ok((select not upload_expired from public.rehearsal_recordings where id='b4444444-4444-4444-8444-444444444444'),'active live lease retains its slot');
select throws_ok($$select public.rehearsal_live_get('a1111111-1111-4111-8111-111111111111','b4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','live transcript ownership remains enforced');

update rehearsal_private.daily_usage set recording_count=399 where day=(now() at time zone 'UTC')::date;
update rehearsal_private.user_daily_usage set recording_count=39 where user_id='a1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date;
select lives_ok($$select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b6666666-6666-4666-8666-666666666666','Last daily',1,32044)$$,'exact daily reservation boundary is admitted');
select lives_ok($$select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b6666666-6666-4666-8666-666666666666','Last daily',1,32044)$$,'identical retry uses no extra daily reservation');
select is((select recording_count from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),400,'replay leaves global reservation counter unchanged');
select throws_ok($$select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b7777777-7777-4777-8777-777777777777','Over daily',1,32044)$$,'P0001','daily_limit','daily reservation ceiling rejects new metadata');
update rehearsal_private.daily_usage set recording_count=0 where day=(now() at time zone 'UTC')::date;
select throws_ok($$select public.rehearsal_live_start('a1111111-1111-4111-8111-111111111111','b7777777-7777-4777-8777-777777777777','c3333333-3333-4333-8333-333333333333','Over live',repeat('c',64),300000)$$,'P0001','daily_limit','live admission shares the per-user reservation ceiling');
update rehearsal_private.user_daily_usage set recording_count=0 where user_id='a1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date;
update rehearsal_private.daily_usage set recording_count=400 where day=(now() at time zone 'UTC')::date;
select throws_ok($$select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b7777777-7777-4777-8777-777777777777','Over global',1,32044)$$,'P0001','daily_limit','global reservation ceiling is independent of per-user allowance');

update public.rehearsal_profiles set request_window_start=clock_timestamp(),request_window_count=119 where user_id='a1111111-1111-4111-8111-111111111111';
select lives_ok($$select public.rehearsal_admit_request('a1111111-1111-4111-8111-111111111111')$$,'user request120 is admitted');
select throws_ok($$select public.rehearsal_admit_request('a1111111-1111-4111-8111-111111111111')$$,'P0001','rate_limited','user request121 is rejected');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select throws_ok($$insert into storage.objects(bucket_id,name) values('recordings','a1111111-1111-4111-8111-111111111111/b3333333-3333-4333-8333-333333333333/audio.wav')$$,'42501',null,'direct storage upload cannot bypass the rate-limited gateway');
reset role;
update public.rehearsal_profiles set request_window_start=clock_timestamp()-interval '61 seconds' where user_id='a1111111-1111-4111-8111-111111111111';
select public.rehearsal_admit_request('a1111111-1111-4111-8111-111111111111');
select is((select request_window_count from public.rehearsal_profiles where user_id='a1111111-1111-4111-8111-111111111111'),1,'elapsed user window resets without appending rows');
update rehearsal_private.request_rate set window_start=clock_timestamp(),request_count=1199;
select lives_ok($$select public.rehearsal_admit_request(null)$$,'global request1200 is admitted');
select throws_ok($$select public.rehearsal_admit_request(null)$$,'P0001','rate_limited','global request1201 is rejected');
update rehearsal_private.request_rate set window_start=clock_timestamp()-interval '61 seconds';
select public.rehearsal_admit_request(null);
select is((select request_count from rehearsal_private.request_rate),1,'elapsed global window resets in place');
select ok((select relrowsecurity from pg_class where oid='rehearsal_private.request_rate'::regclass),'global request state has RLS');
select is((select count(*) from rehearsal_private.request_rate),1::bigint,'global rate state remains one row');

update rehearsal_private.user_daily_usage set event_count=999 where user_id='a1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date;
update rehearsal_private.daily_usage set event_count=9999 where day=(now() at time zone 'UTC')::date;
select is(public.rehearsal_ingest_events('a1111111-1111-4111-8111-111111111111','[{"id":"d1111111-1111-4111-8111-111111111111","sessionId":"c1111111-1111-4111-8111-111111111111","name":"session_started","section":"prepare"}]'),1,'last event at both daily boundaries is accepted');
select is(public.rehearsal_ingest_events('a1111111-1111-4111-8111-111111111111','[{"id":"d1111111-1111-4111-8111-111111111111","sessionId":"c1111111-1111-4111-8111-111111111111","name":"session_started","section":"prepare"}]'),0,'event replay remains idempotent at the daily ceiling');
select is((select event_count from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),10000,'event replay adds no global debit');
select throws_ok($$select public.rehearsal_ingest_events('a2222222-2222-4222-8222-222222222222','[{"id":"d2222222-2222-4222-8222-222222222222","sessionId":"c1111111-1111-4111-8111-111111111111","name":"session_started","section":"prepare"}]')$$,'P0001','daily_limit','global analytics ceiling applies across users');
update rehearsal_private.daily_usage set event_count=0 where day=(now() at time zone 'UTC')::date;
select throws_ok($$select public.rehearsal_ingest_events('a1111111-1111-4111-8111-111111111111','[{"id":"d2222222-2222-4222-8222-222222222222","sessionId":"c1111111-1111-4111-8111-111111111111","name":"session_started","section":"prepare"}]')$$,'P0001','daily_limit','per-user analytics ceiling applies separately');
do $$ declare batch jsonb; begin
  for i in 0..5 loop
    select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'sessionId','c2222222-2222-4222-8222-222222222222','name','session_started','section','prepare')) into batch from generate_series(1,20);
    perform public.rehearsal_ingest_events('a2222222-2222-4222-8222-222222222222',batch);
  end loop;
end $$;
select throws_ok($$select public.rehearsal_ingest_events('a2222222-2222-4222-8222-222222222222','[{"id":"d2222222-2222-4222-8222-222222222222","sessionId":"c1111111-1111-4111-8111-111111111111","name":"session_started","section":"prepare"}]')$$,'P0001','daily_limit','minute analytics burst ceiling remains effective');
select is((select event_count from rehearsal_private.user_daily_usage where user_id='a2222222-2222-4222-8222-222222222222' and day=(now() at time zone 'UTC')::date),120,'rejected batch never increments event accounting');
select ok(not exists(select 1 from public.rehearsal_recordings where id='b7777777-7777-4777-8777-777777777777'),'failed batch/live admission leaves no metadata row');

-- These strings are data arguments only. Never execute the text as SQL.
create temporary table security_injection_payload(value text);
insert into security_injection_payload values($payload$x'); SELECT pg_sleep(5); DROP TABLE rehearsal_recordings;--/*$payload$);
update rehearsal_private.daily_usage set recording_count=0 where day=(now() at time zone 'UTC')::date;
update rehearsal_private.user_daily_usage set recording_count=0 where user_id='a1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date;
select public.rehearsal_create_recording('a1111111-1111-4111-8111-111111111111','b8888888-8888-4888-8888-888888888888',(select value from security_injection_payload),1,32044);
select is((select title from public.rehearsal_recordings where id='b8888888-8888-4888-8888-888888888888'),(select value from security_injection_payload),'quote/comment/DDL/delay payload remains an exact title value');
update public.rehearsal_recordings set transcript=(select value from security_injection_payload),
 report=jsonb_build_object('transcript',(select value from security_injection_payload),'meta',
   (select jsonb_object_agg(field,value) from security_injection_payload cross join unnest(array['targetScript','targetTalkingPoints','plannedIntroduction','plannedTransitions','instructorRubric','rubricFileName','speakerName']) field))
 where id='b8888888-8888-4888-8888-888888888888';
select is((select transcript from public.rehearsal_recordings where id='b8888888-8888-4888-8888-888888888888'),(select value from security_injection_payload),'corrected transcript stores injection-like text literally');
select ok((select bool_and(v=to_jsonb(p.value)) from public.rehearsal_recordings r cross join security_injection_payload p cross join lateral jsonb_each(r.report->'meta') e(k,v) where r.id='b8888888-8888-4888-8888-888888888888'),'all script, points, introduction, transition, rubric, filename and speaker values remain literal JSON');
select public.rehearsal_live_prepare('a2222222-2222-4222-8222-222222222222','b4444444-4444-4444-8444-444444444444');
select public.rehearsal_live_prepared('a2222222-2222-4222-8222-222222222222','b4444444-4444-4444-8444-444444444444');
select public.rehearsal_live_chunk('a2222222-2222-4222-8222-222222222222','b4444444-4444-4444-8444-444444444444',0,repeat('d',64),160000,false);
select is(public.rehearsal_live_chunk_done('a2222222-2222-4222-8222-222222222222','b4444444-4444-4444-8444-444444444444',0,(select value from security_injection_payload))->>'text',(select value from security_injection_payload),'live transcript RPC treats hostile text as data');
select ok(to_regclass('public.rehearsal_recordings') is not null,'injection-like inputs cannot remove the table');
select is((select title from public.rehearsal_recordings where id='b1111111-1111-4111-8111-111111111111'),'Uploaded','injection-like text cannot modify another recording');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
select is((select count(*) from public.rehearsal_recordings where id='b8888888-8888-4888-8888-888888888888'),0::bigint,'hostile text does not change cross-user RLS isolation');
reset role;
select * from finish();
rollback;
