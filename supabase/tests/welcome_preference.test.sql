begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id) values
  ('b1111111-1111-4111-8111-111111111111'),
  ('b2222222-2222-4222-8222-222222222222');
insert into auth.sessions(id,user_id,created_at,updated_at) values
  ('c1111111-1111-4111-8111-111111111111','b1111111-1111-4111-8111-111111111111',now(),now()),
  ('c2222222-2222-4222-8222-222222222222','b1111111-1111-4111-8111-111111111111',now(),now()),
  ('c3333333-3333-4333-8333-333333333333','b1111111-1111-4111-8111-111111111111',now(),now()),
  ('d1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222',now(),now());

select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111'),
  '{"signInCount":3,"dontShowAgain":false}'::jsonb,'three actual sign-ins remain eligible');
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111')->>'signInCount',
  '3','repeated page visits do not count as sign-ins');
update auth.sessions set refreshed_at=clock_timestamp(),updated_at=clock_timestamp(),refresh_token_counter=2
  where id='c3333333-3333-4333-8333-333333333333';
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111')->>'signInCount',
  '3','token refresh does not count as another sign-in');
select is(public.rehearsal_welcome_preference('b2222222-2222-4222-8222-222222222222'),
  '{"signInCount":1,"dontShowAgain":false}'::jsonb,'another account has its own sign-in count');

delete from auth.sessions where user_id='b1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111')->>'signInCount',
  '3','logout cleanup never erases remembered sign-ins');
insert into auth.sessions(id,user_id,created_at) values
  ('c4444444-4444-4444-8444-444444444444','b1111111-1111-4111-8111-111111111111',now());
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111')->>'signInCount',
  '4','fourth distinct login reaches the permanent automatic-popup cutoff');
insert into auth.sessions(id,user_id,created_at) values
  ('c5555555-5555-4555-8555-555555555555','b1111111-1111-4111-8111-111111111111',now());
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111')->>'signInCount',
  '4','count and stored identifiers stay capped at the only needed threshold');
delete from auth.sessions where user_id='b1111111-1111-4111-8111-111111111111';
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111'),
  '{"signInCount":4,"dontShowAgain":false}'::jsonb,'established account stays suppressed even after all sessions are removed');

select is(public.rehearsal_welcome_preference('b2222222-2222-4222-8222-222222222222',true),
  '{"signInCount":1,"dontShowAgain":true}'::jsonb,'explicit checkbox preference saves independently of sign-in count');
select is(public.rehearsal_welcome_preference('b2222222-2222-4222-8222-222222222222')->>'dontShowAgain',
  'true','another browser sees the stored account preference');
select is(public.rehearsal_welcome_preference('b2222222-2222-4222-8222-222222222222',false)->>'dontShowAgain',
  'false','manual help can clear the explicit checkbox preference');
select is(public.rehearsal_welcome_preference('b1111111-1111-4111-8111-111111111111',false)->>'signInCount',
  '4','clearing the checkbox cannot reset the permanent fourth-login cutoff');
select throws_ok($$select public.rehearsal_welcome_preference(null)$$,'P0001','invalid_request','no null owner');
select throws_ok($$select public.rehearsal_welcome_preference('b3333333-3333-4333-8333-333333333333')$$,
  'P0001','invalid_request','no nonexistent owner');

select ok(not has_table_privilege('authenticated','rehearsal_private.welcome_preferences','SELECT,INSERT,UPDATE,DELETE'),
  'browser role cannot read identifiers or forge preferences');
select ok(not has_function_privilege('authenticated','public.rehearsal_welcome_preference(uuid,boolean)','EXECUTE'),
  'browser role cannot choose another account through the RPC');
select ok(not has_function_privilege('anon','public.rehearsal_welcome_preference(uuid,boolean)','EXECUTE'),
  'anonymous cannot access the account RPC');
select ok(has_function_privilege('service_role','public.rehearsal_welcome_preference(uuid,boolean)','EXECUTE'),
  'verified gateway can call the account RPC');

delete from auth.users where id='b1111111-1111-4111-8111-111111111111';
select is((select count(*) from rehearsal_private.welcome_preferences where user_id='b1111111-1111-4111-8111-111111111111'),
  0::bigint,'account deletion removes its welcome state');
select * from finish();
rollback;
