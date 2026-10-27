begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Synthetic fixtures and rollback only; no speech/coaching call or real file.
insert into auth.users(id,email) values
 ('d1111111-1111-4111-8111-111111111111','cancel-a@example.test'),
 ('d2222222-2222-4222-8222-222222222222','cancel-b@example.test');
insert into public.rehearsal_recordings(id,user_id,title,duration_seconds,size_bytes,storage_path,status,transcript,report) values
 ('d3333333-3333-4333-8333-333333333333','d1111111-1111-4111-8111-111111111111','Saved A',1,32044,'d1111111-1111-4111-8111-111111111111/d3333333-3333-4333-8333-333333333333/audio.wav','analyzed','Saved transcript A','{"original":true}'),
 ('e3333333-3333-4333-8333-333333333333','d2222222-2222-4222-8222-222222222222','Saved B',1,32044,'d2222222-2222-4222-8222-222222222222/e3333333-3333-4333-8333-333333333333/audio.wav','transcribed','Saved transcript B',null);
insert into rehearsal_private.jobs(user_id,request_id,recording_id,kind,input_hash,reserved_microusd) values
 ('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444','d3333333-3333-4333-8333-333333333333','transcribe',repeat('a',64),1),
 ('d2222222-2222-4222-8222-222222222222','d4444444-4444-4444-8444-444444444444','e3333333-3333-4333-8333-333333333333','coach',repeat('b',64),1);

set local role authenticated;
select throws_ok($$select public.rehearsal_cancel_request('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'42501',null,'browser cannot submit its own cancellation identity');
select throws_ok($$select public.rehearsal_complete_request('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444','{}')$$,'42501',null,'browser cannot write job results directly');
select throws_ok($$select * from rehearsal_private.request_cancellations$$,'42501',null,'cancellation tombstones are private');
reset role;
set local role service_role;
select throws_ok($$select public.rehearsal_cancel_request('d2222222-2222-4222-8222-222222222222','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','another owner cannot cancel a guessed recording and request');
select is(public.rehearsal_cancel_request('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')->>'state','cancelled','owner cancels admitted batch work');
select is(public.rehearsal_get_request('d2222222-2222-4222-8222-222222222222','d4444444-4444-4444-8444-444444444444')->>'state','reserved','same guessed request ID in another account remains active');
select throws_ok($$select public.rehearsal_complete_request('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444','{"text":"Late text","durationSeconds":1}')$$,'P0001','request_cancelled','late transcription cannot commit after cancellation');
select public.rehearsal_finish('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444',false,null);
select is(public.rehearsal_get_request('d1111111-1111-4111-8111-111111111111','d4444444-4444-4444-8444-444444444444')->>'state','cancelled','late failure cannot change cancelled state');
reset role;
select is((select transcript from public.rehearsal_recordings where id='d3333333-3333-4333-8333-333333333333'),'Saved transcript A','cancellation preserves saved transcript');
select is((select report from public.rehearsal_recordings where id='d3333333-3333-4333-8333-333333333333'),' {"original":true}'::jsonb,'cancellation preserves saved report');
select is((select status from public.rehearsal_recordings where id='d3333333-3333-4333-8333-333333333333'),'analyzed','cancellation preserves saved recording state');
select is((select reserved_microusd from rehearsal_private.jobs where user_id='d1111111-1111-4111-8111-111111111111'),1::bigint,'cancelled inference is not refunded');

-- Completion wins its transaction before cancellation: its result is retained.
select is(public.rehearsal_complete_request('d2222222-2222-4222-8222-222222222222','d4444444-4444-4444-8444-444444444444','{"transcript":"Completed B","report":"saved"}'),' {"transcript":"Completed B","report":"saved"}'::jsonb,'completion persists exact coaching result');
select is(public.rehearsal_cancel_request('d2222222-2222-4222-8222-222222222222','e3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')->>'state','completed','cancel after completion preserves completed result');
select is((select transcript from public.rehearsal_recordings where id='e3333333-3333-4333-8333-333333333333'),'Completed B','completed recording remains saved');

-- Cancellation wins before admission: delayed submission consumes no quota.
select is(public.rehearsal_cancel_request('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d5555555-5555-4555-8555-555555555555')->>'state','cancelled','not-yet-admitted batch request can be cancelled');
select throws_ok($$select public.rehearsal_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d5555555-5555-4555-8555-555555555555','coach',repeat('a',64),1)$$,'P0001','request_cancelled','delayed admission is blocked by cancellation tombstone');
select is((select count(*) from rehearsal_private.jobs where user_id='d1111111-1111-4111-8111-111111111111' and request_id='d5555555-5555-4555-8555-555555555555'),0::bigint,'cancel-before-start consumes no job reservation');

update rehearsal_private.limits set daily_budget_microusd=coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)+100,requests_per_user_day=10;
select is(public.rehearsal_reserve('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d6666666-6666-4666-8666-666666666666','coach',repeat('c',64),1)->>'state','new','cancellation immediately releases per-user admission for a fresh request');
select is(public.rehearsal_cancel_request('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d6666666-6666-4666-8666-666666666666')->>'state','cancelled','new coaching request is cancellable too');
select throws_ok($$select public.rehearsal_complete_request('d1111111-1111-4111-8111-111111111111','d6666666-6666-4666-8666-666666666666','{"transcript":"Late coaching","report":"bad"}')$$,'P0001','request_cancelled','late coaching cannot overwrite previous report');
select is((select report from public.rehearsal_recordings where id='d3333333-3333-4333-8333-333333333333'),' {"original":true}'::jsonb,'late canceled coaching leaves old report intact');
select is(public.rehearsal_reserve('d2222222-2222-4222-8222-222222222222','e3333333-3333-4333-8333-333333333333','d5555555-5555-4555-8555-555555555555','transcribe',repeat('d',64),1)->>'state','new','one user tombstone cannot block matching request ID for another user');
select is(public.rehearsal_complete_request('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555','{"text":"New B transcript","durationSeconds":1}')->>'text','New B transcript','successful transcription commits recording and job together');
select is((select transcript from public.rehearsal_recordings where id='e3333333-3333-4333-8333-333333333333'),'New B transcript','atomic transcription result reaches the saved recording');

select * from finish();
rollback;
