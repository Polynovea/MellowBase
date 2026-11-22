-- Admin sessions resolve profiles by the immutable auth user ID (see lib/admin/profileResolution.ts).
-- One auth identity must map to at most one admin profile.
--
-- If this fails with a duplicate-key error, two admin_users rows share an auth_user_id. Find them with
--   select auth_user_id, array_agg(id) from admin_users where auth_user_id is not null group by 1 having count(*) > 1;
-- and clear auth_user_id on the profile that should not own that identity before re-running.
create unique index if not exists admin_users_auth_user_id_key
  on admin_users (auth_user_id)
  where auth_user_id is not null;
