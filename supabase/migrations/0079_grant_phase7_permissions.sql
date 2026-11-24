-- 0079: give owners and admins the taxonomy, routing, redirect and navigation permissions.
--
-- 0007 granted the owner role every permission that existed then, and the admin role all of them but
-- workspace.manage. 0024 added taxonomy.*, routing.*, redirect.* and navigation.* but granted them to
-- no role (0050, 0053 and 0056 each grant their own). So on a fresh install the owner, "the one account
-- that can do everything", was refused with "Missing required permission" on Site Tree & Routes,
-- Taxonomy, Redirects and Navigation, and since publishing and releases need an entry's canonical route,
-- nothing could be published. Found by the admin UI tests (docs/ui-audit/report.md, B6).
--
-- Same rule as 0007: owner and admin get them (these are content structure, not workspace management).
-- Editors and viewers keep what they have; a workspace can grant more through Access.
-- Idempotent: re-running inserts nothing new.

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key = any(array[
  'taxonomy.read', 'taxonomy.manage',
  'routing.read', 'routing.manage',
  'redirect.read', 'redirect.manage',
  'navigation.read', 'navigation.manage'
]::text[])
where r.key in ('owner', 'admin')
on conflict do nothing;
