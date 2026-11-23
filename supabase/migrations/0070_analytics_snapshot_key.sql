-- Phase 1 (content analytics): one snapshot per entry, version, source and period, also when the
-- entry has no published version.
--
-- content_analytics_snapshots was unique on (workspace_id, entry_id, version_id, source,
-- period_start, period_end), but version_id is null for an entry that is not published (and for a
-- manual snapshot without a version). Nulls are distinct in a plain unique constraint, so the
-- upsert never matched those rows: every GA4 sync added two more rows per such route, and the
-- 28-day comparison read whichever came first. The key now treats null as a value (PostgreSQL 15+,
-- the minimum supported version).
--
-- Existing duplicates are not deleted outright: all but the newest of each group (by captured_at,
-- then id) move to content_analytics_snapshots_duplicate_archive, so nothing is lost.

create table if not exists public.content_analytics_snapshots_duplicate_archive (
  like public.content_analytics_snapshots including defaults,
  archived_at timestamptz not null default now()
);
alter table public.content_analytics_snapshots_duplicate_archive enable row level security;

with ranked as (
  select id, row_number() over (
    partition by workspace_id, entry_id, version_id, source, period_start, period_end
    order by captured_at desc, id desc
  ) as position
  from public.content_analytics_snapshots
  where version_id is null
), moved as (
  insert into public.content_analytics_snapshots_duplicate_archive
  select s.*, now()
  from public.content_analytics_snapshots s
  join ranked r on r.id = s.id
  where r.position > 1
  returning id
)
delete from public.content_analytics_snapshots s
using moved
where s.id = moved.id;

do $$
declare
  old_key text;
begin
  -- The original key was declared inline, so its name is generated; find it by its columns.
  select c.conname into old_key
  from pg_constraint c
  where c.conrelid = 'public.content_analytics_snapshots'::regclass
    and c.contype = 'u'
    and array_length(c.conkey, 1) = 6
    and c.conname <> 'content_analytics_snapshots_period_key';
  if old_key is not null then
    execute format('alter table public.content_analytics_snapshots drop constraint %I', old_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'content_analytics_snapshots_period_key') then
    alter table public.content_analytics_snapshots
      add constraint content_analytics_snapshots_period_key
      unique nulls not distinct (workspace_id, entry_id, version_id, source, period_start, period_end);
  end if;
end $$;

select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = '0070', updated_at = now() where singleton = true;
