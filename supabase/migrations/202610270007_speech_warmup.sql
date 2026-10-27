-- Startup is an optional, bounded reservation, not a recording or a user job.
-- Reuse the existing project allowance and lock; uncertain calls stay debited.
alter table rehearsal_private.daily_usage
  add column speech_warmup_count integer not null default 0 check(speech_warmup_count>=0),
  add column speech_warmup_microusd bigint not null default 0 check(speech_warmup_microusd>=0);
alter table rehearsal_private.user_daily_usage
  add column speech_warmup_count integer not null default 0 check(speech_warmup_count>=0),
  add column speech_warmup_started_at timestamptz;
create table rehearsal_private.speech_warmup (
  singleton boolean primary key default true check(singleton),
  user_id uuid references auth.users(id) on delete set null,
  request_id uuid,
  started_at timestamptz,
  expires_at timestamptz,
  finished_at timestamptz,
  state text not null default 'idle' check(state in ('idle','pending','ready','failed'))
);
insert into rehearsal_private.speech_warmup(singleton) values(true);
alter table rehearsal_private.speech_warmup enable row level security;
revoke all on rehearsal_private.speech_warmup from public,anon,authenticated;

create function public.rehearsal_speech_warmup_reserve(p_user uuid,p_request uuid,p_cost bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare limits rehearsal_private.limits; previous rehearsal_private.speech_warmup;
  current_time_at_gate timestamptz:=clock_timestamp(); today date:=(clock_timestamp() at time zone 'UTC')::date;
begin
  if p_user is null or p_request is null or p_cost is null or p_cost<=0 or p_cost>100000000
    or not exists(select 1 from public.rehearsal_profiles where user_id=p_user) then raise exception 'invalid_request'; end if;
  select * into limits from rehearsal_private.limits where singleton for update;
  select * into previous from rehearsal_private.speech_warmup where singleton for update;
  current_time_at_gate:=clock_timestamp(); today:=(current_time_at_gate at time zone 'UTC')::date;
  if previous.state='pending' and previous.expires_at>current_time_at_gate then
    return jsonb_build_object('state','pending','ready',false);
  end if;
  if previous.state='ready' and previous.finished_at>current_time_at_gate-interval '30 seconds' then
    return jsonb_build_object('state','ready','ready',true);
  end if;
  -- A refresh, another tab, or another account cannot repeatedly wake the GPU.
  -- Do not contend with paid speech that is already in flight.
  if limits.requests_per_user_day=0 or previous.started_at>current_time_at_gate-interval '3 minutes'
    or exists(select 1 from rehearsal_private.jobs where kind='transcribe' and status='reserved'
      and created_at>current_time_at_gate-interval '12 minutes')
    or exists(select 1 from rehearsal_private.live_sessions where status='active' and expires_at>current_time_at_gate)
    or exists(select 1 from rehearsal_private.user_daily_usage where user_id=p_user
      and day>=today-1 and speech_warmup_started_at>current_time_at_gate-interval '30 minutes') then
    return jsonb_build_object('state','skipped','ready',false);
  end if;
  insert into rehearsal_private.daily_usage(day) values(today) on conflict do nothing;
  insert into rehearsal_private.user_daily_usage(user_id,day) values(p_user,today) on conflict do nothing;
  if (select speech_warmup_count from rehearsal_private.daily_usage where day=today)>=24
    or (select speech_warmup_count from rehearsal_private.user_daily_usage where user_id=p_user and day=today)>=2 then
    return jsonb_build_object('state','skipped','ready',false);
  end if;
  -- Speculative sign-ins can use at most a tenth of the shared daily allowance,
  -- leaving the rest for explicit rehearsal work. A smaller budget fails closed.
  if (select reserved_microusd from rehearsal_private.daily_usage where day=today)+p_cost>limits.daily_budget_microusd
    or (select speech_warmup_microusd from rehearsal_private.daily_usage where day=today)+p_cost>limits.daily_budget_microusd/10 then
    return jsonb_build_object('state','skipped','ready',false);
  end if;
  update rehearsal_private.daily_usage set reserved_microusd=reserved_microusd+p_cost,speech_warmup_count=speech_warmup_count+1,
    speech_warmup_microusd=speech_warmup_microusd+p_cost where day=today;
  update rehearsal_private.user_daily_usage set speech_warmup_count=speech_warmup_count+1,speech_warmup_started_at=current_time_at_gate where user_id=p_user and day=today;
  update rehearsal_private.speech_warmup set user_id=p_user,request_id=p_request,started_at=current_time_at_gate,
    expires_at=current_time_at_gate+interval '3 minutes',finished_at=null,state='pending' where singleton;
  return jsonb_build_object('state','new','ready',false);
end $$;

create function public.rehearsal_speech_warmup_finish(p_user uuid,p_request uuid,p_ready boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare accepted boolean;
begin
  if p_user is null or p_request is null or p_ready is null then raise exception 'invalid_request'; end if;
  update rehearsal_private.speech_warmup set state=case when p_ready then 'ready' else 'failed' end,finished_at=clock_timestamp()
    where singleton and user_id=p_user and request_id=p_request and state='pending' and expires_at>clock_timestamp()
    returning true into accepted;
  return jsonb_build_object('state',case when accepted then case when p_ready then 'ready' else 'unavailable' end else 'skipped' end,
    'ready',coalesce(accepted,false) and p_ready);
end $$;
revoke all on function public.rehearsal_speech_warmup_reserve(uuid,uuid,bigint),public.rehearsal_speech_warmup_finish(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.rehearsal_speech_warmup_reserve(uuid,uuid,bigint),public.rehearsal_speech_warmup_finish(uuid,uuid,boolean) to service_role;
