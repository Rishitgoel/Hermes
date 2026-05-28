-- Drop the stale full-column unique index that the original schema declared
-- but the application no longer wants: (user_id, group_id, is_active).
-- The old constraint caused violations on grant -> revoke -> grant cycles
-- because revoked rows kept (user_id, group_id, false) tuples around.
DROP INDEX IF EXISTS "user_accesses_user_id_group_id_is_active_key";

-- Replace it with a partial unique index that enforces "at most one active
-- grant per (user, group)" — exactly the invariant the application code
-- actually relies on. Revoked rows (is_active = false) are not constrained,
-- so a user can be re-granted access freely.
CREATE UNIQUE INDEX IF NOT EXISTS "user_accesses_user_id_group_id_active_unique"
  ON "user_accesses" ("user_id", "group_id")
  WHERE "is_active" = true;
