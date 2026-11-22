-- 0067: database roles for installs without Supabase (self-hosted upgrade, phase 1).
--
--   polynovea_owner  owns the schema and its objects and runs migrations.
--   polynovea_app    the runtime login: reads and writes rows and executes functions. No DDL.
--
-- Every table already has row-level security switched on with no policies. Supabase's service_role
-- bypasses that; polynovea_app must not get BYPASSRLS (a managed database's admin login may not be
-- allowed to grant it), so each table gets an explicit permissive policy for polynovea_app instead.
-- Permissions and tenant scoping stay in application code, exactly as on the service-role path.
--
-- On a Supabase install this migration runs as `postgres`: it creates the two roles (NOLOGIN; the
-- installer sets LOGIN and a password), mirrors service_role's grants onto polynovea_app and leaves
-- every existing grant in place, so both data paths keep working during phase 1. Object ownership is
-- not moved there: the tables belong to `postgres`, and a SECURITY DEFINER function owned by a role
-- that does not own the tables would lose its row-level security bypass. On a plain install the
-- migrations run as polynovea_owner, which therefore already owns every table and function.
--
-- The roles that migrations 0003-0065 grant to (anon, authenticated, service_role, postgres) must
-- exist before those migrations run, so on a plain database they are created by the pre-migration
-- step in scripts/run-migrations.mjs (lib/db/roles.mjs), not here.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'polynovea_owner') then
    create role polynovea_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'polynovea_app') then
    create role polynovea_app nologin;
  end if;
end;
$$;

-- Grants, row-level security policies and function EXECUTE rights for polynovea_app on everything in
-- schema public. Idempotent; later migrations that add tables or functions end with
--   select public.polynovea_apply_app_access();
-- and lib/db/roles.dual.test.ts fails if any row-level-security table is left without the policy.
create or replace function public.polynovea_apply_app_access()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item record;
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  execute 'grant usage on schema public to polynovea_app';

  for item in
    select c.relname, c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and pg_catalog.pg_has_role(c.relowner, 'USAGE')
  loop
    if item.relname = 'polynovea_migration_ledger' then
      -- Migrations write the ledger; the runtime only reads it (pending-migration checks).
      execute format('grant select on public.%I to polynovea_app', item.relname);
    else
      execute format('grant select, insert, update, delete on public.%I to polynovea_app', item.relname);
    end if;
    if item.relrowsecurity and not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = item.relname and p.policyname = 'polynovea_app_all'
    ) then
      execute format(
        'create policy polynovea_app_all on public.%I for all to polynovea_app using (true) with check (true)',
        item.relname
      );
    end if;
  end loop;

  for item in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S' and pg_catalog.pg_has_role(c.relowner, 'USAGE')
  loop
    execute format('grant usage, select on sequence public.%I to polynovea_app', item.relname);
  end loop;

  -- Functions: EXECUTE for polynovea_app (and service_role on Supabase, which keeps its path working),
  -- never for PUBLIC. Extension functions (pg_trgm) keep their defaults; this helper itself is for
  -- migrations only.
  for item in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and p.proname <> 'polynovea_apply_app_access'
      and pg_catalog.pg_has_role(p.proowner, 'USAGE')
      and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public', item.signature);
    execute format('grant execute on function %s to polynovea_app', item.signature);
    if has_service_role then
      execute format('grant execute on function %s to service_role', item.signature);
    end if;
  end loop;
end;
$$;

revoke all on function public.polynovea_apply_app_access() from public;

select public.polynovea_apply_app_access();

-- Objects that later migrations create (as the role running them) are reachable by the app role
-- without a grant in each migration. Row-level security policies have no default, hence the helper.
alter default privileges in schema public grant select, insert, update, delete on tables to polynovea_app;
alter default privileges in schema public grant usage, select on sequences to polynovea_app;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to polynovea_app;

-- Nobody but the schema owner creates objects in public (PostgreSQL 14 and earlier allowed everyone).
revoke create on schema public from public;

update public.cms_runtime_state
set schema_migration = '0067', updated_at = now() where singleton = true;
