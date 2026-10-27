-- Hosted Supabase may install this event-trigger helper outside app migrations.
-- It needs no browser EXECUTE grant: PostgreSQL invokes event triggers itself.
-- Preserve its definition, owner, and trigger, and do nothing on fresh local DBs.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    if not exists (
      select 1 from pg_catalog.pg_proc
      where oid=to_regprocedure('public.rls_auto_enable()')
        and prorettype='pg_catalog.event_trigger'::regtype and prosecdef
    ) then
      raise exception 'Unexpected public.rls_auto_enable function; review its permissions manually';
    end if;
    revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
  end if;
end $$;
