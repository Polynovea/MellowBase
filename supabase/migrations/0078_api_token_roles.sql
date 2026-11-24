-- 0078: API token roles and per-role API limits (self-hosted upgrade, phase 4, generated API).
--
-- developer_api_tokens.role_id: the workspace role whose field permissions (content_field_permissions)
-- and model policies apply to a token. Null keeps the behaviour from before phase 4: the token acts
-- with its creator's member roles. The role must belong to the token's workspace (composite foreign
-- key), and a role in use by a token cannot be deleted: dropping it would silently widen the token
-- back to its creator's roles. NO ACTION (checked at the end of the statement), not RESTRICT: deleting
-- a whole workspace cascades to its tokens and roles in one statement and must not fail on the order.
--
-- roles.api_limits: per-role overrides of the items API limits (page size, filter depth, joins,
-- statement timeout...). The app clamps them to the hard caps: an override can only lower a limit.
--
-- No new tables and no grant changes: the app role's table-level privileges cover the new columns.
-- Migration 0077 (phase 5, system_operations) is independent of this one.

alter table public.roles add column if not exists api_limits jsonb;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'roles_api_limits_object' and conrelid = 'public.roles'::regclass) then
    alter table public.roles add constraint roles_api_limits_object check (api_limits is null or jsonb_typeof(api_limits) = 'object');
  end if;
end;
$$;

comment on column public.roles.api_limits is
  'Per-role items API limit overrides (pageSize, filterDepth, joins, statementTimeoutMs...). Clamped by the app; can only lower the hard caps.';

-- (workspace_id, id) is unique already (id is the key); the composite key lets tokens reference a role
-- of their own workspace only.
create unique index if not exists roles_workspace_id_id_key on public.roles (workspace_id, id);

alter table public.developer_api_tokens add column if not exists role_id uuid;

-- Dropped and added again, never "add if missing": an earlier draft of this migration created the
-- constraint ON DELETE RESTRICT, and a database that ran that draft must end up with NO ACTION too.
alter table public.developer_api_tokens drop constraint if exists developer_api_tokens_role_fk;
alter table public.developer_api_tokens
  add constraint developer_api_tokens_role_fk foreign key (workspace_id, role_id)
  references public.roles (workspace_id, id) on delete no action;

create index if not exists developer_api_tokens_role_idx on public.developer_api_tokens (role_id) where role_id is not null;

comment on column public.developer_api_tokens.role_id is
  'Workspace role whose field permissions apply to this token (items API). Null: the creator''s member roles.';

update public.cms_runtime_state
set schema_migration = greatest(schema_migration, '0078'), updated_at = now() where singleton = true;
