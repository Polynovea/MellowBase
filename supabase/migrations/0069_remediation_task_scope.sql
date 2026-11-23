-- Phase 1 (content health): remediation tasks stay inside their workspace.
--
-- content_remediation_tasks.finding_id, assigned_to and entity_id were plain references, so a task
-- could point at another workspace's health finding, be assigned to someone who is not a member of
-- the workspace, or name an entry or asset of another workspace (the API passes all three straight
-- from the request body). This trigger enforces all three for every writer: both data paths and any
-- direct SQL. Existing rows are left as they are; new rows, and changes to these columns, are
-- checked.

create or replace function public.cms_remediation_task_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved boolean := tg_op = 'INSERT' or new.workspace_id is distinct from old.workspace_id;
begin
  if new.finding_id is not null
     and (moved or new.finding_id is distinct from old.finding_id)
     and not exists (select 1 from public.content_health_findings f where f.id = new.finding_id and f.workspace_id = new.workspace_id) then
    raise exception 'Health finding not found in workspace' using errcode = 'P0002';
  end if;

  if new.assigned_to is not null
     and (moved or new.assigned_to is distinct from old.assigned_to)
     and not exists (
       select 1 from public.workspace_members wm
       where wm.workspace_id = new.workspace_id and wm.admin_user_id = new.assigned_to and wm.status = 'active'
     ) then
    raise exception 'Assignee must be an active workspace member' using errcode = 'P0003';
  end if;

  if moved or new.entity_id is distinct from old.entity_id or new.entity_type is distinct from old.entity_type then
    if new.entity_type = 'entry'
       and not exists (select 1 from public.content_entries e where e.id = new.entity_id and e.workspace_id = new.workspace_id) then
      raise exception 'Entry not found in workspace' using errcode = 'P0002';
    elsif new.entity_type = 'asset'
       and not exists (select 1 from public.assets a where a.id = new.entity_id and a.workspace_id = new.workspace_id) then
      raise exception 'Asset not found in workspace' using errcode = 'P0002';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists cms_remediation_task_scope on public.content_remediation_tasks;
create trigger cms_remediation_task_scope
  before insert or update of workspace_id, finding_id, assigned_to, entity_type, entity_id on public.content_remediation_tasks
  for each row execute function public.cms_remediation_task_scope();

select public.polynovea_apply_app_access();

update public.cms_runtime_state
set schema_migration = '0069', updated_at = now() where singleton = true;
