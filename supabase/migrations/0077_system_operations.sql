-- 0077: system operations (self-hosted upgrade, phase 5 wave 3).
--
-- Two installation-wide records the System page and the System Doctor read:
--
-- * system_upgrades: one row per in-app upgrade. The CMS records the request when an admin starts it;
--   the host upgrade agent (release/packer/files/upgrade.sh) runs it and writes a status file; whichever
--   CMS comes up afterwards (the new release, or the old one after a switch-back) records the agent's
--   steps here and in platform_audit_events.
-- * system_restore_tests: one row per restore test of the bundled database's backups (a worker job,
--   monthly, and once after setup's first backup).
--
-- Both are read-only for polynovea_app (the access helper's read_only list). The app changes them only
-- through the five functions below, which check every value; on Supabase, service_role cannot write
-- them or call the functions.
--
-- cms_runtime_state gains worker_heartbeat_at, written by the delivery worker on every loop.

create table if not exists public.system_upgrades (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  from_release text check (from_release is null or from_release ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$'),
  to_release text not null check (to_release ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$'),
  to_version text not null check (to_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]{1,64})?$'),
  to_digest text check (to_digest is null or to_digest ~ '^sha256:[0-9a-f]{64}$'),
  rollback_mode text not null check (rollback_mode in ('compatible', 'restore')),
  status text not null default 'requested'
    check (status in ('requested', 'running', 'succeeded', 'rolled_back', 'restore_needed', 'failed')),
  steps_json jsonb not null default '[]'::jsonb check (jsonb_typeof(steps_json) = 'array'),
  requested_by uuid references public.admin_users (id) on delete set null,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
-- At most one upgrade in flight.
create unique index if not exists system_upgrades_one_open
  on public.system_upgrades ((true)) where status in ('requested', 'running');
create index if not exists system_upgrades_requested_at on public.system_upgrades (requested_at desc, id);

create table if not exists public.system_restore_tests (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (reason in ('monthly', 'first_backup', 'manual')),
  status text not null default 'running' check (status in ('running', 'passed', 'failed', 'skipped')),
  backup_label text check (backup_label is null or backup_label ~ '^[0-9A-Za-z_-]{1,64}$'),
  checks_json jsonb not null default '{}'::jsonb check (jsonb_typeof(checks_json) = 'object'),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  error_message text check (error_message is null or length(error_message) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists system_restore_tests_one_running
  on public.system_restore_tests ((true)) where status = 'running';
create index if not exists system_restore_tests_started_at on public.system_restore_tests (started_at desc, id);

alter table public.system_upgrades enable row level security;
alter table public.system_restore_tests enable row level security;

alter table public.cms_runtime_state add column if not exists worker_heartbeat_at timestamptz;

-- ── Functions (EXECUTE for polynovea_app only) ───────────────────────────────────────────────────

-- An admin starts an upgrade. Refuses a second one while another is requested or running.
create or replace function public.polynovea_system_upgrade_request(
  p_request_id uuid, p_from_release text, p_to_release text, p_to_version text, p_rollback_mode text, p_requested_by uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.system_upgrades where status in ('requested', 'running')) then
    raise exception 'another upgrade is in progress' using errcode = 'P0001';
  end if;
  insert into public.system_upgrades (request_id, from_release, to_release, to_version, rollback_mode, requested_by)
  values (p_request_id, p_from_release, p_to_release, p_to_version, p_rollback_mode, p_requested_by)
  returning id into v_id;
  return v_id;
end;
$$;

-- Records the agent's progress. Status only moves forward (requested → running → a final status), and
-- a final status is never changed. Steps replace the previous list (the agent's file is the whole
-- history), capped at 64 KB.
create or replace function public.polynovea_system_upgrade_record(
  p_request_id uuid, p_status text, p_steps jsonb, p_to_digest text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
  v_rank_old integer;
  v_rank_new integer;
begin
  if p_status is null or p_status not in ('running', 'succeeded', 'rolled_back', 'restore_needed', 'failed') then
    raise exception 'unknown upgrade status' using errcode = '22023';
  end if;
  if p_steps is null or pg_catalog.jsonb_typeof(p_steps) <> 'array' or pg_catalog.octet_length(p_steps::text) > 65536 then
    raise exception 'upgrade steps must be a JSON array under 64 KB' using errcode = '22023';
  end if;
  select status into v_current from public.system_upgrades where request_id = p_request_id for update;
  if v_current is null then return false; end if;
  v_rank_old := case v_current when 'requested' then 0 when 'running' then 1 else 2 end;
  v_rank_new := case p_status when 'running' then 1 else 2 end;
  if v_rank_old = 2 or v_rank_new < v_rank_old then return false; end if;
  update public.system_upgrades
     set status = p_status,
         steps_json = p_steps,
         to_digest = coalesce(p_to_digest, to_digest),
         finished_at = case when v_rank_new = 2 then now() else null end,
         updated_at = now()
   where request_id = p_request_id;
  return true;
end;
$$;

-- Starts a restore test; returns null while another one runs. A test still "running" after 6 hours was
-- interrupted (its process died): it is closed as failed first, so it never blocks the next one.
create or replace function public.polynovea_system_restore_test_begin(p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.system_restore_tests
     set status = 'failed', error_code = 'INTERRUPTED', error_message = 'The restore test stopped before it finished.',
         finished_at = now()
   where status = 'running' and started_at < now() - interval '6 hours';
  if exists (select 1 from public.system_restore_tests where status = 'running') then
    return null;
  end if;
  insert into public.system_restore_tests (reason) values (p_reason) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.polynovea_system_restore_test_finish(
  p_id uuid, p_status text, p_backup_label text, p_checks jsonb, p_error_code text, p_error_message text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('passed', 'failed', 'skipped') then
    raise exception 'unknown restore test status' using errcode = '22023';
  end if;
  if p_checks is null or pg_catalog.jsonb_typeof(p_checks) <> 'object' or pg_catalog.octet_length(p_checks::text) > 65536 then
    raise exception 'restore test checks must be a JSON object under 64 KB' using errcode = '22023';
  end if;
  update public.system_restore_tests
     set status = p_status, backup_label = p_backup_label, checks_json = p_checks,
         error_code = p_error_code, error_message = p_error_message, finished_at = now()
   where id = p_id and status = 'running';
  return found;
end;
$$;

-- Run by the worker when it starts: a restore test still "running" then was cut off by a restart (only
-- the worker of this server runs them, one at a time). Recorded as skipped, not failed, and the worker runs
-- the test again; a test stuck for 6 hours with no restart is closed as failed by _begin above.
create or replace function public.polynovea_system_restore_test_interrupted()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.system_restore_tests
     set status = 'skipped', error_code = 'INTERRUPTED',
         error_message = 'The restore test stopped when the server restarted; it runs again.', finished_at = now()
   where status = 'running';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── App access ───────────────────────────────────────────────────────────────────────────────────
-- 0076's helper exactly as it is there (copied from payal/p3-content-move-r2 at 8ea8899; re-check
-- against the merged 0076 on rebase), with two additions only: system_upgrades and
-- system_restore_tests join the read_only list, and the five system functions join
-- app_only_functions (EXECUTE for polynovea_app only, never service_role).
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
  read_only text[] := array[
    'polynovea_migration_ledger', 'schema_migration_runs', 'schema_expand_contract_tasks',
    'content_model_tables', 'schema_name_reservations', 'schema_migration_confirmations',
    'content_model_storage', 'content_model_move_runs',
    'system_upgrades', 'system_restore_tests'];
  ledger_request_columns text := 'workspace_id, content_model_id, model_api_key, table_name, stage, plan_hash, '
    || 'base_shape_hash, target_schema_hash, plan_json, requested_by, target_version_id, renames';
  app_only_functions text[] := array['polynovea_confirm_schema_stage', 'polynovea_retry_schema_stage', 'polynovea_cancel_schema_stage',
    'polynovea_content_sync_entries', 'polynovea_content_verify_model', 'polynovea_content_set_read_source',
    'polynovea_content_entries_sync',
    'polynovea_system_upgrade_request', 'polynovea_system_upgrade_record',
    'polynovea_system_restore_test_begin', 'polynovea_system_restore_test_finish',
    'polynovea_system_restore_test_interrupted'];
begin
  execute 'grant usage on schema public to polynovea_app';

  for item in
    select c.relname, c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and pg_catalog.pg_has_role(c.relowner, 'USAGE')
  loop
    if item.relname = any (read_only) then
      -- Written by migrations, the migration worker or the engine's bookkeeping (polynovea_owner).
      execute format('grant select on public.%I to polynovea_app', item.relname);
      execute format('revoke insert, update, delete, truncate on public.%I from polynovea_app', item.relname);
      foreach grantee in array api_roles loop
        execute format('revoke all on public.%I from %I', item.relname, grantee);
      end loop;
      -- On Supabase, default privileges give service_role everything; the service key must not write here.
      if has_service_role then
        execute format('revoke insert, update, delete, truncate on public.%I from service_role', item.relname);
      end if;
    elsif item.relname = 'schema_migration_ledger' then
      -- Requests only: insert these columns, read the rows. Status changes are the owner's.
      execute 'grant select on public.schema_migration_ledger to polynovea_app';
      execute 'revoke insert, update, delete, truncate on public.schema_migration_ledger from polynovea_app';
      execute format('grant insert (%s) on public.schema_migration_ledger to polynovea_app', ledger_request_columns);
      foreach grantee in array api_roles loop
        execute format('revoke all on public.schema_migration_ledger from %I', grantee);
      end loop;
      if has_service_role then
        -- At most SELECT: requests come through polynovea_app's column INSERT only.
        execute 'revoke insert, update, delete, truncate on public.schema_migration_ledger from service_role';
      end if;
    elsif item.relname = 'content_model_versions' then
      execute 'grant select, insert on public.content_model_versions to polynovea_app';
      execute 'revoke update, delete, truncate on public.content_model_versions from polynovea_app';
      if has_service_role then
        execute 'revoke update, delete, truncate on public.content_model_versions from service_role';
      end if;
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
    if item.proname = any (app_only_functions) then
      if has_service_role then
        execute format('revoke execute on function %s from service_role', item.signature);
      end if;
      continue;
    end if;
    if has_service_role then
      execute format('grant execute on function %s to service_role', item.signature);
    end if;
  end loop;
end;
$$;

revoke all on function public.polynovea_apply_app_access() from public;
revoke all on function public.polynovea_system_upgrade_request(uuid, text, text, text, text, uuid) from public;
revoke all on function public.polynovea_system_upgrade_record(uuid, text, jsonb, text) from public;
revoke all on function public.polynovea_system_restore_test_begin(text) from public;
revoke all on function public.polynovea_system_restore_test_finish(uuid, text, text, jsonb, text, text) from public;
revoke all on function public.polynovea_system_restore_test_interrupted() from public;

select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = greatest(schema_migration, '0077'), updated_at = now() where singleton = true;
