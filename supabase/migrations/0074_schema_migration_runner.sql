-- 0074: the schema migration runner (self-hosted upgrade, phase 3: real tables).
--
-- The runner (lib/schema/runner/, process scripts/schema-migration-worker.mjs) applies the plan stages
-- the schema engine writes to schema_migration_ledger (0073). It runs as polynovea_owner on its own
-- connection pool; the request that asked for a change never holds owner rights. This migration adds
-- what the runner keeps for itself:
--
--   schema_migration_runs          one row per ledger stage: the worker running it, the position it
--                                  reached (to resume a crashed run per statement) and per-step timings
--   schema_expand_contract_tasks   renames and type changes done by expand and contract: the columns,
--                                  trigger, backfill position, and when the old column is dropped
--   polynovea_schema_dual_write()  the one trigger function every expand/contract uses
--
-- The app role requests a change by INSERTING a ledger row, nothing more: it may set only the request's
-- own columns, never a status, and may never update or delete a row. A trigger sets the status from
-- the stage. Confirming a deletion and retrying a failed stage go through two owner-side functions
-- (below), and a confirmation is its own row in schema_migration_confirmations. The runner still never
-- trusts a ledger row: it rebuilds the plan from trusted state and runs only what it rendered itself.
-- Its own tables (runs, expand/contract tasks, confirmations) are read-only for the app.
--
--   schema_migration_confirmations one row per confirmed destructive stage: who typed the model's api
--                                  key, and when

