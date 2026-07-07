# Data model

Schema: `backend/prisma/schema.prisma` (PostgreSQL, `DATABASE_URL_HERMES`). Two Prisma
clients are generated: the standard client (most of the codebase) and a custom-output
client at `generated/hermes` (used specifically where enum types need direct import,
e.g. `admin-management.controller.ts`, `group.controller.ts`, tests).

18 models across 8 functional groups. This doc is the field-level reference — for how
these get *created and mutated*, see the corresponding [03-domains/](03-domains) file.

## Groups & permissions

### `Group`
The unit users request access to. `id`, `name`, `slug` (unique), `description`, `icon`,
`color` (UI display), `externalGroupId` (the platform-side group/path/pattern — format is
platform-specific, see [provisioning.md](03-domains/provisioning.md)), `isActive`
(soft-delete), `tables` (string[], informational), `platform` (free string, matches a
provisioning-registry key — not an FK, so new platforms need no migration). Unique on
`(platform, name)`.

### `GroupLevel`
A permission tier within a group (e.g. "Intern" vs "Senior Dev"), each backed by its own
`externalGroupId` so the platform enforces different real permissions per tier. `rank`
(integer, higher = more senior). Unique on `(groupId, slug)` — slugs are **not** globally
unique, only group-scoped. Cascade-deletes with its parent `Group`.

### `GroupAdmin`
`(groupId, userId)` mirror row — see [02-auth-rbac.md](02-auth-rbac.md). Unique on
`(groupId, userId)`. Cascade-deletes with its `Group`.

### `PlatformAdmin`
`(userId, platform)` mirror row. **No FK to Group** — `platform` is a free string by
design, matching the registry key. Unique on `(userId, platform)`.

## Access requests & grants

### `AccessRequest`
The request record. `groupId`, `levelId` (nullable — null for level-less groups),
requester snapshot fields (`requesterId/Name/Email`), `justification`, `duration`
(`AccessDuration` enum: `ONE_DAY | ONE_WEEK | ONE_MONTH | THREE_MONTHS | PERMANENT`),
`expiresAt` (null if permanent), `status` (`RequestStatus`, below), reviewer snapshot
fields, `provisionedAt`/`provisionError`, `revokedAt`/`revokeReason`.

**`RequestStatus`**: `PENDING`, `APPROVED` (deprecated — never actually written, kept for
backward compat), `PROVISIONING`, `PROVISIONED`, `PROVISION_FAILED`, `EXPIRED`,
`REVOKED`, `REJECTED`, `WAITING_FOR_SETUP`. Full transition diagram in
[01-architecture.md](01-architecture.md#request-lifecycle-the-core-loop).

A partial unique index (raw SQL migration, not Prisma-expressible) enforces: one open
request per `(requesterId, groupId)` while `status IN ('PENDING','WAITING_FOR_SETUP')`.

### `UserAccess`
The actual grant — separate from `AccessRequest` because it represents *provisioned
state*, not *request state*. `userId`, `groupId`, `levelId` (nullable), `externalUserId`
(the platform-side user id), `isActive`, `grantedAt`/`expiresAt`/`revokedAt`,
`expiryAttempts`/`lastExpiryError` (auto-expiry retry bookkeeping, capped at 3 attempts —
see [access-workflow.md](03-domains/access-workflow.md#expiry-scheduled-hourly-in-prod)),
`grantedBy`, `accessRequestId` (nullable link back to the originating request).

A partial unique index enforces: at most one active grant per `(userId, groupId)` — note
this is **not** scoped by `levelId`, which is intentional: it's what makes the
deactivate-old/create-new "swap" pattern (level changes, renewals) work without ever
briefly holding two active rows. An earlier `@@unique([userId, groupId, isActive])`
constraint caused violations across repeated grant/revoke cycles and was replaced with
this partial index.

## User onboarding

### `UserCreationRequest`
Per-`(userId, platform)` and per-`(userEmail, platform)` (both unique) gate on platform
account creation — see [user-creation.md](03-domains/user-creation.md). `status`
(`UserCreationStatus`: `DRAFT | PENDING | APPROVED | REJECTED | AWAITING_SETUP |
COMPLETED`), `inviteLink`/`inviteError`, `externalUserId`, full timestamp trail
(`submittedAt`, `approvedAt`, `inviteSentAt`, `completedAt`, `reviewedAt`).

## Platform cache (read-through mirror, no FK)

### `PlatformExternalUser` / `PlatformExternalGroup`
Generic per-platform mirror of the external system's users/groups, keyed by
`(platform, externalId)` — adding a platform requires zero schema changes. `metadata`
(Json) holds anything platform-specific (AWS ARN, Redash org id, etc.).
`PlatformExternalUser.isPending` flags an invited-but-not-yet-active user (protects
against premature cache pruning — see
[provisioning.md](03-domains/provisioning.md#aws-iam-identity-center)).

## ZooKeeper config management

### `ZookeeperChangeRequest`
Draft znode changes awaiting approval. `changes` (Json array of
`{ path, action: SET|CREATE|DELETE|CLEAR, oldValue, newValue, groupId, groupName,
decision?, applied?, error? }`), `groupIds` (all groups the change touches — can span
several of the requester's groups), `status` (`ZkChangeStatus`: `PENDING | APPLYING |
APPLIED | PARTIALLY_APPLIED | APPLY_FAILED | REJECTED`). `groupId` FK is `SetNull` on
group delete (the request survives group deletion with a null pointer). See
[provisioning.md](03-domains/provisioning.md#zookeeper).

## Secrets

### `SecretIngestionRequest`
Same shape as `ZookeeperChangeRequest`, for secret key/value entries instead of znode
changes. `entries` (Json array of `{ key, value, decision?, applied?, error? }`),
`status` (`SecretIngestionStatus`, same 6 values as `ZkChangeStatus`). See
[secret-ingestion.md](03-domains/secret-ingestion.md).

## Audit & notifications

### `AuditEntry`
Write-once log — see [audit.md](03-domains/audit.md) for the full action list.
`action` is a free string (not an enum). Indexed on `performerId`, `action`, `createdAt`.

### `Notification`
In-app notification — see [notifications.md](03-domains/notifications.md). No FK to
anything; `linkUrl` is a plain string deep link. Indexed on `(userId, isRead)`.

## Cascade / delete behavior summary

| Model | Parent | Behavior |
|---|---|---|
| `GroupLevel` | `Group` | Cascade delete |
| `GroupAdmin` | `Group` | Cascade delete |
| `ZookeeperChangeRequest` | `Group` (optional) | `SetNull` |
| `SecretIngestionRequest` | `Group` (optional) | `SetNull` |
| everything else | — | implicit Restrict |

## Patterns worth internalizing

- **`platform` is a free string everywhere**, not an FK — `Group.platform`,
  `PlatformAdmin.platform`, `UserCreationRequest.platform` all just have to match a
  provisioning-registry key. This is what lets a new platform be added without a
  migration.
- **Partial unique indexes carry real business invariants** — the "one open request" and
  "one active grant" rules live in raw-SQL partial indexes, not (only) in application
  code. If you're writing a migration that touches `AccessRequest` or `UserAccess`,
  check for these before assuming a plain `@@unique` will do.
