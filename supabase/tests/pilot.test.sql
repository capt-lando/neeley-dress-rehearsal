begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Check the schema default even when the linked pilot has an enabled budget.
select is((select column_default::text from information_schema.columns
  where table_schema='rehearsal_private' and table_name='limits' and column_name='daily_budget_microusd'),
  '0'::text,'AI spending defaults to disabled');
-- Isolate synthetic admission accounting inside this rollback-only transaction.
-- No existing student content is deleted; the shared counters/settings revert.
update rehearsal_private.limits set daily_budget_microusd=0,requests_per_user_day=10,
  max_saved_recordings=10,max_total_recordings=100000;
update rehearsal_private.daily_usage set reserved_microusd=0,recording_count=0,event_count=0
  where day=(now() at time zone 'UTC')::date;

insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','pilot-a@example.test'),
 ('22222222-2222-4222-8222-222222222222','pilot-b@example.test');
insert into public.rehearsal_profiles(user_id) values
 ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
select public.rehearsal_create_recording('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','My take',1,32044);
select public.rehearsal_create_recording('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','Other take',1,32044);

select ok((select not public from storage.buckets where id='recordings'),'audio bucket is private');
select is((select file_size_limit from storage.buckets where id='recordings'),20971520::bigint,'bucket rejects oversized audio');
select is((select daily_budget_microusd from rehearsal_private.limits),0::bigint,'isolated fixture starts with AI spending disabled');
select ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','rehearsal_private') and c.relname in ('rehearsal_profiles','rehearsal_recordings','rehearsal_events','jobs','limits','daily_usage','user_daily_usage')),'all application tables enable RLS');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select is((select count(*) from public.rehearsal_recordings),1::bigint,'a student sees only their recording');
select is((select count(*) from public.rehearsal_profiles),1::bigint,'a student sees only their profile');
select throws_ok($$update public.rehearsal_profiles set cohort='pdc'$$,'42501',null,'students cannot assign their own pilot cohort');
select throws_ok($$delete from public.rehearsal_recordings$$,'42501',null,'deletion must remove private files through the API');
select throws_ok($$select * from public.rehearsal_events$$,'42501',null,'students cannot read raw analytics');
select throws_ok($$select * from rehearsal_private.limits$$,'42501',null,'operational limits are private');
select throws_ok($$select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','coach',repeat('a',64),1)$$,'42501',null,'students cannot choose their own budget reservation');
select throws_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('recordings','11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/audio.wav','11111111-1111-4111-8111-111111111111','{"size":32044}')$$,'42501',null,'browser cannot bypass the gateway even for an owned pending upload');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('recordings','22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444/audio.wav','{"size":32044}')$$,'42501',null,'cannot write another student audio');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('recordings','11111111-1111-4111-8111-111111111111/unreserved/audio.wav','{"size":32044}')$$,'42501',null,'cannot create an unreserved orphan audio object');
reset role;
-- Metadata-only fixtures represent uploads already validated by the gateway.
-- No actual audio files or student storage objects are created or modified.
set local role service_role;
select lives_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('recordings','11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/audio.wav','11111111-1111-4111-8111-111111111111','{"size":32044}')$$,'verified gateway can commit an owned pending upload');
insert into storage.objects(bucket_id,name,owner_id,metadata) values('recordings','22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444/audio.wav','22222222-2222-4222-8222-222222222222','{"size":32044}');
reset role;
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id='recordings'),1::bigint,'student sees only own audio');
reset role;

