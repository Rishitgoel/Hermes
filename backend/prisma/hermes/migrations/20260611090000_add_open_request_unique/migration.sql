-- Enforce "at most one OPEN request per (requester, group)" at the database
-- level. The application already checks this before creating a request, but
-- check-then-create races (double-click, two tabs) could slip a duplicate
-- PENDING row through. Mirrors the partial-unique-index pattern used on
-- user_accesses (20260526120000_replace_user_access_unique).

-- First resolve any duplicates the race already created: keep the NEWEST open
-- request per (requester, group) and mark older ones REJECTED, so the index
-- creation below cannot fail on existing data.
UPDATE "access_requests"
SET "status" = 'REJECTED',
    "reviewer_id" = 'system_migration',
    "reviewer_name" = 'System (migration cleanup)',
    "review_note" = 'Superseded duplicate open request (cleanup before unique index)',
    "reviewed_at" = NOW()
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "requester_id", "group_id"
             ORDER BY "created_at" DESC
           ) AS rn
    FROM "access_requests"
    WHERE "status" IN ('PENDING', 'WAITING_FOR_SETUP')
  ) ranked
  WHERE ranked.rn > 1
);

-- Open = awaiting review (PENDING) or approved-but-parked (WAITING_FOR_SETUP).
-- Terminal/active states (PROVISIONED, REJECTED, ...) are not constrained, so
-- request history accumulates freely.
CREATE UNIQUE INDEX IF NOT EXISTS "access_requests_requester_group_open_unique"
  ON "access_requests" ("requester_id", "group_id")
  WHERE "status" IN ('PENDING', 'WAITING_FOR_SETUP');
