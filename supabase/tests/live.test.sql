begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
create temporary table live_test_baseline as select coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)::bigint as reserved;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','live-a@example.test'),
 ('22222222-2222-4222-8222-222222222222','live-b@example.test');
update rehearsal_private.limits set daily_budget_microusd=1000000+(select reserved from live_test_baseline),requests_per_user_day=10,max_saved_recordings=10,max_total_recordings=40;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select throws_ok($$select * from rehearsal_private.live_sessions$$,'42501',null,'live chunk records cannot be read by browser roles');
select throws_ok($$select public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','Live',repeat('a',64),1)$$,'42501',null,'browser cannot choose live admission costs');
reset role;

select is(public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','Live',repeat('a',64),300000)->>'status','active','start admits one live rehearsal');
select is(public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','Live',repeat('a',64),300000)->>'status','active','replayed start reuses session');
select is((select count(*) from public.rehearsal_recordings where user_id='11111111-1111-4111-8111-111111111111'),1::bigint,'live start creates one history entry');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),(select reserved+300000 from live_test_baseline),'replayed start does not debit again');
select is((select request_count from rehearsal_private.user_daily_usage where user_id='11111111-1111-4111-8111-111111111111' and day=(now() at time zone 'UTC')::date),1,'whole session consumes one user request');
select throws_ok($$select public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','Other',repeat('a',64),300000)$$,'P0001','request_busy','second active live rehearsal cannot start');
select throws_ok($$select public.rehearsal_live_get('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')$$,'P0001','not_found','another owner cannot inspect live transcript');

select is(public.rehearsal_live_prepare('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')->>'state','new','warmup has one atomic claim');
select is(public.rehearsal_live_prepare('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')->>'state','reserved','concurrent warmup remains in progress');
select public.rehearsal_live_prepared('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333');
select is(public.rehearsal_live_prepare('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')->>'state','completed','completed warmup replays without compute');
select throws_ok($$select public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',1,repeat('a',64),160000,false)$$,'P0001','live_order','out of order chunk cannot start');
select is(public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',0,repeat('a',64),160000,false)->>'state','new','first chunk claims compute');
select is(public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',0,repeat('a',64),160000,false)->>'state','reserved','inflight chunk does not claim compute twice');
select throws_ok($$select public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',0,repeat('b',64),160000,false)$$,'P0001','request_conflict','same sequence cannot replace audio');
select public.rehearsal_live_chunk_done('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',0,'Um, practice helps.');
select is(public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',0,repeat('a',64),160000,false)->>'text','Um, practice helps.','cached chunk preserves its original transcript');
select is(public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',1,repeat('b',64),1,true)->>'state','new','one sample ending is accepted');
select public.rehearsal_live_chunk_done('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',1,'');
select throws_ok($$select public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',2,repeat('c',64),160000,false)$$,'P0001','live_order','final chunk ends the sequence');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),(select reserved+300000 from live_test_baseline),'chunks and replay incur no extra reservations');

-- The old ten-minute batch timeout must not bypass the longer live lease.
update rehearsal_private.jobs set created_at=now()-interval '11 minutes' where recording_id='33333333-3333-4333-8333-333333333333';
select throws_ok($$select public.rehearsal_reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','77777777-7777-4777-8777-777777777777','transcribe',repeat('a',64),75000)$$,'P0001','request_busy','active live lease blocks ordinary paid requests after ten minutes');
select throws_ok($$select public.rehearsal_prepare_delete('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')$$,'P0001','request_busy','active live recording cannot be deleted after ten minutes');
select is(public.rehearsal_live_finish('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',10.0000625,320046)->>'complete','true','complete final WAV finalizes one private history entry');
select is((select status from public.rehearsal_recordings where id='33333333-3333-4333-8333-333333333333'),'transcribed','recording becomes transcribed only on finalization');
select is(public.rehearsal_live_finish('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',10.0000625,320046)->>'text','Um, practice helps.','finalization is idempotent');

select public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','Next live',repeat('b',64),300000);
select public.rehearsal_live_prepare('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555');
select public.rehearsal_live_prepared('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555');
select public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',0,repeat('a',64),160000,false);
select public.rehearsal_live_close('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',true);
select throws_ok($$select public.rehearsal_live_chunk_done('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',0,'Late result')$$,'P0001','live_closed','late result cannot revive a canceled session');
select is(public.rehearsal_live_finish('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',10,320044)->>'complete','false','cancelled live take can retain final audio for explicit batch fallback');
select is((select transcript from public.rehearsal_recordings where id='55555555-5555-4555-8555-555555555555'),null,'partial cancelled transcript cannot be treated as complete');
select lives_ok($$select public.rehearsal_prepare_delete('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')$$,'cancelled history is deletable');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),(select reserved+600000 from live_test_baseline),'cancel and delete preparation never refund spend');

select public.rehearsal_live_start('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','Ten minutes',repeat('c',64),300000);
select public.rehearsal_live_prepare('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777');
select public.rehearsal_live_prepared('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777');
update rehearsal_private.live_sessions set expires_at=now()-interval '1 second' where recording_id='77777777-7777-4777-8777-777777777777';
select throws_ok($$select public.rehearsal_live_chunk('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777',0,repeat('c',64),160000,false)$$,'P0001','live_closed','expired lease cannot admit another worker request');
update rehearsal_private.live_sessions set expires_at=now()+interval '12 minutes' where recording_id='77777777-7777-4777-8777-777777777777';
do $$ begin
  for i in 0..59 loop
    perform public.rehearsal_live_chunk('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777',i,lpad(i::text,64,'a'),160000,false);
    perform public.rehearsal_live_chunk_done('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777',i,'Um');
  end loop;
end $$;
select is((public.rehearsal_live_get('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777')->>'samples')::integer,9600000,'sixty chunks cover exactly600 seconds');
select is((select request_count from rehearsal_private.user_daily_usage where user_id='22222222-2222-4222-8222-222222222222' and day=(now() at time zone 'UTC')::date),1,'sixty chunks still consume just one user request');
select throws_ok($$select public.rehearsal_live_chunk('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777',60,repeat('c',64),160000,false)$$,'P0001','invalid_request','a sixty-first chunk cannot exceed the recording bound');
select throws_ok($$select public.rehearsal_live_finish('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777',599.9,19196844)$$,'P0001','live_duration','even a100ms missing ending cannot be silently accepted');
select is(public.rehearsal_live_finish('22222222-2222-4222-8222-222222222222','77777777-7777-4777-8777-777777777777',600,19200044)->>'complete','true','maximum600-second take finalizes correctly');
select throws_ok($$select public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Over budget',repeat('a',64),300000)$$,'P0001','budget_exhausted','global budget also bounds whole live sessions');
select ok(not exists(select 1 from public.rehearsal_recordings where id='99999999-9999-4999-8999-999999999999'),'failed admission leaves no abandoned storage slot');

-- Simulate a disconnected tab whose final claimed chunk never acknowledged.
update rehearsal_private.live_sessions set status='active',prepare_state='idle',audio_finalized=false,expires_at=now()-interval '1 second'
  where recording_id='55555555-5555-4555-8555-555555555555';
update rehearsal_private.jobs set status='reserved',created_at=now()-interval '13 minutes' where recording_id='55555555-5555-4555-8555-555555555555';
select throws_ok($$select public.rehearsal_live_prepare('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')$$,'P0001','live_closed','expired session cannot start warmup');
select throws_ok($$select public.rehearsal_live_chunk('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',1,repeat('c',64),160000,false)$$,'P0001','live_closed','expired session cannot admit the next chunk');
update rehearsal_private.limits set daily_budget_microusd=1300000+(select reserved from live_test_baseline);
select public.rehearsal_live_start('11111111-1111-4111-8111-111111111111','99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Replacement',repeat('a',64),300000);
select is((select status from rehearsal_private.live_sessions where recording_id='55555555-5555-4555-8555-555555555555'),'failed','new session expires the abandoned session');
select is((select status from rehearsal_private.jobs where recording_id='55555555-5555-4555-8555-555555555555'),'failed','abandoned reservation becomes terminal without refund');
select throws_ok($$select public.rehearsal_live_chunk_done('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',0,'Late old result')$$,'P0001','live_closed','late old chunk cannot revive after replacement');
select lives_ok($$select public.rehearsal_prepare_delete('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')$$,'expired abandoned history remains deletable');
select is((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),(select reserved+1200000 from live_test_baseline),'replacement charges once and retains all old debits');
select * from finish();
rollback;
