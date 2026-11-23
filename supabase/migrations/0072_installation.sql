-- 0072: the installation row (self-hosted upgrade, phase 2: setup wizard).
--
-- One row, written by the wizard's owner step in the same transaction that creates the owner. While
-- the row exists the app never re-enters setup mode, and every /setup route returns 404
-- (lib/setup/mode.ts). The primary key on a boolean that must be true allows exactly one row, so two
-- browsers finishing setup at once cannot both win: the second insert fails on the key.
--
-- polynovea_app may read the row and insert it once. It gets no UPDATE, DELETE or TRUNCATE: a stolen
-- app login must not be able to delete the row and reopen setup on a live install. Fixing the row
-- (for example after restoring a backup) is an owner-role job. The row-level security policy is the
-- same permissive one every table has (lib/db/roles.dual.test.ts checks it); the table privileges are
-- what limit the app role here.
--
-- Existing installs (set up with `bootstrap:admin` before the wizard existed) already have an owner,
-- so they get their row here and keep running after the upgrade instead of dropping into setup mode.

create table if not exists public.installation (
  singleton boolean primary key default true check (singleton),
  install_id uuid not null default gen_random_uuid(),
  organisation_name text not null check (length(btrim(organisation_name)) between 1 and 200),
  owner_admin_user_id uuid references public.admin_users (id) on delete restrict,
  database_mode text not null check (database_mode in ('local', 'managed', 'created')),
  completed_at timestamptz not null default now(),
  app_version text
);

comment on table public.installation is
  'Setup is finished while this single row exists. The app role may read and insert it, never change or delete it.';
comment on column public.installation.owner_admin_user_id is
  'The owner created by the setup wizard. Empty only on installs set up before the wizard whose master admin was later removed.';

alter table public.installation enable row level security;

-- Existing installs: the oldest active master admin is the owner, the oldest workspace names the
-- organisation. A fresh database has no admin yet, so nothing is inserted and setup runs.
insert into public.installation (organisation_name, owner_admin_user_id, database_mode, completed_at)
select
  coalesce((select w.name from public.workspaces w order by w.created_at nulls last, w.id limit 1), 'Polynovea CMS'),
  a.id,
  'managed',
  coalesce(a.created_at, now())
from public.admin_users a
where a.role = 'master' and coalesce(a.is_active, true)
order by a.created_at nulls last, a.id
limit 1
on conflict (singleton) do nothing;

-- The access helper from 0067/0068, unchanged except for the installation table: the app role gets
-- SELECT and INSERT there and any UPDATE, DELETE or TRUNCATE is taken away again, so the later
-- migrations that end with `select public.polynovea_apply_app_access()` keep the restriction.
create or replace function public.polynovea_apply_app_access()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item record;
  grantee text;
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  api_roles text[] := array(select rolname::text from pg_roles where rolname in ('anon', 'authenticated'));
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
    elsif item.relname = 'installation' then
      -- Read, and insert once at the end of setup. Never change or delete (0072).
      execute 'grant select, insert on public.installation to polynovea_app';
      execute 'revoke update, delete, truncate on public.installation from polynovea_app';
      if has_service_role then
        execute 'revoke update, delete, truncate on public.installation from service_role';
      end if;
      foreach grantee in array api_roles loop
        execute format('revoke all on public.installation from %I', grantee);
      end loop;
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

  -- Functions: EXECUTE for polynovea_app (and service_role on Supabase), never for PUBLIC, anon or
  -- authenticated. Extension functions (pg_trgm) keep their defaults.
  for item in
    select p.oid::regprocedure as signature, p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and pg_catalog.pg_has_role(p.proowner, 'USAGE')
      and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public', item.signature);
    foreach grantee in array api_roles loop
      execute format('revoke execute on function %s from %I', item.signature, grantee);
    end loop;
    if item.proname = 'polynovea_apply_app_access' then
      continue; -- for migrations only
    end if;
    execute format('grant execute on function %s to polynovea_app', item.signature);
    if has_service_role then
      execute format('grant execute on function %s to service_role', item.signature);
    end if;
  end loop;
end;
$$;

revoke all on function public.polynovea_apply_app_access() from public;

select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = '0072', updated_at = now() where singleton = true;