-- Browser Storage writes stay denied regardless of supplied metadata.
select public.rehearsal_create_recording('11111111-1111-4111-8111-111111111111','66666666-6666-4666-8666-666666666666','Size test',1,32044);
set local role authenticated;
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('recordings','11111111-1111-4111-8111-111111111111/66666666-6666-4666-8666-666666666666/audio.wav','{"contentLength":32044,"mimetype":"audio/wav"}')$$,'42501',null,'unmeasured browser upload permission probe is also denied');
reset role;
set local role service_role;
insert into storage.objects(bucket_id,name,metadata) values('recordings','11111111-1111-4111-8111-111111111111/66666666-6666-4666-8666-666666666666/audio.wav','{"size":32044,"mimetype":"audio/wav"}');
reset role;
set local role authenticated;
select is_empty($$update storage.objects set metadata='{"size":1}' where name='11111111-1111-4111-8111-111111111111/66666666-6666-4666-8666-666666666666/audio.wav' returning name$$,'browser cannot overwrite an existing object');
reset role;
set local role anon;
select throws_ok($$select * from public.rehearsal_recordings$$,'42501',null,'anonymous clients cannot read history');
select throws_ok($$select public.rehearsal_create_recording('11111111-1111-4111-8111-111111111111','77777777-7777-4777-8777-777777777777','Abuse',1,32044)$$,'42501',null,'anonymous clients cannot reserve storage');
reset role;

select throws_ok($$select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','coach',repeat('a',64),400000)$$,'P0001','budget_exhausted','default budget admits no paid requests');
update rehearsal_private.limits set daily_budget_microusd=1000000,requests_per_user_day=2;
set local role service_role;
select is(public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','coach',repeat('a',64),400000)->>'state','new','verified gateway can reserve a request');
select is(public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','coach',repeat('a',64),400000)->>'state','reserved','retry sees the same in-flight request');
select throws_ok($$select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','77777777-7777-4777-8777-777777777777','coach',repeat('a',64),400000)$$,'P0001','request_busy','one active billable request per student');
select throws_ok($$select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','coach',repeat('b',64),400000)$$,'P0001','request_conflict','idempotency key cannot be reused with different input');
select public.rehearsal_finish('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',true,'{"report":"saved"}');
select is(public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','coach',repeat('a',64),400000)->'response','{"report":"saved"}'::jsonb,'completed retries receive their original result');
reset role;
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),400000::bigint,'retries consume only one reservation');
select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','77777777-7777-4777-8777-777777777777','coach',repeat('a',64),400000);
select public.rehearsal_finish('11111111-1111-4111-8111-111111111111','77777777-7777-4777-8777-777777777777',false,null);
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),800000::bigint,'uncertain failure retains its debit');
select throws_ok($$select public.rehearsal_reserve('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','88888888-8888-4888-8888-888888888888','coach',repeat('a',64),400000)$$,'P0001','budget_exhausted','project budget applies across students');
select throws_ok($$select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','88888888-8888-4888-8888-888888888888','coach',repeat('a',64),100000)$$,'P0001','daily_limit','per-student quota applies independently of global budget');

update rehearsal_private.limits set max_saved_recordings=2;
select throws_ok($$select public.rehearsal_create_recording('11111111-1111-4111-8111-111111111111','99999999-9999-4999-8999-999999999999','Over quota',1,32044)$$,'P0001','storage_limit','per-student storage admission is bounded');
update rehearsal_private.limits set max_saved_recordings=10,
  max_total_recordings=(select count(*) from public.rehearsal_recordings where not upload_expired);
select throws_ok($$select public.rehearsal_create_recording('22222222-2222-4222-8222-222222222222','99999999-9999-4999-8999-999999999999','Over project quota',1,32044)$$,'P0001','storage_limit','global storage admission is bounded');
select lives_ok($$select public.rehearsal_create_recording('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','My take',1,32044)$$,'existing identical upload reservation does not consume a new slot');

select is(public.rehearsal_ingest_events('11111111-1111-4111-8111-111111111111','[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sessionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"section_engaged","section":"prepare","activeSeconds":20}]'),1,'usage event is accepted');
select is(public.rehearsal_ingest_events('11111111-1111-4111-8111-111111111111','[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sessionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"section_engaged","section":"prepare","activeSeconds":20}]'),0,'replayed events are not double-counted');
select is((select active_seconds from public.rehearsal_events where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),20::double precision,'event retries cannot inflate engagement');

select * from finish();
rollback;
