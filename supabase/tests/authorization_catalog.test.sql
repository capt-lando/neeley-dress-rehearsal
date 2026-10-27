-- Metadata-only regression: no accounts, recordings, or storage objects created.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

select ok(count(*)>0,'app RPC inventory is nonempty') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'rehearsal\_%' escape '\';
select ok(not has_function_privilege(role_name,p.oid,'EXECUTE'),role_name||' cannot execute '||p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join (values('anon'),('authenticated')) roles(role_name)
  where n.nspname='public' and p.proname like 'rehearsal\_%' escape '\' order by p.oid::regprocedure::text,role_name;
select ok(has_function_privilege('service_role',p.oid,'EXECUTE'),'gateway can execute '||p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'rehearsal\_%' escape '\' order by p.oid::regprocedure::text;
select ok(p.prosecdef and p.proconfig @> array['search_path=""'],'RPC pins an empty privileged search path: '||p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'rehearsal\_%' escape '\' order by p.oid::regprocedure::text;

select ok(not has_schema_privilege(role_name,'rehearsal_private','USAGE,CREATE'),role_name||' cannot enter the private schema')
  from (values('anon'),('authenticated')) roles(role_name);
select ok(c.relrowsecurity,'RLS protects private table '||c.relname)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='rehearsal_private' and c.relkind in ('r','p') order by c.relname;
select ok(not has_table_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),role_name||' has no direct grant on private table '||c.relname)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values('anon'),('authenticated')) roles(role_name)
  where n.nspname='rehearsal_private' and c.relkind in ('r','p') order by c.relname,role_name;
select ok(c.relrowsecurity,'RLS protects public app table '||c.relname)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname like 'rehearsal\_%' escape '\' and c.relkind in ('r','p') order by c.relname;
select ok(not has_table_privilege(role_name,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),role_name||' cannot mutate public app table '||c.relname)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values('anon'),('authenticated')) roles(role_name)
  where n.nspname='public' and c.relname like 'rehearsal\_%' escape '\' and c.relkind in ('r','p') order by c.relname,role_name;
select ok(not has_table_privilege('anon',c.oid,'SELECT'),'anonymous cannot read public app table '||c.relname)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname like 'rehearsal\_%' escape '\' and c.relkind in ('r','p') order by c.relname;
select ok(not has_table_privilege('authenticated','public.rehearsal_events','SELECT'),'raw analytics are not readable by browser roles');

select ok(not public and file_size_limit=20971520 and allowed_mime_types=array['audio/wav'],'recordings bucket remains private and limited to WAV uploads')
  from storage.buckets where id='recordings';
select ok(not has_function_privilege(role_name,p.oid,'EXECUTE'),role_name||' cannot execute hosted RLS event helper')
  from pg_proc p cross join (values('anon'),('authenticated')) roles(role_name)
  where p.oid=to_regprocedure('public.rls_auto_enable()');

select * from finish();
rollback;
