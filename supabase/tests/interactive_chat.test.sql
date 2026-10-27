begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Synthetic users and counters are rolled back; no provider or stored audio is used.
insert into auth.users(id,email) values
 ('a7111111-1111-4111-8111-111111111111','chat-a@example.test'),
 ('a7222222-2222-4222-8222-222222222222','chat-b@example.test');
insert into public.rehearsal_profiles(user_id) values
 ('a7111111-1111-4111-8111-111111111111'),('a7222222-2222-4222-8222-222222222222');
insert into public.rehearsal_recordings(id,user_id,title,duration_seconds,size_bytes,storage_path,status,transcript)
 values('b7111111-1111-4111-8111-111111111111','a7111111-1111-4111-8111-111111111111','Chat test',1,32044,
 'a7111111-1111-4111-8111-111111111111/b7111111-1111-4111-8111-111111111111/audio.wav','transcribed','Only these words were recorded.');
update rehearsal_private.limits set daily_budget_microusd=0,requests_per_user_day=10;
insert into rehearsal_private.daily_usage(day,reserved_microusd) values((now() at time zone 'UTC')::date,0)
 on conflict(day) do update set reserved_microusd=0;

select ok((select bool_and(relrowsecurity) from pg_class where oid in ('rehearsal_private.chat_jobs'::regclass,'rehearsal_private.chat_daily_usage'::regclass)),'content-free chat receipts and usage enable RLS');
set local role anon;
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64))$$,'42501',null,'anonymous role cannot reserve paid chat');
select throws_ok($$select * from rehearsal_private.chat_jobs$$,'42501',null,'anonymous role cannot read chat receipts');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a7111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64))$$,'42501',null,'student cannot bypass the gateway to reserve chat');
select throws_ok($$select public.rehearsal_chat_complete('a7111111-1111-4111-8111-111111111111','c7111111-1111-4111-8111-111111111111')$$,'42501',null,'student cannot forge completion');
select throws_ok($$select public.rehearsal_chat_fail('a7111111-1111-4111-8111-111111111111','c7111111-1111-4111-8111-111111111111')$$,'42501',null,'student cannot clear another in-flight lock');
select throws_ok($$select * from rehearsal_private.chat_jobs$$,'42501',null,'even an owner cannot directly read private request receipts');
select throws_ok($$update rehearsal_private.chat_daily_usage set request_count=0$$,'42501',null,'student cannot reset chat allowance');
reset role;

select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64))$$,'P0001','budget_exhausted','disabled project allowance prevents chat before any recording');
select is((select count(*) from rehearsal_private.chat_jobs where user_id='a7111111-1111-4111-8111-111111111111'),0::bigint,'denied reservation creates no paid job');
update rehearsal_private.limits set daily_budget_microusd=1000000;
set local role service_role;
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64))->>'state','new','verified pre-take chat works without making a recording');
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64))->>'state','reserved','identical pending retry reuses admission');
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('b',64))$$,'P0001','request_conflict','same request cannot substitute a new message');
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111','b7111111-1111-4111-8111-111111111111','c7111111-1111-4111-8111-111111111111',repeat('a',64))$$,'P0001','request_conflict','same request cannot change its recording context');
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7222222-2222-4222-8222-222222222222',repeat('a',64))$$,'P0001','chat_busy','one active chat per user is enforced in the database');
select throws_ok($$select public.rehearsal_chat_complete('a7222222-2222-4222-8222-222222222222','c7111111-1111-4111-8111-111111111111')$$,'P0001','not_found','completion is bound to verified owner');
select ok(to_regprocedure('public.rehearsal_chat_complete(uuid,uuid,jsonb)') is null,'the reply-accepting completion RPC no longer exists');
select lives_ok($$select public.rehearsal_chat_complete('a7111111-1111-4111-8111-111111111111','c7111111-1111-4111-8111-111111111111')$$,'completion records only its status');
select lives_ok($$select public.rehearsal_chat_complete('a7111111-1111-4111-8111-111111111111','c7111111-1111-4111-8111-111111111111')$$,'duplicate completion is idempotent without a stored reply');
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64)),'{"state":"completed"}'::jsonb,'completed retry returns only status and never a reply');
reset role;
select ok(not exists(select 1 from information_schema.columns where table_schema='rehearsal_private' and table_name='chat_jobs' and column_name not in ('user_id','request_id','recording_id','input_hash','status','created_at','finished_at')),'chat receipts have no prompt, conversation, or reply content column');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),20000::bigint,'replays and conflicts do not debit again');
select is((select request_count from rehearsal_private.chat_daily_usage where user_id='a7111111-1111-4111-8111-111111111111'),1,'replays and conflicts do not consume chat quota');

