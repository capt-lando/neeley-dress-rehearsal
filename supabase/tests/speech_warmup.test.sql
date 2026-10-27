begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Run in an idle speech window. Synthetic fixtures and settings roll back;
-- no student recordings, request states, or existing budget debits are changed.
insert into auth.users(id,email) values
 ('d1111111-1111-4111-8111-111111111111','warmup-a@example.test'),
 ('d2222222-2222-4222-8222-222222222222','warmup-b@example.test');
insert into public.rehearsal_profiles(user_id) values
 ('d1111111-1111-4111-8111-111111111111'),('d2222222-2222-4222-8222-222222222222');
update rehearsal_private.limits set daily_budget_microusd=coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)+10000000,
  requests_per_user_day=10;
update rehearsal_private.speech_warmup set state='idle',started_at=null,finished_at=null,expires_at=null,user_id=null,request_id=null;
insert into rehearsal_private.daily_usage(day) values((now() at time zone 'UTC')::date) on conflict do nothing;
update rehearsal_private.daily_usage set speech_warmup_count=0,speech_warmup_microusd=0 where day=(now() at time zone 'UTC')::date;
create temporary table warmup_baseline as select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date;

set local role anon;
select throws_ok($$select public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',75000)$$,'42501',null,'anonymous users cannot reserve startup');
reset role;
set local role authenticated;
select throws_ok($$select public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',75000)$$,'42501',null,'browser cannot spoof owner through RPC');
select throws_ok($$select public.rehearsal_speech_warmup_finish('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',true)$$,'42501',null,'browser cannot spoof startup completion');
select throws_ok($$select * from rehearsal_private.speech_warmup$$,'42501',null,'startup bookkeeping is private');
reset role;
select throws_ok($$select public.rehearsal_speech_warmup_reserve(null,'d3333333-3333-4333-8333-333333333333',75000)$$,'P0001','invalid_request','null owner rejected');
select throws_ok($$select public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111',null,75000)$$,'P0001','invalid_request','null operation rejected');
select throws_ok($$select public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',0)$$,'P0001','invalid_request','zero cost rejected');
select throws_ok($$select public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',100000001)$$,'P0001','invalid_request','unbounded cost rejected');

set local role service_role;
select is(public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',75000)->>'state','new','first verified sign-in admits one startup');
select is(public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444',75000)->>'state','pending','refresh deduplicates pending startup');
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555',75000)->>'state','pending','second account shares pending startup');
select is(public.rehearsal_speech_warmup_finish('d2222222-2222-4222-8222-222222222222','d3333333-3333-4333-8333-333333333333',true)->>'state','skipped','foreign account cannot acknowledge another lease');
select is(public.rehearsal_speech_warmup_finish('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444',true)->>'state','skipped','wrong operation cannot acknowledge another lease');
select is(public.rehearsal_speech_warmup_finish('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',true)->>'state','ready','matching unexpired lease acknowledges startup');
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555',75000)->>'state','ready','recent success shares only readiness');
reset role;
select is((select reserved_microusd-(select reserved_microusd from warmup_baseline) from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),75000::bigint,'duplicate sign-ins reserve exactly once');
select is((select request_count from rehearsal_private.user_daily_usage where user_id='d1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date),0,'startup does not use student analysis allowance');
select is((select count(*) from public.rehearsal_recordings where user_id in ('d1111111-1111-4111-8111-111111111111','d2222222-2222-4222-8222-222222222222')),0::bigint,'startup creates no phantom recordings');
select is((select count(*) from rehearsal_private.jobs where user_id in ('d1111111-1111-4111-8111-111111111111','d2222222-2222-4222-8222-222222222222')),0::bigint,'startup never holds a student processing lock');

update rehearsal_private.speech_warmup set finished_at=clock_timestamp()-interval '31 seconds';
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555',75000)->>'state','skipped','older ready hint does not pretend the worker remains ready');
update rehearsal_private.speech_warmup set started_at=clock_timestamp()-interval '4 minutes';
select is(public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444',75000)->>'state','skipped','same account cooldown survives page refresh');
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555',75000)->>'state','new','different account may start after global cooldown');
select is(public.rehearsal_speech_warmup_finish('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',true)->>'state','skipped','late completion cannot replace the new operation');
update rehearsal_private.speech_warmup set expires_at=clock_timestamp()-interval '1 second',started_at=clock_timestamp()-interval '4 minutes';
select is(public.rehearsal_speech_warmup_finish('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555',true)->>'state','skipped','expired startup never reports readiness');
update rehearsal_private.user_daily_usage set speech_warmup_started_at=clock_timestamp()-interval '31 minutes' where user_id='d1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d6666666-6666-4666-8666-666666666666',75000)->>'state','new','expired global lease releases startup');
select is(public.rehearsal_speech_warmup_finish('d1111111-1111-4111-8111-111111111111','d6666666-6666-4666-8666-666666666666',false)->>'state','unavailable','failed startup does not claim readiness');
select is((select reserved_microusd-(select reserved_microusd from warmup_baseline) from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),225000::bigint,'failed and expired startup keep their admitted debit');
select is((select speech_warmup_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),225000::bigint,'startup has its own share counter within the same daily debit');
update rehearsal_private.speech_warmup set started_at=clock_timestamp()-interval '4 minutes';
update rehearsal_private.user_daily_usage set speech_warmup_started_at=clock_timestamp()-interval '31 minutes' where user_id='d1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_speech_warmup_reserve('d1111111-1111-4111-8111-111111111111','d7777777-7777-4777-8777-777777777777',75000)->>'state','skipped','two actual starts per account per UTC day');
update rehearsal_private.user_daily_usage set speech_warmup_started_at=clock_timestamp()-interval '31 minutes' where user_id='d2222222-2222-4222-8222-222222222222';
update rehearsal_private.daily_usage set speech_warmup_count=24 where day=(now() at time zone 'UTC')::date;
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d8888888-8888-4888-8888-888888888888',75000)->>'state','skipped','project startup count is capped');
update rehearsal_private.daily_usage set speech_warmup_count=3 where day=(now() at time zone 'UTC')::date;
update rehearsal_private.limits set daily_budget_microusd=(select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date);
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d8888888-8888-4888-8888-888888888888',75000)->>'state','skipped','startup quietly obeys the existing project allowance');
update rehearsal_private.limits set daily_budget_microusd=greatest(3000000,daily_budget_microusd+1000000);
update rehearsal_private.daily_usage set speech_warmup_microusd=(select daily_budget_microusd/10 from rehearsal_private.limits) where day=(now() at time zone 'UTC')::date;
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d8888888-8888-4888-8888-888888888888',75000)->>'state','skipped','startup cannot consume more than ten percent of the daily allowance');
update rehearsal_private.daily_usage set speech_warmup_microusd=225000 where day=(now() at time zone 'UTC')::date;
update rehearsal_private.limits set daily_budget_microusd=daily_budget_microusd+100000,requests_per_user_day=0;
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d8888888-8888-4888-8888-888888888888',75000)->>'state','skipped','disabled pilot does not wake speech');
update rehearsal_private.limits set requests_per_user_day=10;

insert into public.rehearsal_recordings(id,user_id,title,duration_seconds,size_bytes,storage_path) values
 ('d9999999-9999-4999-8999-999999999999','d2222222-2222-4222-8222-222222222222','Synthetic speech gate',1,32044,
  'd2222222-2222-4222-8222-222222222222/d9999999-9999-4999-8999-999999999999/audio.wav');
insert into rehearsal_private.jobs(user_id,request_id,recording_id,kind,input_hash,reserved_microusd) values
 ('d2222222-2222-4222-8222-222222222222','daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','d9999999-9999-4999-8999-999999999999','transcribe',repeat('a',64),1);
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d8888888-8888-4888-8888-888888888888',75000)->>'state','skipped','startup yields to active speech');
select is((select status from rehearsal_private.jobs where request_id='daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'reserved','startup never cancels existing speech');
update rehearsal_private.jobs set status='completed' where request_id='daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
insert into rehearsal_private.live_sessions(recording_id,user_id,request_id) values
 ('d9999999-9999-4999-8999-999999999999','d2222222-2222-4222-8222-222222222222','daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
select is(public.rehearsal_speech_warmup_reserve('d2222222-2222-4222-8222-222222222222','d8888888-8888-4888-8888-888888888888',75000)->>'state','skipped','startup also yields to active live sessions');
select * from finish();
rollback;
