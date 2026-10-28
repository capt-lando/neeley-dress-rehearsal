begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Synthetic owner fixtures only; every row and allowance change rolls back.
insert into auth.users(id,email) values
 ('e1111111-1111-4111-8111-111111111111','stream-a@example.test'),
 ('e2222222-2222-4222-8222-222222222222','stream-b@example.test');
update rehearsal_private.limits set daily_budget_microusd=coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)+2000000,
  requests_per_user_day=10,max_saved_recordings=10,max_total_recordings=100000;

set local role anon;
select throws_ok($$select public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0)$$,'42501',null,'anonymous clients cannot claim streams');
reset role;
set local role authenticated;
select throws_ok($$select public.rehearsal_stream_start('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444','Stream',repeat('a',64),300000)$$,'42501',null,'browser cannot forge stream admission');
select throws_ok($$select public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0,'Forged text',24000)$$,'42501',null,'browser cannot forge provider transcript');
select throws_ok($$select public.rehearsal_stream_finalize('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333',1,32044)$$,'42501',null,'browser cannot skip audio validation');
reset role;

set local role service_role;
select is(public.rehearsal_stream_start('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444','Stream',repeat('a',64),300000)->>'transport','openai-stream','verified start creates managed streaming session');
select is(public.rehearsal_stream_start('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444','Stream',repeat('a',64),300000)->>'status','active','admission retry is idempotent');
select throws_ok($$select public.rehearsal_stream_claim('e2222222-2222-4222-8222-222222222222','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0)$$,'P0001','not_found','foreign account cannot access stream');
select throws_ok($$select public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e5555555-5555-4555-8555-555555555555',0)$$,'P0001','request_conflict','wrong request cannot bind socket');
select throws_ok($$select public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333',null,0)$$,'P0001','invalid_request','null request cannot bypass binding');
select throws_ok($$select public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',1)$$,'P0001','live_order','segments cannot skip ahead');
select is(public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0)->>'maxSamples','2640000','each segment admits at most110 seconds at24kHz');
select is(public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0)->>'state','reserved','same segment cannot open another paid provider connection');
select throws_ok($$select public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0,'Too much',2640001)$$,'P0001','invalid_request','oversized actual sample count is rejected');
select is(public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0,'Um, hello.',24000)->>'transcript','Um, hello.','only server completion adds transcript');
select is(public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0,'Um, hello.',24000)->>'consumedSamples','24000','completion retry never double counts samples');
select throws_ok($$select public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0,'Changed',24000)$$,'P0001','request_conflict','same segment cannot change transcript after completion');
select is(public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',0)->>'state','completed','completed claim is cached and never admits compute');
select is(public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',1)->>'state','new','confirmed segment permits one next connection');
select is(public.rehearsal_live_cancel('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444')->>'status','cancelled','cancel marks owner session terminal');
select throws_ok($$select public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',1,'Late private text',24000)$$,'P0001','live_closed','late provider text cannot revive cancellation');
select lives_ok($$select public.rehearsal_stream_fail('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333','e4444444-4444-4444-8444-444444444444',1)$$,'relay can acknowledge closure after cancellation');
reset role;
select is((select stream_segments->1->>'state' from rehearsal_private.live_sessions where recording_id='e3333333-3333-4333-8333-333333333333'),'cancelled','closure acknowledgment is durable');
select is((select stream_reserved_samples from rehearsal_private.live_sessions where recording_id='e3333333-3333-4333-8333-333333333333'),2640000,'uncertain provider segment retains its sample reservation');
select is((select reserved_microusd from rehearsal_private.jobs where request_id='e4444444-4444-4444-8444-444444444444'),300000::bigint,'live cancellation retains one paid admission');
select is((select request_count from rehearsal_private.user_daily_usage where user_id='e1111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date),1,'segment rotation never consumes another student request');

-- A late failed-stream save cannot erase a later successful whole-file retry.
update public.rehearsal_recordings set status='analyzed',transcript='Later batch transcript',report='{"saved":true}',duration_seconds=1,size_bytes=32044 where id='e3333333-3333-4333-8333-333333333333';
select is(public.rehearsal_stream_finalize('e1111111-1111-4111-8111-111111111111','e3333333-3333-4333-8333-333333333333',1,32044)->>'complete','false','failed stream does not become completed');
select is((select transcript from public.rehearsal_recordings where id='e3333333-3333-4333-8333-333333333333'),'Later batch transcript','later transcript is preserved');
select is((select report from public.rehearsal_recordings where id='e3333333-3333-4333-8333-333333333333'),'{"saved":true}'::jsonb,'later report is preserved');

-- Eight110-second segments plus a20-second tail exactly cover fifteen minutes.
select is(public.rehearsal_stream_start('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666','Fifteen minutes',repeat('b',64),300000)->>'status','active','second owner starts an independent stream');
do $$begin for i in 0..7 loop
  perform public.rehearsal_stream_claim('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666',i);
  perform public.rehearsal_stream_finish('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666',i,'Part '||i,2640000);
end loop;end$$;
select is(public.rehearsal_stream_claim('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666',8)->>'maxSamples','480000','final segment cannot exceed remaining twenty seconds');
select throws_ok($$select public.rehearsal_stream_finish('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666',8,'Over',480001)$$,'P0001','live_order','actual audio cannot exceed the remaining reservation');
select is(public.rehearsal_stream_finish('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666',8,'Last',480000)->>'consumedSamples','21600000','total stream is capped at fifteen minutes');
select throws_ok($$select public.rehearsal_stream_claim('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555','e6666666-6666-4666-8666-666666666666',9)$$,'P0001','live_duration','no tenth connection after the audio cap');
select throws_ok($$select public.rehearsal_stream_finalize('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555',900.0000625,28800046)$$,'P0001','invalid_request','finalization rejects one saved audio sample beyond fifteen minutes');
select throws_ok($$select public.rehearsal_stream_finalize('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555',899,28768044)$$,'P0001','live_duration','saved audio duration must match actual streamed samples');
select ok((select draft_key is not null from rehearsal_private.live_sessions where recording_id='e5555555-5555-4555-8555-555555555555'),'rejected maximum-length finalization retains the draft recovery key');
select is(public.rehearsal_stream_finalize('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555',900,28800044)->>'text','Part 0 Part 1 Part 2 Part 3 Part 4 Part 5 Part 6 Part 7 Last','final transcript is assembled only from server segments');
select is(public.rehearsal_stream_finalize('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555',900,28800044)->>'complete','true','lost final acknowledgment can be safely retried');
select is((select transcript from public.rehearsal_recordings where id='e5555555-5555-4555-8555-555555555555'),'Part 0 Part 1 Part 2 Part 3 Part 4 Part 5 Part 6 Part 7 Last','completed stream is privately saved');
select ok((select duration_seconds=900 and size_bytes=28800044 from public.rehearsal_recordings where id='e5555555-5555-4555-8555-555555555555'),'exact fifteen-minute WAV metadata remains saved after replay');
select ok((select draft_key is null and draft_key_expires_at is null from rehearsal_private.live_sessions where recording_id='e5555555-5555-4555-8555-555555555555'),'successful maximum-length finalization erases the draft recovery key');
select is((select request_count from rehearsal_private.user_daily_usage where user_id='e2222222-2222-4222-8222-222222222222' and day=(now() at time zone 'UTC')::date),1,'fifteen-minute segment rotations and finalization replay retain one AI admission');

-- Empty wall-clock rotations remain bounded without inventing speech.
select is(public.rehearsal_stream_start('e1111111-1111-4111-8111-111111111111','e7777777-7777-4777-8777-777777777777','e8888888-8888-4888-8888-888888888888','Paused stream',repeat('c',64),300000)->>'status','active','new take is admitted after cancellation');
do $$begin for i in 0..17 loop
  perform public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e7777777-7777-4777-8777-777777777777','e8888888-8888-4888-8888-888888888888',i);
  perform public.rehearsal_stream_finish('e1111111-1111-4111-8111-111111111111','e7777777-7777-4777-8777-777777777777','e8888888-8888-4888-8888-888888888888',i,'',0);
end loop;end$$;
select throws_ok($$select public.rehearsal_stream_claim('e1111111-1111-4111-8111-111111111111','e7777777-7777-4777-8777-777777777777','e8888888-8888-4888-8888-888888888888',18)$$,'P0001','invalid_request','connection count remains bounded even for silent/paused rotations');
select is((select stream_samples from rehearsal_private.live_sessions where recording_id='e7777777-7777-4777-8777-777777777777'),0,'empty rotations never invent sampled audio');
select * from finish();
rollback;
