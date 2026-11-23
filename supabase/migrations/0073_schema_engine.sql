-- 0073: schema engine metadata (self-hosted upgrade, phase 3: real tables).
--
-- Each content model gets a real table in its own schema, `content`, apart from the system tables in
-- `public`, so a name a user picks can never collide with ours. The schema engine
-- (lib/schema/engine/) plans every change to those tables; this migration adds what it needs:
--
--   content_model_tables      which physical table belongs to which model, and the shape it has now
--   content_field_permissions per-field read/write rows per role (the API's permission function reads
--                             them; deleting a field deletes its rows in the same transaction)
--   schema_name_reservations  names of deleted fields and models, blocked from reuse for 30 days
--   schema_migration_ledger   every plan stage: who asked, the hashes, timings and the outcome
--
-- Tables in `content` are created at run time by the migration worker as polynovea_owner. The app role
-- gets USAGE on the schema and table privileges, never CREATE: a stolen app login cannot add, alter or
-- drop a content table. The engine grants privileges, enables row-level security and adds the same
-- permissive polynovea_app policy every table has, in the transaction that creates each table.

create schema if not exists content;
revoke all on schema content from public;
grant usage on schema content to polynovea_app;
alter default privileges in schema content grant select, insert, update, delete on tables to polynovea_app;

comment on schema content is
  'One table per content model, created and changed only by the schema engine (lib/schema/engine).';

-- The physical table of each model. table_name is chosen once (from the api key, with a fixed m_
-- prefix) and never changes, so it is unique across the whole install even though api keys are only
-- unique per workspace. applied_shape is the table as it physically is now (columns, types,
-- constraints); plans are built from it and refused if its hash changed since. The migration worker
-- rebuilds every plan from this row and the target version, so the app role must only read this table
-- (0074 makes it read-only for polynovea_app).
create table if not exists public.content_model_tables (
  content_model_id uuid primary key references public.content_models (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  table_name text not null unique check (table_name ~ '^m_[a-z0-9_]{1,61}$'),
  applied_shape jsonb not null,
  applied_shape_hash text not null check (applied_shape_hash ~ '^[0-9a-f]{64}$'),
  -- The schema version the table was last planned to (its fields are the model's current fields; a
  -- column whose field is not in it is waiting for its deletion to be confirmed).
  applied_version_id uuid references public.content_model_versions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_model_tables_workspace_idx on public.content_model_tables (workspace_id);

comment on table public.content_model_tables is
  'The content.<table_name> table of each model and its current physical shape. Written only by the schema engine.';

-- Field-level permissions. One row per (model, field, role). A field nobody has a row for falls back
-- to the model-level permission. Rows are removed in the same transaction that drops the field, and
-- the field name is reserved, so a new field with the same name never inherits them
-- (Directus GHSA-9x5g-62gj-wqf2).
create table if not exists public.content_field_permissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_model_id uuid not null references public.content_models (id) on delete cascade,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]*$'),
  role_id uuid not null references public.roles (id) on delete cascade,
  can_read boolean not null default true,
  can_write boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (content_model_id, field_key, role_id)
);

create index if not exists content_field_permissions_role_idx on public.content_field_permissions (role_id);

-- Deleted field and model names. A name here cannot be reused in that scope until reserved_until.
-- Field names are reserved per model; model api keys per workspace.
create table if not exists public.schema_name_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_model_id uuid references public.content_models (id) on delete cascade,
  kind text not null check (kind in ('field', 'model')),
  name text not null check (name ~ '^[a-z][a-z0-9_]*$'),
  reason text not null check (reason in ('deleted', 'renamed')),
  reserved_until timestamptz not null,
  created_at timestamptz not null default now(),
  check ((kind = 'field') = (content_model_id is not null))
);

create index if not exists schema_name_reservations_lookup_idx
  on public.schema_name_reservations (workspace_id, kind, name, reserved_until);

-- One row per plan stage. The additive ("expand") stage runs when the plan is applied; a destructive
-- stage waits as awaiting_confirmation until someone types the model name, and runs as its own later
-- step. The request that asks for a change writes the row; the migration worker runs it under the
-- owner role and records the outcome.
create table if not exists public.schema_migration_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_model_id uuid references public.content_models (id) on delete set null,
  model_api_key text not null,
  table_name text not null,
  stage text not null check (stage in ('expand', 'destructive')),
  status text not null check (status in ('pending', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'superseded')),
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  base_shape_hash text check (base_shape_hash ~ '^[0-9a-f]{64}$'),
  target_schema_hash text check (target_schema_hash ~ '^[0-9a-f]{64}$'),
  plan_json jsonb not null,
  requested_by uuid references public.admin_users (id) on delete set null,
  confirmed_by uuid references public.admin_users (id) on delete set null,
  confirmed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  error_ref text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists schema_migration_ledger_model_idx
  on public.schema_migration_ledger (content_model_id, created_at desc);
-- At most one stage runs per model at a time.
create unique index if not exists schema_migration_ledger_one_running_idx
  on public.schema_migration_ledger (content_model_id) where status = 'running';

alter table public.content_model_tables enable row level security;
alter table public.content_field_permissions enable row level security;
alter table public.schema_name_reservations enable row level security;
alter table public.schema_migration_ledger enable row level security;

-- Grants and the polynovea_app policy for the new public tables (0067/0068/0072 helper).
select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = '0073', updated_at = now() where singleton = true;
