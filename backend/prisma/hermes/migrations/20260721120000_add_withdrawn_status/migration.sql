-- Requester-initiated withdrawal of a still-open request. A distinct terminal status
-- (rather than reusing REJECTED) so the audit trail never reads a self-withdrawal as an
-- admin decision.
--
-- Note on access_requests: the partial unique index enforcing one OPEN request per
-- (requester_id, group_id) is scoped to status IN ('PENDING','WAITING_FOR_SETUP'), so
-- WITHDRAWN rows fall out of it automatically — a user who withdraws can immediately
-- request that group again. No index change needed.

-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'WITHDRAWN';

-- AlterEnum
ALTER TYPE "ZkChangeStatus" ADD VALUE 'WITHDRAWN';

-- AlterEnum
ALTER TYPE "SecretIngestionStatus" ADD VALUE 'WITHDRAWN';
