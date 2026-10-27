begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Synthetic owner/job only: no provider call, allowance adjustment, or student
-- content changes. This entire fixture rolls back.
insert into auth.users(id,email) values
 ('a1111111-1111-4111-8111-111111111111','recovery-a@example.test'),
 ('a2222222-2222-4222-8222-222222222222','recovery-b@example.test');
insert into public.rehearsal_recordings(id,user_id,title,duration_seconds,size_bytes,storage_path,status) values
 ('a3333333-3333-4333-8333-333333333333','a1111111-1111-4111-8111-111111111111','Recovery fixture',1,32044,
  'a1111111-1111-4111-8111-111111111111/a3333333-3333-4333-8333-333333333333/audio.wav','transcribed');
insert into rehearsal_private.jobs(user_id,request_id,recording_id,kind,input_hash,reserved_microusd) values
 ('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444','a3333333-3333-4333-8333-333333333333','coach',repeat('a',64),1);

set local role anon;
select throws_ok($$select public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')$$,'42501',null,'anonymous clients cannot invoke recovery RPC');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select throws_ok($$select public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')$$,'42501',null,'owner must use the verified gateway');
reset role;
set local role service_role;
select throws_ok($$select public.rehearsal_get_request('a2222222-2222-4222-8222-222222222222','a4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','foreign requests disclose no result');
select throws_ok($$select public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a5555555-5555-4555-8555-555555555555')$$,'P0001','not_found','missing and foreign requests have the same error');
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->>'state','reserved','owner can recover running state');
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->'response','null'::jsonb,'running work has no result');
select ok(not (public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444') ?| array['input_hash','reserved_microusd','user_id']),'recovery omits internal job fields');
reset role;

update rehearsal_private.jobs set status='completed',response='{"report":"exact saved response"}',finished_at=now() where user_id='a1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->'response','{"report":"exact saved response"}'::jsonb,'completed lookup returns its exact persisted response');
update rehearsal_private.jobs set status='failed' where user_id='a1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->'response','null'::jsonb,'failed lookup hides stale result');
update rehearsal_private.jobs set status='reserved',created_at=now()-interval '11 minutes',finished_at=null where user_id='a1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->>'state','expired','server time identifies abandoned batch work');
select is((select status from rehearsal_private.jobs where user_id='a1111111-1111-4111-8111-111111111111'),'reserved','expiration lookup does not mutate job');
select is((select reserved_microusd from rehearsal_private.jobs where user_id='a1111111-1111-4111-8111-111111111111'),1::bigint,'lookup never refunds or recharges reservation');

insert into rehearsal_private.live_sessions(recording_id,user_id,request_id) values
 ('a3333333-3333-4333-8333-333333333333','a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444');
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->>'state','reserved','active live lease survives ten-minute batch window');
update rehearsal_private.live_sessions set expires_at=now()-interval '1 second' where user_id='a1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')->>'state','expired','expired live lease no longer preserves running state');
update public.rehearsal_recordings set status='deleting' where id='a3333333-3333-4333-8333-333333333333';
select throws_ok($$select public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','deleting recording cannot be restored through job');

-- Refresh beats start: no recording, paid job, or debit is created.
set local role authenticated;
select throws_ok($$select public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444')$$,'42501',null,'browser cannot spoof cancellation owner through RPC');
select throws_ok($$select * from rehearsal_private.live_cancellations$$,'42501',null,'cancellation records are private');
reset role;
set local role service_role;
select is(public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444')->>'status','cancelled','refresh can cancel before start arrives');
select is(public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444')->>'status','cancelled','uncertain cancellation retry is idempotent');
select throws_ok($$select public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','b5555555-5555-4555-8555-555555555555')$$,'P0001','request_conflict','cancellation cannot replace the original request identity');
select throws_ok($$select public.rehearsal_live_start('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444','Late start',repeat('b',64),1)$$,'P0001','live_closed','late start sees tombstone before reserving');
reset role;
select is((select count(*) from public.rehearsal_recordings where id='b3333333-3333-4333-8333-333333333333'),0::bigint,'cancel-before-start creates no saved-recording reservation');
select is((select count(*) from rehearsal_private.jobs where request_id='b4444444-4444-4444-8444-444444444444'),0::bigint,'cancel-before-start creates no paid job');

-- A guessed ID in one account cannot block or cancel another account's start.
-- The one-unit synthetic admission and settings disappear with this rollback.
update rehearsal_private.limits set daily_budget_microusd=coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)+100,
  requests_per_user_day=10,max_saved_recordings=10,max_total_recordings=100000;
set local role service_role;
select is(public.rehearsal_live_start('a2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444','Other owner',repeat('b',64),1)->>'status','active','another account tombstone cannot block matching guessed IDs');
select throws_ok($$select public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','guessed live IDs cannot cancel another owner');
select throws_ok($$select public.rehearsal_get_request('a1111111-1111-4111-8111-111111111111','b4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','guessed request ID cannot read another owner result');
select throws_ok($$select public.rehearsal_live_cancel('a2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333','b5555555-5555-4555-8555-555555555555')$$,'P0001','request_conflict','existing cancellation must match request ID');
select is(public.rehearsal_live_get('a2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333')->>'status','active','foreign and mismatched cancellations leave active session untouched');
reset role;
insert into storage.objects(bucket_id,name,owner_id,metadata) values('recordings','a2222222-2222-4222-8222-222222222222/b3333333-3333-4333-8333-333333333333/audio.wav','a2222222-2222-4222-8222-222222222222','{"size":16044}');
set local role service_role;
select is(public.rehearsal_live_cancel('a2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444'),' {"status":"cancelled","audio_saved":true}'::jsonb,'start-before-refresh closes owner session and reports existing saved audio');
select is(public.rehearsal_get_request('a2222222-2222-4222-8222-222222222222','b4444444-4444-4444-8444-444444444444')->>'state','failed','cancellation releases existing paid request lock');
select throws_ok($$select public.rehearsal_live_chunk_done('a2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333',0,'Late private text')$$,'P0001','live_closed','late inference cannot restore canceled session');
reset role;
select is((select reserved_microusd from rehearsal_private.jobs where user_id='a2222222-2222-4222-8222-222222222222' and request_id='b4444444-4444-4444-8444-444444444444'),1::bigint,'canceling admitted work preserves its existing debit');
select is((select count(*) from storage.objects where bucket_id='recordings' and name='a2222222-2222-4222-8222-222222222222/b3333333-3333-4333-8333-333333333333/audio.wav'),1::bigint,'cancellation does not delete saved audio');
update rehearsal_private.live_sessions set status='completed' where recording_id='b3333333-3333-4333-8333-333333333333';
select is(public.rehearsal_live_cancel('a2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444')->>'status','completed','cancellation retry preserves completed session');

-- Bound content-free cancellation records even under repeated fake refreshes.
insert into rehearsal_private.live_cancellations(user_id,recording_id,request_id)
 select 'a1111111-1111-4111-8111-111111111111',gen_random_uuid(),gen_random_uuid() from generate_series(1,99);
select throws_ok($$select public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','c3333333-3333-4333-8333-333333333333','c4444444-4444-4444-8444-444444444444')$$,'P0001','recovery_limit','per-user cancellation count is bounded');
update rehearsal_private.live_cancellations set expires_at=now()-interval '1 second' where user_id='a1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_live_cancel('a1111111-1111-4111-8111-111111111111','c3333333-3333-4333-8333-333333333333','c4444444-4444-4444-8444-444444444444')->>'status','cancelled','expired tombstones release cancellation capacity');
select is((select count(*) from rehearsal_private.live_cancellations where user_id='a1111111-1111-4111-8111-111111111111'),1::bigint,'expired cancellation tombstones are removed');

select * from finish();
rollback;
