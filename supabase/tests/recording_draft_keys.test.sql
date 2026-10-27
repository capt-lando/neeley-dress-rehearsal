begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email) values
 ('d1111111-1111-4111-8111-111111111111','draft-a@example.test'),
 ('d2222222-2222-4222-8222-222222222222','draft-b@example.test');
update rehearsal_private.limits set daily_budget_microusd=coalesce((select reserved_microusd from rehearsal_private.daily_usage where day=(now() at time zone 'UTC')::date),0)+1000000,
 requests_per_user_day=10,max_saved_recordings=10,max_total_recordings=100000;

set local role anon;
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'42501',null,'anonymous client cannot fetch decryption keys');
reset role;
set local role authenticated;
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'42501',null,'browser cannot call key RPC directly');
select throws_ok($$select draft_key from rehearsal_private.live_sessions$$,'42501',null,'browser cannot read private draft keys');
reset role;

create temporary table draft_original(key text);
insert into draft_original select public.rehearsal_stream_start('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444','Draft',repeat('a',64),300000)->>'draft_key';
select matches((select key from draft_original),'^[A-Za-z0-9_-]{43}$','new stream atomically receives a base64url256-bit key');
select is(octet_length(decode(translate((select key from draft_original),'-_','+/')||'=','base64')),32,'key decodes to32 random bytes');
select is(public.rehearsal_stream_start('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444','Draft',repeat('a',64),300000)->>'draft_key',(select key from draft_original),'idempotent admission never changes the draft key');
select ok((select draft_key_expires_at between clock_timestamp()+interval '23 hours 59 minutes' and clock_timestamp()+interval '24 hours 1 minute' from rehearsal_private.live_sessions where recording_id='d3333333-3333-4333-8333-333333333333'),'key has a bounded24-hour lifetime');
select ok((select r.upload_expires_at>=s.draft_key_expires_at from public.rehearsal_recordings r join rehearsal_private.live_sessions s on s.recording_id=r.id where r.id='d3333333-3333-4333-8333-333333333333'),'draft upload reservation lasts through the key recovery window');

set local role service_role;
select throws_ok($$select public.rehearsal_live_draft_key(null,'d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'P0001','invalid_request','null owner is rejected');
select throws_ok($$select public.rehearsal_live_draft_key('d2222222-2222-4222-8222-222222222222','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','other account cannot decrypt a known recording and request');
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d5555555-5555-4555-8555-555555555555')$$,'P0001','not_found','wrong request has indistinguishable missing-key response');
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d5555555-5555-4555-8555-555555555555','d4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','unknown recording has indistinguishable missing-key response');
select lives_ok($$select public.rehearsal_live_cancel('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'refresh can cancel the stream before decrypting its saved local audio');
reset role;
select is(public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')->>'draft_key',(select key from draft_original),'cancelled session retains its owner recovery key');

update rehearsal_private.live_sessions set draft_key_expires_at=clock_timestamp()-interval '1 second' where recording_id='d3333333-3333-4333-8333-333333333333';
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','expired key is not returned');
update rehearsal_private.live_sessions set draft_key_expires_at=clock_timestamp()+interval '1 hour' where recording_id='d3333333-3333-4333-8333-333333333333';
update public.rehearsal_recordings set status='deleting' where id='d3333333-3333-4333-8333-333333333333';
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','deleting recording cannot expose a recovery key');
update public.rehearsal_recordings set status='pending' where id='d3333333-3333-4333-8333-333333333333';
select throws_ok($$select public.rehearsal_stream_finalize('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',1,44)$$,'P0001','invalid_request','failed finalization never destroys the recovery key');
select is(public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')->>'draft_key',(select key from draft_original),'key survives a failed save');
select is(public.rehearsal_stream_finalize('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333',1,32044)->>'complete','false','cancelled take may still save complete audio');
select is((select draft_key from rehearsal_private.live_sessions where recording_id='d3333333-3333-4333-8333-333333333333'),null::text,'successful audio finalization erases the key');
select is((select draft_key_expires_at from rehearsal_private.live_sessions where recording_id='d3333333-3333-4333-8333-333333333333'),null::timestamptz,'successful audio finalization clears key expiry');
select throws_ok($$select public.rehearsal_live_draft_key('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444')$$,'P0001','not_found','saved audio cannot fetch an obsolete decryption key');
select is(public.rehearsal_stream_start('d1111111-1111-4111-8111-111111111111','d3333333-3333-4333-8333-333333333333','d4444444-4444-4444-8444-444444444444','Draft',repeat('a',64),300000)->>'draft_key',null::text,'replayed old start never recreates a finalized key');
select isnt(public.rehearsal_stream_start('d2222222-2222-4222-8222-222222222222','d5555555-5555-4555-8555-555555555555','d6666666-6666-4666-8666-666666666666','Other draft',repeat('b',64),300000)->>'draft_key',(select key from draft_original),'each admitted recording receives an independent random key');
delete from public.rehearsal_recordings where id='d5555555-5555-4555-8555-555555555555';
select is((select count(*) from rehearsal_private.live_sessions where recording_id='d5555555-5555-4555-8555-555555555555'),0::bigint,'recording deletion cascades to the key');
select * from finish();
rollback;