-- ── Runs ──────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.schema_migration_runs (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null unique references public.schema_migration_ledger (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_model_id uuid references public.content_models (id) on delete set null,
  stage text not null check (stage in ('expand', 'destructive')),
  status text not null check (status in ('running', 'succeeded', 'failed', 'refused')),
  worker_id text not null check (char_length(worker_id) between 1 and 200),
  -- The next statement to run: steps of this stage in plan order, statements of a step in order.
  -- Advanced in the same transaction as each transactional statement, so a resumed run never runs a
  -- committed statement twice.
  next_step integer not null default 0 check (next_step >= 0),
  next_statement integer not null default 0 check (next_statement >= 0),
  -- [{ step, kind, startedAt, finishedAt, statements, lockRetries }], one entry per finished step.
  step_log jsonb not null default '[]'::jsonb check (jsonb_typeof(step_log) = 'array'),
  lock_retries integer not null default 0 check (lock_retries >= 0),
  -- A code only (e.g. lock_timeout_exhausted): never SQL text, identifiers or values.
  error_ref text check (error_ref ~ '^[a-z0-9_]{1,80}$'),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists schema_migration_runs_model_idx on public.schema_migration_runs (content_model_id, started_at desc);

comment on table public.schema_migration_runs is
  'Progress and per-step timings of each schema migration stage. Written only by the migration worker (polynovea_owner).';

-- ── Expand and contract ──────────────────────────────────────────────────────────────────────────
-- kind rename:      new_column added, kept in sync with old_column both ways by the trigger, backfilled;
--                   the model's shape switches to new_column when the stage finishes; contract drops the
--                   trigger and old_column.
-- kind change_type: new_column (hidden name) of the new type, filled from old_column by the trigger and
--                   the backfill; the switch renames old_column to retired_column and new_column into
--                   old_column's place; contract drops retired_column.
create table if not exists public.schema_expand_contract_tasks (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.schema_migration_ledger (id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_model_id uuid references public.content_models (id) on delete set null,
  table_name text not null check (table_name ~ '^m_[a-z0-9_]{1,61}$'),
  kind text not null check (kind in ('rename', 'change_type')),
  old_column text not null check (old_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  new_column text not null check (new_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  retired_column text check (retired_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  trigger_name text not null check (trigger_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- rolled_back: a failed expand whose trigger, guard index and new column were removed again
  -- (rollbackExpandTask), leaving the table exactly as before; a retry starts it afresh.
  status text not null check (status in ('expanding', 'awaiting_contract', 'contracted', 'failed', 'rolled_back')),
  -- Where the expand is: add_column, trigger, guard_index, backfill, precheck, indexes, relax (rename:
  -- the old column's constraints go), switch, validate, done; phase_statement is the next statement
  -- within a phase that has several.
  phase text not null default 'add_column'
    check (phase in ('add_column', 'trigger', 'guard_index', 'backfill', 'precheck', 'indexes', 'relax', 'switch', 'validate', 'done')),
  phase_statement integer not null default 0 check (phase_statement >= 0),
  -- Last primary key the backfill finished: {"entry_id": ..., "variant": ..., "locale": ...}.
  backfill_cursor jsonb,
  backfilled_rows bigint not null default 0 check (backfilled_rows >= 0),
  -- The worker's release when the expand finished. Contract runs once a worker of another release
  -- sees it (and contract_min_at has passed), or at contract_after, whichever comes first; always well
  -- before the 30-day name reservation (schema_name_reservations) runs out.
  release_id text check (char_length(release_id) between 1 and 200),
  contract_min_at timestamptz,
  contract_after timestamptz,
  error_ref text check (error_ref ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  switched_at timestamptz,
  contracted_at timestamptz,
  unique (ledger_id, step_index)
);

create index if not exists schema_expand_contract_tasks_due_idx
  on public.schema_expand_contract_tasks (status, contract_after);
create index if not exists schema_expand_contract_tasks_model_idx
  on public.schema_expand_contract_tasks (content_model_id, status);

comment on table public.schema_expand_contract_tasks is
  'Renames and type changes in progress (expand and contract). Written only by the migration worker (polynovea_owner).';

alter table public.schema_migration_runs enable row level security;
alter table public.schema_expand_contract_tasks enable row level security;

-- ── Dual-write trigger ───────────────────────────────────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE, FOR EACH ROW, on a content table during an expand. Arguments: the source
-- column, the destination column, and 'copy' (one way, source to destination: type changes) or 'sync'
-- (both ways: renames, so writers that know either name keep both columns equal).
--
-- It only ever sets a column of NEW. The value converts through JSON (jsonb_populate_record), so
-- there is no dynamic SQL and no name is ever spliced into a statement. A value that cannot convert
-- leaves the destination NULL and never fails the user's save; the runner's switch refuses to finish
-- while any row has a source value and no destination value, so nothing is lost silently.
--
-- A backfill is an UPDATE that sets the source column to itself: this trigger then fills the
-- destination with exactly the same conversion as a live write.
create or replace function public.polynovea_schema_dual_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  src text := tg_argv[0];
  dst text := tg_argv[1];
  two_way boolean := tg_argv[2] = 'sync';
  new_row jsonb := pg_catalog.to_jsonb(new);
  old_row jsonb;
  from_col text := src;
  to_col text := dst;
begin
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op not in ('INSERT', 'UPDATE') then
    raise exception 'polynovea_schema_dual_write must be a BEFORE INSERT OR UPDATE row trigger';
  end if;
  if not (new_row ? src and new_row ? dst) then
    raise exception 'polynovea_schema_dual_write: trigger arguments do not name columns of the table';
  end if;

  if two_way then
    if tg_op = 'INSERT' then
      -- A writer that only knows the new name leaves the old one empty.
      if (new_row -> src) = 'null'::jsonb and (new_row -> dst) <> 'null'::jsonb then
        from_col := dst;
        to_col := src;
      end if;
    else
      old_row := pg_catalog.to_jsonb(old);
      if (new_row -> src) is not distinct from (old_row -> src)
         and (new_row -> dst) is distinct from (old_row -> dst) then
        from_col := dst;
        to_col := src;
      end if;
    end if;
  end if;

  begin
    new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(to_col, new_row -> from_col));
  exception when data_exception then
    new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(to_col, null));
  end;
  return new;
end;
$$;

comment on function public.polynovea_schema_dual_write() is
  'Expand/contract dual-write trigger for content tables (lib/schema/runner/expandContract.ts). Sets NEW only.';

-- ── Requests: insert-only for the app ───────────────────────────────────────────────────────────
-- The content model version the change is for: what the worker rebuilds the plan from (with the
-- table's applied shape), instead of trusting the plan stored in the row.
alter table public.schema_migration_ledger
  add column if not exists target_version_id uuid references public.content_model_versions (id) on delete set null;
-- The field renames the user asked for ([{"from": ..., "to": ...}]): a version cannot say them, so the
-- request carries them and the engine re-validates them when it rebuilds the plan.
alter table public.schema_migration_ledger
  add column if not exists renames jsonb not null default '[]'::jsonb check (jsonb_typeof(renames) = 'array');

-- Whatever an inserting session supplies, a request starts clean: its status follows from its stage
-- (expand: pending; destructive: awaiting_confirmation) and nothing about a run is set. Everything the
-- app supplies is untrusted: the request must name a model of the workspace it claims, a target version
-- of that model, and the model's own api key is written in (the worker ignores the row's table name,
-- api key and plan_json anyway).
--
-- Who is exempt: only sessions that are (members of) the ledger table's owner: migrations, the worker
-- and the engine's reference executor. Every other role, including Supabase's service_role (which a
-- deployment's service key reaches through PostgREST), gets the checks. Membership is the only thing
-- that changes this; polynovea_app belongs to no other role, so it cannot SET ROLE out of it, and no
-- setting it can change (GUCs, search_path, session variables) has any effect here.
create or replace function public.polynovea_schema_ledger_request()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  model_workspace uuid;
  model_key text;
begin
  if pg_catalog.pg_has_role(current_user, (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.schema_migration_ledger'::pg_catalog.regclass), 'MEMBER') then
    return new;
  end if;
  select m.workspace_id, m.api_key into model_workspace, model_key
    from public.content_models m where m.id = new.content_model_id;
  if model_workspace is null or model_workspace is distinct from new.workspace_id then
    raise exception using errcode = '23514', message = 'schema_request_model_mismatch';
  end if;
  if new.target_version_id is not null and not exists (
    select 1 from public.content_model_versions v where v.id = new.target_version_id and v.content_model_id = new.content_model_id
  ) then
    raise exception using errcode = '23514', message = 'schema_request_version_mismatch';
  end if;
  new.model_api_key := model_key;
  new.status := case new.stage when 'destructive' then 'awaiting_confirmation' else 'pending' end;
  new.attempts := 0;
  new.error_ref := null;
  new.started_at := null;
  new.finished_at := null;
  new.confirmed_by := null;
  new.confirmed_at := null;
  new.created_at := pg_catalog.now();
  return new;
end;
$$;

-- A request can be cancelled (polynovea_cancel_schema_stage) before it runs.
alter table public.schema_migration_ledger drop constraint if exists schema_migration_ledger_status_check;
alter table public.schema_migration_ledger add constraint schema_migration_ledger_status_check
  check (status in ('pending', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'superseded', 'cancelled'));
alter table public.schema_migration_ledger
  add column if not exists cancelled_by uuid references public.admin_users (id) on delete set null,
  add column if not exists cancelled_at timestamptz;

-- A newer request for a model replaces every older request of that model that has not started:
-- pending and awaiting_confirmation rows from earlier transactions become superseded, so a deletion
-- planned against an old version can never be confirmed later. (The rows of one request, written in
-- one transaction, share created_at and leave each other alone.) Owner-side: the app cannot UPDATE.
create or replace function public.polynovea_schema_ledger_supersede()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.schema_migration_ledger
     set status = 'superseded', finished_at = pg_catalog.now()
   where content_model_id = new.content_model_id and id <> new.id
     and status in ('pending', 'awaiting_confirmation') and created_at < new.created_at;
  return null;
end;
$$;

drop trigger if exists schema_migration_ledger_supersede on public.schema_migration_ledger;
create trigger schema_migration_ledger_supersede after insert on public.schema_migration_ledger
  for each row execute function public.polynovea_schema_ledger_supersede();

drop trigger if exists schema_migration_ledger_request on public.schema_migration_ledger;
create trigger schema_migration_ledger_request before insert on public.schema_migration_ledger
  for each row execute function public.polynovea_schema_ledger_request();

-- ── Confirmations ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.schema_migration_confirmations (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null unique references public.schema_migration_ledger (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  confirmed_by uuid references public.admin_users (id) on delete set null,
  -- What was typed (it matched the model's api key when the row was written).
  typed_api_key text not null check (typed_api_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.schema_migration_confirmations enable row level security;

comment on table public.schema_migration_confirmations is
  'Typed confirmations of destructive schema stages. Written only by polynovea_confirm_schema_stage(); the worker runs a destructive stage only with one.';

-- The app confirms a deletion only through this function: it checks the stage is a destructive one
-- waiting for confirmation and that the typed text is the model's api key, records the confirmation
-- and queues the stage. Audit note: p_confirmed_by is supplied by the caller (the app passes the
-- signed-in admin). The function only checks it names an active admin who is an active member of the
-- workspace; the confirmation row records whoever the app said, not a database-proven identity. A stolen app login can still call it (confirming is an app action by design);
-- what keeps that harmless is that the worker rebuilds every plan from trusted state.
create or replace function public.polynovea_confirm_schema_stage(p_ledger_id uuid, p_confirmed_by uuid, p_typed_api_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request record;
  model_key text;
begin
  -- Errors are plain codes; the typed text is never logged or echoed.
  select l.id, l.stage, l.status, l.workspace_id, l.content_model_id, l.model_api_key, l.target_version_id
    into request
    from public.schema_migration_ledger l
   where l.id = p_ledger_id
     for update;
  if not found or request.stage <> 'destructive' then
    raise exception using errcode = 'P0002', message = 'schema_stage_not_found';
  end if;
  if request.status <> 'awaiting_confirmation' then
    raise exception using errcode = '55000', message = 'schema_stage_not_awaiting_confirmation';
  end if;
  -- The key that confirms is the api key of the model this request belongs to, in its workspace (and
  -- the request must name that same key).
  select m.api_key into model_key
    from public.content_models m
   where m.id = request.content_model_id and m.workspace_id = request.workspace_id;
  if model_key is null or model_key is distinct from request.model_api_key then
    raise exception using errcode = 'P0002', message = 'schema_stage_not_found';
  end if;
  if p_typed_api_key is distinct from model_key then
    raise exception using errcode = '22023', message = 'schema_confirmation_mismatch';
  end if;
  -- Only a request for the model's current version can be confirmed: a deletion planned against an
  -- older version may drop a field the current version uses again.
  if request.target_version_id is not null and request.target_version_id is distinct from (
    select v.id from public.content_model_versions v
      join public.content_models m on m.id = v.content_model_id
     where m.id = request.content_model_id and v.version_number = m.current_schema_version
  ) then
    raise exception using errcode = '55000', message = 'schema_stage_superseded';
  end if;
  -- The audit trail names a real, active admin user who is an active member of the request's
  -- workspace, never free text.
  if not exists (
    select 1 from public.admin_users a
      join public.workspace_members wm on wm.admin_user_id = a.id
     where a.id = p_confirmed_by and coalesce(a.is_active, true)
       and wm.workspace_id = request.workspace_id and wm.status = 'active'
  ) then
    raise exception using errcode = '22023', message = 'schema_confirmation_unknown_user';
  end if;
  insert into public.schema_migration_confirmations (ledger_id, workspace_id, confirmed_by, typed_api_key)
  values (p_ledger_id, request.workspace_id, p_confirmed_by, p_typed_api_key);
  update public.schema_migration_ledger
     set status = 'pending', confirmed_by = p_confirmed_by, confirmed_at = pg_catalog.clock_timestamp()
   where id = p_ledger_id;
end;
$$;

-- "Retry" in the UI: a failed stage goes back in the queue (the worker resumes it from its run row).
create or replace function public.polynovea_retry_schema_stage(p_ledger_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_status text;
begin
  select status into current_status from public.schema_migration_ledger where id = p_ledger_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'schema_stage_not_found';
  end if;
  if current_status <> 'failed' then
    raise exception using errcode = '55000', message = 'schema_stage_not_failed';
  end if;
  update public.schema_migration_ledger set status = 'pending', error_ref = null where id = p_ledger_id;
end;
$$;

-- "Cancel" in the UI: a request that has not started (pending or awaiting confirmation) is dropped,
-- by an active admin who is an active member of its workspace (the same check as confirming).
create or replace function public.polynovea_cancel_schema_stage(p_ledger_id uuid, p_cancelled_by uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request record;
begin
  select l.id, l.status, l.workspace_id into request from public.schema_migration_ledger l where l.id = p_ledger_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'schema_stage_not_found';
  end if;
  if request.status not in ('pending', 'awaiting_confirmation') then
    raise exception using errcode = '55000', message = 'schema_stage_not_cancellable';
  end if;
  if not exists (
    select 1 from public.admin_users a
      join public.workspace_members wm on wm.admin_user_id = a.id
     where a.id = p_cancelled_by and coalesce(a.is_active, true)
       and wm.workspace_id = request.workspace_id and wm.status = 'active'
  ) then
    raise exception using errcode = '22023', message = 'schema_cancel_unknown_user';
  end if;
  update public.schema_migration_ledger
     set status = 'cancelled', cancelled_by = p_cancelled_by, cancelled_at = pg_catalog.clock_timestamp(), finished_at = pg_catalog.clock_timestamp()
   where id = p_ledger_id;
end;
$$;

-- The three functions: the app role only (never PUBLIC, anon, authenticated or service_role).
revoke all on function public.polynovea_confirm_schema_stage(uuid, uuid, text) from public;
revoke all on function public.polynovea_retry_schema_stage(uuid) from public;
grant execute on function public.polynovea_confirm_schema_stage(uuid, uuid, text) to polynovea_app;
grant execute on function public.polynovea_retry_schema_stage(uuid) to polynovea_app;
revoke all on function public.polynovea_cancel_schema_stage(uuid, uuid) from public;
grant execute on function public.polynovea_cancel_schema_stage(uuid, uuid) to polynovea_app;

-- ── App access ───────────────────────────────────────────────────────────────────────────────────
-- The helper from 0072 (the latest), unchanged except for one explicit list of tables the app role may
-- only read. Default privileges give the app full rights on every new table, so for each listed table
-- the helper grants SELECT and then revokes INSERT, UPDATE, DELETE and TRUNCATE; running it again (as
-- every later migration does) never restores write access.
--
--   polynovea_migration_ledger    the migration files applied (migrations write it)
--   schema_migration_runs         the runner's progress: it resumes from it, so only it writes it
--   schema_expand_contract_tasks  the runner acts on the column and trigger names stored in it
--   content_model_tables          each model's table and applied shape: the schema gate compares
--                                 against it, so only the engine's apply bookkeeping writes it
--   schema_name_reservations      deleted and renamed names, written only by the apply bookkeeping
--   schema_migration_confirmations written only by polynovea_confirm_schema_stage()
--
-- schema_migration_ledger: SELECT, and INSERT of the request columns only (ledger_request_columns);
-- no UPDATE or DELETE. content_model_versions: SELECT and INSERT only: the worker rebuilds every plan
-- from these rows, so a stolen app login must not be able to rewrite a model's history (saving a model
-- only ever adds a version; deleting a model cascades with the table owner's rights). content_field_permissions stays app-writable (the admin UI edits field
-- permissions). installation keeps its 0072 rule (SELECT and INSERT only).
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
    'content_model_tables', 'schema_name_reservations', 'schema_migration_confirmations'];
  ledger_request_columns text := 'workspace_id, content_model_id, model_api_key, table_name, stage, plan_hash, '
    || 'base_shape_hash, target_schema_hash, plan_json, requested_by, target_version_id, renames';
  app_only_functions text[] := array['polynovea_confirm_schema_stage', 'polynovea_retry_schema_stage', 'polynovea_cancel_schema_stage'];
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

select public.polynovea_apply_app_access();

-- 0075 may be applied before this file on some installs: never move the recorded version backwards.
update public.cms_runtime_state
set schema_migration = greatest(schema_migration, '0074'), updated_at = now() where singleton = true;