-- Chat and analysis can run together while drawing from one project balance.
select public.rehearsal_reserve('a7111111-1111-4111-8111-111111111111','b7111111-1111-4111-8111-111111111111','d7111111-1111-4111-8111-111111111111','coach',repeat('d',64),60000);
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111','b7111111-1111-4111-8111-111111111111','c7222222-2222-4222-8222-222222222222',repeat('b',64))->>'state','new','chat remains usable during an admitted analysis');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),100000::bigint,'analysis and chat debit the same ledger');
select public.rehearsal_chat_fail('a7111111-1111-4111-8111-111111111111','c7222222-2222-4222-8222-222222222222');
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111','b7111111-1111-4111-8111-111111111111','c7222222-2222-4222-8222-222222222222',repeat('b',64))->>'state','failed','failed ID never starts a second provider request');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),100000::bigint,'failed chat keeps its original debit');
select is((select transcript from public.rehearsal_recordings where id='b7111111-1111-4111-8111-111111111111'),'Only these words were recorded.','chat does not overwrite recorded words');
select ok((select report is null from public.rehearsal_recordings where id='b7111111-1111-4111-8111-111111111111'),'chat does not create a report or annotations');
select throws_ok($$update public.rehearsal_recordings set report='{"meta":{"rehearsalContext":"Private conversation"}}' where id='b7111111-1111-4111-8111-111111111111'$$,'23514',null,'saved report metadata cannot persist a chat conversation');
select throws_ok($$update public.rehearsal_recordings set report='{"input":{"rehearsalContext":"Private conversation"}}' where id='b7111111-1111-4111-8111-111111111111'$$,'23514',null,'saved report inputs cannot persist a chat conversation');
select throws_ok($$update rehearsal_private.jobs set response='{"meta":{"rehearsalContext":"Private conversation"}}' where user_id='a7111111-1111-4111-8111-111111111111' and request_id='d7111111-1111-4111-8111-111111111111'$$,'23514',null,'analysis recovery metadata cannot persist a chat conversation');
select throws_ok($$update rehearsal_private.jobs set response='{"input":{"rehearsalContext":"Private conversation"}}' where user_id='a7111111-1111-4111-8111-111111111111' and request_id='d7111111-1111-4111-8111-111111111111'$$,'23514',null,'analysis recovery inputs cannot persist a chat conversation');
select throws_ok($$select public.rehearsal_chat_reserve('a7222222-2222-4222-8222-222222222222','b7111111-1111-4111-8111-111111111111','c7333333-3333-4333-8333-333333333333',repeat('c',64))$$,'P0001','not_found','foreign recording cannot become chat context');
update rehearsal_private.limits set daily_budget_microusd=119999;
select throws_ok($$select public.rehearsal_chat_reserve('a7222222-2222-4222-8222-222222222222',null,'c7333333-3333-4333-8333-333333333333',repeat('c',64))$$,'P0001','budget_exhausted','chat cannot exceed the remaining shared project allowance');
update rehearsal_private.limits set daily_budget_microusd=120000;
select is(public.rehearsal_chat_reserve('a7222222-2222-4222-8222-222222222222',null,'c7333333-3333-4333-8333-333333333333',repeat('c',64))->>'state','new','exact final reservation is admitted');
select public.rehearsal_chat_fail('a7222222-2222-4222-8222-222222222222','c7333333-3333-4333-8333-333333333333');
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7444444-4444-4444-8444-444444444444',repeat('d',64))$$,'P0001','budget_exhausted','shared allowance also blocks another account');

-- Completed content-free receipts persist for idempotency; only stalled work expires.
update rehearsal_private.limits set daily_budget_microusd=1000000;
update rehearsal_private.chat_jobs set created_at=now()-interval '25 hours' where request_id='c7111111-1111-4111-8111-111111111111' and user_id='a7111111-1111-4111-8111-111111111111';
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7444444-4444-4444-8444-444444444444',repeat('d',64))->>'state','new','new chat can start alongside old completed receipts');
select ok((select status='completed' from rehearsal_private.chat_jobs where request_id='c7111111-1111-4111-8111-111111111111' and user_id='a7111111-1111-4111-8111-111111111111'),'old completed receipt remains without storing reply text');
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7111111-1111-4111-8111-111111111111',repeat('a',64)),'{"state":"completed"}'::jsonb,'old ID cannot become new paid work or recover a deleted reply');
update rehearsal_private.chat_jobs set created_at=now()-interval '91 seconds' where request_id='c7444444-4444-4444-8444-444444444444' and user_id='a7111111-1111-4111-8111-111111111111';
select throws_ok($$select public.rehearsal_chat_complete('a7111111-1111-4111-8111-111111111111','c7444444-4444-4444-8444-444444444444')$$,'P0001','chat_expired','late provider response cannot finish after its lease');
select is(public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7555555-5555-4555-8555-555555555555',repeat('e',64))->>'state','new','expired in-flight lease releases user for a new message');
select public.rehearsal_chat_fail('a7111111-1111-4111-8111-111111111111','c7555555-5555-4555-8555-555555555555');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),160000::bigint,'expiry and failure never refund paid reservations');

-- Neither rotating request IDs nor deleting a recording resets persistent quotas.
update rehearsal_private.chat_daily_usage set minute=date_trunc('minute',now()),minute_count=6 where user_id='a7111111-1111-4111-8111-111111111111';
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7666666-6666-4666-8666-666666666666',repeat('f',64))$$,'P0001','rate_limited','seventh message in a minute is rejected');
update rehearsal_private.chat_daily_usage set minute=now()-interval '1 minute',request_count=60 where user_id='a7111111-1111-4111-8111-111111111111';
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7666666-6666-4666-8666-666666666666',repeat('f',64))$$,'P0001','chat_limit','daily message allowance survives minute rollover');
delete from public.rehearsal_recordings where id='b7111111-1111-4111-8111-111111111111';
select is((select request_count from rehearsal_private.chat_daily_usage where user_id='a7111111-1111-4111-8111-111111111111'),60,'recording deletion does not reset daily chat quota');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),160000::bigint,'recording deletion does not refund project allowance');
select throws_ok($$select public.rehearsal_chat_reserve('a7111111-1111-4111-8111-111111111111',null,'c7666666-6666-4666-8666-666666666666',repeat('f',64))$$,'P0001','chat_limit','new ID after deleting recording cannot bypass quota');
select * from finish();
rollback;
