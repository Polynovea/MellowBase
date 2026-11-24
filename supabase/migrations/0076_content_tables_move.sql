-- 0076: moving existing content into the model tables (self-hosted upgrade, phase 3, wave 3).
--
-- Every model's current content (its entries' current draft and published versions) is copied from
-- the JSONB snapshots in content_entry_versions into the model's table, content.<table_name>, which
-- the migration worker created (0073/0074). Version history stays as JSONB snapshots, written exactly
-- as before; only current content goes into the tables.
--
--   polynovea_content_sync_entries(ids)  writes the table rows of the given entries from their own
--                                        current pointers and versions. A trigger on content_entries
--                                        calls it in the same transaction as every save and publish;
--                                        the backfill job (npm run content:move) calls it in batches
--                                        of 1,000 entries. One code path for both.
--   polynovea_content_verify_model(...)  compares the table with the snapshots: row counts per variant,
--                                        and per field and variant a count of values and a checksum on
--                                        each side, computed independently (snapshot: the JSON value
--                                        cast to the column type; table: the column). Each run is kept
--                                        in content_model_move_runs.
--   polynovea_content_set_read_source()  switches a model's reads to its table (only after a matching
--                                        run on the table's current shape) or back to the snapshots
--                                        (always). Rolling a model back is that switch: snapshots and
--                                        the table both keep being written, so nothing moves.
--
-- Security: the three functions run as the owner with an empty search_path. Table and column names
-- come only from content_model_tables (the table name and applied_shape, which the app role can only
-- read) and go through format('%I'); callers pass ids, never names. Errors carry a code as their
-- message, never data. EXECUTE is for polynovea_app only. The two new tables are read-only for the app
-- (the access helper's read_only list), so the read switch and the run records change only through
-- these functions.
--
-- pg_trgm: installed since 0017; the "if not exists" keeps this file self-contained. On Amazon RDS it
-- is a supported, trusted extension (PostgreSQL 13+: the database owner may create it). On Azure
-- Database for PostgreSQL flexible server it must first be allow-listed in the server parameter
-- azure.extensions (add PG_TRGM), or CREATE EXTENSION is refused. The engine's search indexes name the
-- operator class unqualified, so pg_trgm must be in a schema on the migration worker's search_path
-- (public on a plain install; Supabase's default search_path includes extensions).
create extension if not exists pg_trgm;

-- Which source each model's current-content reads use, and whether the table has fallen behind.
-- No row = reads use the snapshots.
create table if not exists public.content_model_storage (
  content_model_id uuid primary key references public.content_models (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  read_source text not null default 'snapshot' check (read_source in ('snapshot', 'table')),
  -- When (and with which code) a save last could not be written to the table. The save itself
  -- succeeded, because reads still used the snapshots. For information: decisions use sync_failures.
  out_of_sync_at timestamptz,
  out_of_sync_code text check (out_of_sync_code is null or out_of_sync_code ~ '^[a-z0-9_]{1,64}$'),
  -- How many saves have failed to reach the table, bumped in the failing save's own transaction. A
  -- verification run records the count it saw before reading anything; switching to the table and
  -- reading from it need the count unchanged since. A failed save that commits while a run is reading
  -- (the run sees the old content, which still matches) therefore always invalidates that run, however
  -- the two interleave. Normal saves never touch this row, so they do not contend on it.
  sync_failures bigint not null default 0,
  last_run_id uuid,
  switched_at timestamptz,
  switched_by uuid references public.admin_users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists content_model_storage_workspace_idx on public.content_model_storage (workspace_id);

comment on table public.content_model_storage is
  'Per model: whether current-content reads use the model table or the JSONB snapshots. Changed only by polynovea_content_set_read_source().';

-- Every verification run: the counts and checksums of both sides, and whether they matched.
create table if not exists public.content_model_move_runs (
  id uuid primary key default gen_random_uuid(),
  content_model_id uuid not null references public.content_models (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  table_name text not null,
  -- The applied_shape_hash the run compared against: switching requires it to still be current.
  shape_hash text not null check (shape_hash ~ '^[0-9a-f]{64}$'),
  -- content_model_storage.sync_failures as the run saw it before reading anything.
  sync_failures bigint not null default 0,
  matched boolean not null,
  -- {"snapshot": {"draft": n, "published": n}, "table": {"draft": n, "published": n}, "foreign_rows": n, "rows": {...checksums}}
  counts jsonb not null,
  -- {"<column>": {"field": "<key>", "draft": {"snapshot": [n, sum], "table": [n, sum]}, "published": {...}}}
  fields jsonb not null,
  -- [{"kind": "...", "column": "...", "variant": "..."}]: empty when matched
  mismatches jsonb not null default '[]'::jsonb,
  -- What the backfill job reported for the pass before this run: {"batches", "entries", "failed"}.
  backfill jsonb not null default '{}'::jsonb,
  requested_by uuid references public.admin_users (id) on delete set null,
  started_at timestamptz not null,
  finished_at timestamptz not null default now()
);

create index if not exists content_model_move_runs_model_idx on public.content_model_move_runs (content_model_id, started_at desc, id desc);
create index if not exists content_model_move_runs_workspace_idx on public.content_model_move_runs (workspace_id);

comment on table public.content_model_move_runs is
  'Each comparison of a model table with its JSONB snapshots (counts and per-field checksums). Written only by polynovea_content_verify_model().';

alter table public.content_model_storage enable row level security;
alter table public.content_model_move_runs enable row level security;

-- ── Sync ─────────────────────────────────────────────────────────────────────────────────────────
-- Writes the model-table rows of up to 1,000 entries from their own current pointers and versions.
-- Each entry's rows go to the table of the entry's own model (looked up through content_model_tables
-- with the entry's workspace), whatever mix of models or workspaces the ids come from. An entry's rows
-- are deleted and written again, so a cleared pointer (a draft published) or a changed locale leaves no
-- stale row. Entries whose model has no table are skipped; ids that are not entries are counted
-- (a deleted entry's rows went with it: the table's foreign key cascades).
--
-- A row that cannot be written (a value that does not convert to its column type, or a published row
-- missing a required value): if the model reads from its table, the save fails (we never save what the
-- reads cannot return); otherwise the save goes through, the entry is counted as failed and the model
-- is marked out of sync until a later matching run.
-- A renamed field keeps its old key in snapshots saved before the rename (history is never rewritten).
-- For each column of `p_shape`, the names its field had before, newest first, each with the schema
-- version from which it no longer applied: [{"name": "<old key>", "below": <version_number>}]. A
-- snapshot saved under schema version s uses the alias with the smallest "below" greater than s, or the
-- field's current key. The renames come from the model's finished expand stages (the ledger's renames,
-- with the version each built toward). Read-only.
create or replace function public.polynovea_content_field_aliases(p_content_model_id uuid, p_shape jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c record;
  r record;
  v_current text;
  v_names jsonb;
  v_result jsonb := '{}'::jsonb;
begin
  for c in select col.key as name, col.value ->> 'field' as field from jsonb_each(coalesce(p_shape -> 'columns', '{}'::jsonb)) col loop
    v_current := c.field;
    v_names := '[]'::jsonb;
    for r in
      select rn ->> 'from' as old_key, rn ->> 'to' as new_key, mv.version_number
        from public.schema_migration_ledger l
        join public.content_model_versions mv on mv.id = l.target_version_id and mv.content_model_id = l.content_model_id
        cross join lateral jsonb_array_elements(case when jsonb_typeof(l.renames) = 'array' then l.renames else '[]'::jsonb end) rn
       where l.content_model_id = p_content_model_id and l.stage = 'expand' and l.status = 'succeeded'
       order by mv.version_number desc, l.created_at desc
    loop
      if r.new_key = v_current and r.old_key ~ '^[a-z][a-z0-9_]*$' then
        v_names := v_names || jsonb_build_array(jsonb_build_object('name', r.old_key, 'below', r.version_number));
        v_current := r.old_key;
      end if;
    end loop;
    if jsonb_array_length(v_names) > 0 then
      v_result := v_result || jsonb_build_object(c.name, v_names);
    end if;
  end loop;
  return v_result;
end;
$$;

-- The aliases the sync uses, stored with each table when one of its model's schema stages succeeds,
-- so a save reads one value instead of querying the ledger for every column. The verification does
-- not use them: it derives the aliases from the ledger again on its own (a separate recursive query),
-- so a wrong stored alias shows up as a checksum mismatch.
alter table public.content_model_tables add column if not exists field_aliases jsonb not null default '{}'::jsonb;

comment on column public.content_model_tables.field_aliases is
  'Per column: the names its field had before, with the schema version each stopped applying at ({"<column>": [{"name", "below"}]}). Written when a schema stage succeeds (trigger on schema_migration_ledger); read by polynovea_content_sync_entries().';

-- Runs in the worker's final stage transaction (the owner), after the engine's bookkeeping wrote the
-- table's new shape: that stage's renames are then part of the ledger's succeeded history.
create or replace function public.polynovea_content_store_field_aliases()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.content_model_tables mt
     set field_aliases = public.polynovea_content_field_aliases(mt.content_model_id, mt.applied_shape)
   where mt.content_model_id = new.content_model_id;
  return null;
end;
$$;

drop trigger if exists schema_migration_ledger_field_aliases on public.schema_migration_ledger;
create trigger schema_migration_ledger_field_aliases
  after update of status on public.schema_migration_ledger
  for each row
  when (new.status = 'succeeded' and old.status is distinct from 'succeeded' and new.content_model_id is not null)
  execute function public.polynovea_content_store_field_aliases();

update public.content_model_tables mt
   set field_aliases = public.polynovea_content_field_aliases(mt.content_model_id, mt.applied_shape);

create or replace function public.polynovea_content_sync_entries(p_entry_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  v_ids uuid[];
  v_entry uuid;
  v_columns jsonb;
  v_aliases jsonb;
  v_state text;
  v_delete text;
  v_insert text;
  v_requested integer;
  v_found integer;
  v_synced integer := 0;
  v_skipped integer := 0;
  v_failed uuid[] := '{}';
  v_read_source text;
begin
  if p_entry_ids is null then
    return jsonb_build_object('requested', 0, 'synced', 0, 'skipped_no_table', 0, 'missing', 0, 'failed', '[]'::jsonb);
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(p_entry_ids) as ids(id) where id is not null;
  v_requested := coalesce(cardinality(v_ids), 0);
  if v_requested = 0 then
    return jsonb_build_object('requested', 0, 'synced', 0, 'skipped_no_table', 0, 'missing', 0, 'failed', '[]'::jsonb);
  end if;
  if v_requested > 1000 then
    raise exception using errcode = '22023', message = 'content_sync_batch_too_large';
  end if;

  -- Lock in id order. Saves lock their entry FOR UPDATE, so a backfill batch and a save never
  -- interleave: whichever runs second writes from the pointers the first one left.
  perform 1 from public.content_entries e where e.id = any (v_ids) order by e.id for share of e;
  select count(*) into v_found from public.content_entries e where e.id = any (v_ids);

  for m in
    select e.content_model_id, t.table_name, t.applied_shape, t.field_aliases,
           coalesce(s.read_source = 'table', false) as reads_table,
           e.workspace_id,
           array_agg(e.id order by e.id) as ids
      from public.content_entries e
      left join public.content_model_tables t on t.content_model_id = e.content_model_id and t.workspace_id = e.workspace_id
      left join public.content_model_storage s on s.content_model_id = e.content_model_id
     where e.id = any (v_ids)
     group by e.content_model_id, e.workspace_id, t.table_name, t.applied_shape, t.field_aliases, s.read_source
     order by e.content_model_id
  loop
    if m.table_name is null then
      v_skipped := v_skipped + cardinality(m.ids);
      continue;
    end if;
    if m.table_name !~ '^m_[a-z0-9_]{1,61}$' then
      raise exception using errcode = '22023', message = 'content_table_name_invalid';
    end if;
    -- column name -> field key, from the table's recorded shape only.
    select coalesce(jsonb_object_agg(c.key, c.value ->> 'field'), '{}'::jsonb) into v_columns
      from jsonb_each(coalesce(m.applied_shape -> 'columns', '{}'::jsonb)) c;
    if exists (select 1 from jsonb_each_text(v_columns) c where c.key !~ '^[a-z][a-z0-9_]{0,62}$' or c.value is null) then
      raise exception using errcode = '22023', message = 'content_table_shape_invalid';
    end if;
    -- Old field names for snapshots saved before a rename: stored with the table (no ledger query).
    v_aliases := coalesce(m.field_aliases, '{}'::jsonb);

    v_delete := format('delete from content.%I where _entry_id = any ($1)', m.table_name);
    -- jsonb_populate_record casts each JSON value to its column type the way PostgreSQL casts input;
    -- the version must belong to the entry it is the pointer of.
    v_insert := format($sql$
      insert into content.%1$I
      select r.*
        from public.content_entries e
        cross join lateral (values ('draft'::text, e.current_draft_version_id), ('published'::text, e.published_version_id)) p (variant, version_id)
        join public.content_entry_versions v on v.id = p.version_id and v.entry_id = e.id
        cross join lateral pg_catalog.jsonb_populate_record(
          null::content.%1$I,
          pg_catalog.jsonb_build_object('_entry_id', e.id, '_variant', p.variant, '_locale', v.locale)
          || coalesce((select pg_catalog.jsonb_object_agg(c.key, v.data_jsonb -> k.name)
                         from pg_catalog.jsonb_each_text($2) c
                         cross join lateral (select coalesce(
                           (select a ->> 'name' from pg_catalog.jsonb_array_elements(coalesce($3 -> c.key, '[]'::jsonb)) a
                             where v.model_schema_version < (a ->> 'below')::integer order by (a ->> 'below')::integer limit 1),
                           c.value) as name) k
                        where jsonb_typeof(v.data_jsonb) = 'object' and v.data_jsonb ? k.name), '{}'::jsonb)
        ) r
       where e.id = any ($1)
    $sql$, m.table_name);

    begin
      execute v_delete using m.ids;
      execute v_insert using m.ids, v_columns, v_aliases;
      v_synced := v_synced + cardinality(m.ids);
    exception when others then
      -- Find the entries that cannot be written, one at a time.
      foreach v_entry in array m.ids loop
        begin
          execute v_delete using array[v_entry];
          execute v_insert using array[v_entry], v_columns, v_aliases;
          v_synced := v_synced + 1;
        exception when others then
          get stacked diagnostics v_state = returned_sqlstate;
          if m.reads_table then
            raise exception using errcode = v_state, message = 'content_table_write_failed';
          end if;
          v_failed := v_failed || v_entry;
          insert into public.content_model_storage as s (content_model_id, workspace_id, out_of_sync_at, out_of_sync_code, sync_failures)
          values (m.content_model_id, m.workspace_id, clock_timestamp(), 'sqlstate_' || lower(v_state), 1)
          on conflict (content_model_id) do update
            set out_of_sync_at = excluded.out_of_sync_at, out_of_sync_code = excluded.out_of_sync_code,
                sync_failures = s.sync_failures + 1, updated_at = now()
          returning s.read_source into v_read_source;
          -- A switch to the table may have committed since the model was looked up; this row's lock
          -- settles it: a model that now reads from its table never takes a save its table lacks.
          if v_read_source = 'table' then
            raise exception using errcode = v_state, message = 'content_table_write_failed';
          end if;
        end;
      end loop;
    end;
  end loop;

  return jsonb_build_object(
    'requested', v_requested,
    'synced', v_synced,
    'skipped_no_table', v_skipped,
    'missing', v_requested - v_found,
    'failed', to_jsonb(v_failed)
  );
end;
$$;

-- Statement-level triggers with transition tables: one sync call per statement, for the rows whose
-- pointers (or model) changed, however many rows the statement touched. A save is one call for one
-- entry; a bulk insert is one call per 1,000 entries.
create or replace function public.polynovea_content_entries_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_offset integer := 0;
  moved record;
begin
  if tg_op = 'INSERT' then
    select array_agg(n.id order by n.id) into v_ids from new_rows n
     where n.current_draft_version_id is not null or n.published_version_id is not null;
  else
    -- An entry moved to another model leaves its old model's table.
    for moved in
      select t.table_name, array_agg(o.id) as ids
        from old_rows o
        join new_rows n on n.id = o.id
        join public.content_model_tables t on t.content_model_id = o.content_model_id and t.workspace_id = o.workspace_id
       where n.content_model_id is distinct from o.content_model_id or n.workspace_id is distinct from o.workspace_id
       group by t.table_name
    loop
      if moved.table_name ~ '^m_[a-z0-9_]{1,61}$' then
        execute format('delete from content.%I where _entry_id = any ($1)', moved.table_name) using moved.ids;
      end if;
    end loop;
    select array_agg(n.id order by n.id) into v_ids
      from new_rows n join old_rows o on o.id = n.id
     where n.current_draft_version_id is distinct from o.current_draft_version_id
        or n.published_version_id is distinct from o.published_version_id
        or n.content_model_id is distinct from o.content_model_id
        or n.workspace_id is distinct from o.workspace_id;
  end if;
  while v_ids is not null and v_offset < cardinality(v_ids) loop
    perform public.polynovea_content_sync_entries(v_ids[v_offset + 1 : v_offset + 1000]);
    v_offset := v_offset + 1000;
  end loop;
  return null;
end;
$$;

drop trigger if exists content_entries_sync_insert on public.content_entries;
create trigger content_entries_sync_insert
  after insert on public.content_entries
  referencing new table as new_rows
  for each statement execute function public.polynovea_content_entries_sync();

drop trigger if exists content_entries_sync_update on public.content_entries;
create trigger content_entries_sync_update
  after update on public.content_entries
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.polynovea_content_entries_sync();

-- ── Verify ───────────────────────────────────────────────────────────────────────────────────────
-- Compares a model's table with its snapshots and records the run. The two sides are computed
-- independently: the snapshot side casts each JSON value with ->> and ::type (jsonb columns: the value
-- itself), the table side reads the column; the sync writes through jsonb_populate_record. Each value
-- is hashed as md5(entry | variant | to_jsonb(value)), and the first 60 bits are summed, so the
-- checksum does not depend on row order and streams in one pass over each side.
create or replace function public.polynovea_content_verify_model(
  p_workspace_id uuid,
  p_content_model_id uuid,
  p_requested_by uuid default null,
  p_batches integer default null,
  p_entries integer default null,
  p_failed integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  c record;
  v_started timestamptz := clock_timestamp();
  v_snapshot_counts jsonb;
  v_table_counts jsonb;
  v_snapshot_fields jsonb := '{}'::jsonb;
  v_table_fields jsonb := '{}'::jsonb;
  v_snapshot_sql text := '';
  v_table_sql text := '';
  v_snapshot_expr text;
  v_hash text;
  v_fields jsonb := '{}'::jsonb;
  v_mismatches jsonb := '[]'::jsonb;
  v_variant text;
  v_side jsonb;
  v_run_id uuid;
  v_matched boolean;
  v_backfill jsonb;
  v_pg_types constant text[] := array['text', 'jsonb', 'numeric', 'bigint', 'boolean', 'date', 'timestamptz', 'uuid'];
  v_aliases jsonb;
  v_key text;
  v_sync_failures bigint;
begin
  -- Before reading anything: the failed-sync count this run is valid for (content_model_storage).
  select coalesce((select st.sync_failures from public.content_model_storage st where st.content_model_id = p_content_model_id), 0)
    into v_sync_failures;

  select mt.table_name, mt.applied_shape, mt.applied_shape_hash, mt.workspace_id into t
    from public.content_model_tables mt
    join public.content_models cm on cm.id = mt.content_model_id and cm.workspace_id = mt.workspace_id
   where mt.content_model_id = p_content_model_id and mt.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'content_model_has_no_table';
  end if;
  if t.table_name !~ '^m_[a-z0-9_]{1,61}$' then
    raise exception using errcode = '22023', message = 'content_table_name_invalid';
  end if;

  -- Rows: counts per variant, a checksum of (entry, variant, locale), rows of other models' entries.
  execute $sql$
    select jsonb_build_object(
      'draft', count(*) filter (where p.variant = 'draft'),
      'published', count(*) filter (where p.variant = 'published'),
      'rows', coalesce(sum(('x' || substr(md5(e.id::text || '|' || p.variant || '|' || coalesce(v.locale, '~')), 1, 15))::bit(60)::bigint), 0)::text)
      from public.content_entries e
      cross join lateral (values ('draft'::text, e.current_draft_version_id), ('published'::text, e.published_version_id)) p (variant, version_id)
      left join public.content_entry_versions v on v.id = p.version_id and v.entry_id = e.id
     where e.content_model_id = $1 and e.workspace_id = $2 and p.version_id is not null
  $sql$ into v_snapshot_counts using p_content_model_id, p_workspace_id;

  execute format($sql$
    select jsonb_build_object(
      'draft', count(*) filter (where r._variant = 'draft'),
      'published', count(*) filter (where r._variant = 'published'),
      'rows', coalesce(sum(('x' || substr(md5(r._entry_id::text || '|' || r._variant || '|' || coalesce(r._locale, '~')), 1, 15))::bit(60)::bigint), 0)::text,
      'foreign_rows', count(*) filter (where e.id is null or e.content_model_id <> $1 or e.workspace_id <> $2))
      from content.%I r
      left join public.content_entries e on e.id = r._entry_id
  $sql$, t.table_name) into v_table_counts using p_content_model_id, p_workspace_id;

  -- The names each column's field had before, derived here from the ledger on its own: a recursive
  -- query, not the stored field_aliases the sync used, so a wrong stored alias is a mismatch. Walking
  -- the succeeded renames newest first, each column's key steps back through every rename that
  -- produced it; "below" is the schema version that rename built toward.
  with recursive renames as (
    select row_number() over (order by mv.version_number desc, l.created_at desc, x.n) as ord,
           x.rn ->> 'from' as old_key, x.rn ->> 'to' as new_key, mv.version_number as below
      from public.schema_migration_ledger l
      join public.content_model_versions mv on mv.id = l.target_version_id and mv.content_model_id = l.content_model_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(l.renames) = 'array' then l.renames else '[]'::jsonb end)
        with ordinality as x (rn, n)
     where l.content_model_id = p_content_model_id and l.stage = 'expand' and l.status = 'succeeded'
  ), walk (col, key, ord, below, depth) as (
    select sc.key, sc.value ->> 'field', 0::bigint, null::integer, 0
      from jsonb_each(coalesce(t.applied_shape -> 'columns', '{}'::jsonb)) sc
    union all
    select w.col, nx.old_key, nx.ord, nx.below, w.depth + 1
      from walk w
      cross join lateral (
        select rr.old_key, rr.ord, rr.below from renames rr
         where rr.ord > w.ord and rr.new_key = w.key and rr.old_key ~ '^[a-z][a-z0-9_]*$'
         order by rr.ord
         limit 1) nx
     where w.depth < 1000
  )
  select coalesce(jsonb_object_agg(ag.col, ag.names), '{}'::jsonb) into v_aliases
    from (select w.col, jsonb_agg(jsonb_build_object('name', w.key, 'below', w.below) order by w.depth) as names
            from walk w where w.depth > 0 group by w.col) ag;

  -- Fields: one pass over each side for all columns.
  for c in
    select col.key as name, col.value ->> 'field' as field, col.value ->> 'pgType' as pg_type
      from jsonb_each(coalesce(t.applied_shape -> 'columns', '{}'::jsonb)) col
     order by col.key
  loop
    if c.name !~ '^[a-z][a-z0-9_]{0,62}$' or c.field is null or not (c.pg_type = any (v_pg_types)) then
      raise exception using errcode = '22023', message = 'content_table_shape_invalid';
    end if;
    -- The key the snapshot used: the field's key, or an older name for snapshots saved before a rename.
    v_key := case when v_aliases ? c.name
      then format('coalesce((select a ->> ''name'' from jsonb_array_elements(%L::jsonb) a where v.model_schema_version < (a ->> ''below'')::integer order by (a ->> ''below'')::integer limit 1), %L)', v_aliases -> c.name, c.field)
      else format('%L', c.field) end;
    v_snapshot_expr := case when c.pg_type = 'jsonb'
      then format('nullif(v.data_jsonb -> %s, ''null''::jsonb)', v_key)
      else format('(v.data_jsonb ->> %s)::%s', v_key, c.pg_type) end;
    foreach v_variant in array array['draft', 'published'] loop
      v_hash := 'coalesce(sum((''x'' || substr(md5(%s::text || ''|'' || %L || ''|'' || coalesce(to_jsonb(%s)::text, ''~'')), 1, 15))::bit(60)::bigint) filter (where %s = %L), 0)::text';
      v_snapshot_sql := v_snapshot_sql || format(' || jsonb_build_object(%L, jsonb_build_array(count(%s) filter (where p.variant = %L), %s))',
        c.name || '|' || v_variant, v_snapshot_expr, v_variant, format(v_hash, 'e.id', v_variant, v_snapshot_expr, 'p.variant', v_variant));
      v_table_sql := v_table_sql || format(' || jsonb_build_object(%L, jsonb_build_array(count(r.%I) filter (where r._variant = %L), %s))',
        c.name || '|' || v_variant, c.name, v_variant, format(v_hash, 'r._entry_id', v_variant, format('r.%I', c.name), 'r._variant', v_variant));
    end loop;
    v_fields := v_fields || jsonb_build_object(c.name, jsonb_build_object('field', c.field));
  end loop;

  if v_snapshot_sql <> '' then
    begin
      execute format($sql$
        select '{}'::jsonb %s
          from public.content_entries e
          cross join lateral (values ('draft'::text, e.current_draft_version_id), ('published'::text, e.published_version_id)) p (variant, version_id)
          join public.content_entry_versions v on v.id = p.version_id and v.entry_id = e.id
         where e.content_model_id = $1 and e.workspace_id = $2
      $sql$, v_snapshot_sql) into v_snapshot_fields using p_content_model_id, p_workspace_id;
    exception when data_exception then
      -- A snapshot value does not convert to its column type. The field checksums could not be
      -- computed, so the run can never match on counts alone: that is a mismatch in itself, whether or
      -- not the search below names a column (content can change between the two queries).
      v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('kind', 'snapshot_fields_failed'));
      v_snapshot_fields := '{}'::jsonb;
      -- Find which columns.
      for c in
        select col.key as name, col.value ->> 'field' as field, col.value ->> 'pgType' as pg_type
          from jsonb_each(coalesce(t.applied_shape -> 'columns', '{}'::jsonb)) col
         where col.value ->> 'pgType' <> 'jsonb' and col.value ->> 'pgType' = any (v_pg_types)
         order by col.key
      loop
        v_key := case when v_aliases ? c.name
          then format('coalesce((select a ->> ''name'' from jsonb_array_elements(%L::jsonb) a where v.model_schema_version < (a ->> ''below'')::integer order by (a ->> ''below'')::integer limit 1), %L)', v_aliases -> c.name, c.field)
          else format('%L', c.field) end;
        begin
          execute format($sql$
            select count((v.data_jsonb ->> %s)::%s)
              from public.content_entries e
              cross join lateral (values (e.current_draft_version_id), (e.published_version_id)) p (version_id)
              join public.content_entry_versions v on v.id = p.version_id and v.entry_id = e.id
             where e.content_model_id = $1 and e.workspace_id = $2
          $sql$, v_key, c.pg_type) using p_content_model_id, p_workspace_id;
        exception when data_exception then
          v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('kind', 'snapshot_value_not_convertible', 'column', c.name));
        end;
      end loop;
    end;
    execute format('select ''{}''::jsonb %s from content.%I r', v_table_sql, t.table_name) into v_table_fields;
  end if;

  -- Assemble per column: {"field", "draft": {"snapshot": [n, sum], "table": [n, sum]}, "published": {...}}.
  for c in select key as name from jsonb_each(v_fields) loop
    foreach v_variant in array array['draft', 'published'] loop
      v_side := jsonb_build_object(
        'snapshot', v_snapshot_fields -> (c.name || '|' || v_variant),
        'table', v_table_fields -> (c.name || '|' || v_variant));
      v_fields := jsonb_set(v_fields, array[c.name, v_variant], v_side);
      if (v_side -> 'snapshot') is distinct from (v_side -> 'table') and v_snapshot_fields <> '{}'::jsonb then
        v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('kind', 'field_checksum', 'column', c.name, 'variant', v_variant));
      end if;
    end loop;
  end loop;

  foreach v_variant in array array['draft', 'published'] loop
    if (v_snapshot_counts -> v_variant) is distinct from (v_table_counts -> v_variant) then
      v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('kind', 'row_count', 'variant', v_variant));
    end if;
  end loop;
  if (v_snapshot_counts -> 'rows') is distinct from (v_table_counts -> 'rows') then
    v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('kind', 'row_checksum'));
  end if;
  if coalesce((v_table_counts ->> 'foreign_rows')::bigint, 0) <> 0 then
    v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('kind', 'foreign_rows'));
  end if;
  v_matched := jsonb_array_length(v_mismatches) = 0;

  v_backfill := jsonb_strip_nulls(jsonb_build_object(
    'batches', case when p_batches is null then null else greatest(p_batches, 0) end,
    'entries', case when p_entries is null then null else greatest(p_entries, 0) end,
    'failed', case when p_failed is null then null else greatest(p_failed, 0) end));

  insert into public.content_model_move_runs
    (content_model_id, workspace_id, table_name, shape_hash, sync_failures, matched, counts, fields, mismatches, backfill, requested_by, started_at)
  values (
    p_content_model_id, p_workspace_id, t.table_name, t.applied_shape_hash, v_sync_failures, v_matched,
    jsonb_build_object('snapshot', v_snapshot_counts, 'table', v_table_counts - 'foreign_rows', 'foreign_rows', v_table_counts -> 'foreign_rows'),
    v_fields, v_mismatches, v_backfill,
    (select a.id from public.admin_users a where a.id = p_requested_by),
    v_started)
  returning id into v_run_id;

  insert into public.content_model_storage as s (content_model_id, workspace_id, last_run_id)
  values (p_content_model_id, p_workspace_id, v_run_id)
  on conflict (content_model_id) do update set last_run_id = excluded.last_run_id, updated_at = now();

  return jsonb_build_object('run_id', v_run_id, 'matched', v_matched, 'mismatches', v_mismatches, 'shape_hash', t.applied_shape_hash);
end;
$$;

-- ── Read switch ──────────────────────────────────────────────────────────────────────────────────
-- 'table': only with the model's latest run matched, on the table's current shape hash, no save that
-- failed to reach the table since that run began reading (sync_failures unchanged), and no schema
-- change queued or running. The table
-- row is locked FOR UPDATE first, so a schema change finishing at the same moment either commits
-- before (and the shape check sees it) or waits until this switch commits.
-- 'snapshot': always allowed. This is the rollback.
create or replace function public.polynovea_content_set_read_source(
  p_workspace_id uuid,
  p_content_model_id uuid,
  p_source text,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  s record;
  r record;
begin
  if p_source is null or p_source not in ('snapshot', 'table') then
    raise exception using errcode = '22023', message = 'content_read_source_invalid';
  end if;
  if not exists (select 1 from public.content_models cm where cm.id = p_content_model_id and cm.workspace_id = p_workspace_id) then
    raise exception using errcode = 'P0002', message = 'content_model_not_found';
  end if;

  select mt.applied_shape_hash into t
    from public.content_model_tables mt
   where mt.content_model_id = p_content_model_id and mt.workspace_id = p_workspace_id
   for update;
  if not found and p_source = 'table' then
    raise exception using errcode = 'P0002', message = 'content_model_has_no_table';
  end if;

  insert into public.content_model_storage (content_model_id, workspace_id)
  values (p_content_model_id, p_workspace_id)
  on conflict (content_model_id) do nothing;
  select st.* into s from public.content_model_storage st where st.content_model_id = p_content_model_id for update;

  if p_source = 'table' then
    select mr.id, mr.matched, mr.shape_hash, mr.sync_failures into r
      from public.content_model_move_runs mr
     where mr.content_model_id = p_content_model_id
     order by mr.started_at desc, mr.finished_at desc, mr.id desc
     limit 1;
    if not found or not r.matched then
      raise exception using errcode = '55000', message = 'content_read_switch_no_matching_run';
    end if;
    if r.shape_hash <> t.applied_shape_hash then
      raise exception using errcode = '55000', message = 'content_read_switch_stale_shape';
    end if;
    if s.sync_failures <> r.sync_failures then
      raise exception using errcode = '55000', message = 'content_read_switch_out_of_sync';
    end if;
    if exists (
      select 1 from public.schema_migration_ledger l
       where l.content_model_id = p_content_model_id and l.status in ('pending', 'running')
    ) then
      raise exception using errcode = '55000', message = 'content_read_switch_schema_change_pending';
    end if;
  end if;

  update public.content_model_storage
     set read_source = p_source,
         switched_at = now(),
         switched_by = (select a.id from public.admin_users a where a.id = p_actor),
         updated_at = now()
   where content_model_id = p_content_model_id;

  return jsonb_build_object('content_model_id', p_content_model_id, 'read_source', p_source);
end;
$$;

-- ── App access ───────────────────────────────────────────────────────────────────────────────────
-- 0074's helper exactly as it is now, with two additions only: content_model_storage and
-- content_model_move_runs join the read_only list (the app changes them only through the functions
-- above; on Supabase, service_role cannot write them either), and the content functions join
-- app_only_functions (EXECUTE for polynovea_app only, never service_role). Keep it in step with 0074.
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
    'content_model_storage', 'content_model_move_runs'];
  ledger_request_columns text := 'workspace_id, content_model_id, model_api_key, table_name, stage, plan_hash, '
    || 'base_shape_hash, target_schema_hash, plan_json, requested_by, target_version_id, renames';
  app_only_functions text[] := array['polynovea_confirm_schema_stage', 'polynovea_retry_schema_stage', 'polynovea_cancel_schema_stage',
    'polynovea_content_sync_entries', 'polynovea_content_verify_model', 'polynovea_content_set_read_source',
    'polynovea_content_entries_sync'];
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
revoke all on function public.polynovea_content_sync_entries(uuid[]) from public;
revoke all on function public.polynovea_content_verify_model(uuid, uuid, uuid, integer, integer, integer) from public;
revoke all on function public.polynovea_content_set_read_source(uuid, uuid, text, uuid) from public;
revoke all on function public.polynovea_content_entries_sync() from public;
revoke all on function public.polynovea_content_field_aliases(uuid, jsonb) from public;
revoke all on function public.polynovea_content_store_field_aliases() from public;

select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = greatest(schema_migration, '0076'), updated_at = now() where singleton = true;
