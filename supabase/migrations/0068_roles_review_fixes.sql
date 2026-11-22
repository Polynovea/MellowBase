-- 0068: fixes from the review of 0067 (database roles), plus a workspace guard on member_roles.
--
-- 1. 0067's `alter default privileges in schema public revoke execute on functions from public`
--    did nothing: PUBLIC's EXECUTE on new functions comes from the global default, which only the
--    form without `in schema` can revoke.
-- 2. On Supabase, anon and authenticated hold explicit EXECUTE grants (and schema-level defaults),
--    so revoking from PUBLIC alone left functions not covered by 0031/0032, among them
--    polynovea_apply_app_access(), callable through PostgREST's /rpc. Revoke from both roles, now
--    and by default, and keep doing it in the access helper.
-- 3. member_roles.role_id is not tied to a workspace, so a member of workspace A could be assigned
--    a role of workspace B. The actor resolver already ignores such rows; a trigger now refuses
--    them. Existing bad rows are kept in an archive table, then removed.

-- 1 and 2: default privileges for functions created later by the role running migrations.
alter default privileges revoke execute on functions from public;
do $$
declare
  grantee text;
begin
  foreach grantee in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('alter default privileges revoke execute on functions from %I', grantee);
      execute format('alter default privileges in schema public revoke execute on functions from %I', grantee);
    end if;
  end loop;
end;
$$;

-- The access helper (0067) now also revokes EXECUTE from anon and authenticated where they exist.
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

-- 3: member_roles may only join a member to a role of the same workspace.
create table if not exists public.member_roles_cross_workspace_archive (
  workspace_member_id uuid not null,
  role_id uuid not null,
  member_workspace_id uuid,
  role_workspace_id uuid,
  assigned_at timestamptz,
  archived_at timestamptz not null default now(),
  primary key (workspace_member_id, role_id)
);
alter table public.member_roles_cross_workspace_archive enable row level security;

with bad as (
  select mr.workspace_member_id, mr.role_id, wm.workspace_id as member_workspace_id,
         r.workspace_id as role_workspace_id, mr.created_at
  from public.member_roles mr
  join public.workspace_members wm on wm.id = mr.workspace_member_id
  join public.roles r on r.id = mr.role_id
  where r.workspace_id <> wm.workspace_id
), archived as (
  insert into public.member_roles_cross_workspace_archive
    (workspace_member_id, role_id, member_workspace_id, role_workspace_id, assigned_at)
  select workspace_member_id, role_id, member_workspace_id, role_workspace_id, created_at from bad
  on conflict do nothing
  returning workspace_member_id, role_id
)
delete from public.member_roles mr
using bad
where mr.workspace_member_id = bad.workspace_member_id and mr.role_id = bad.role_id;

create or replace function public.cms_member_roles_same_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.workspace_members wm
    join public.roles r on r.id = new.role_id
    where wm.id = new.workspace_member_id and r.workspace_id = wm.workspace_id
  ) then
    raise exception 'A member can only be given a role of their own workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists cms_member_roles_same_workspace on public.member_roles;
create trigger cms_member_roles_same_workspace
  before insert or update of workspace_member_id, role_id on public.member_roles
  for each row execute function public.cms_member_roles_same_workspace();

select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = '0068', updated_at = now() where singleton = true;
