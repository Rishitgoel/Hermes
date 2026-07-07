# Domain: Audit logging

**Key files:** `controllers/audit.controller.ts`. Data model: `AuditEntry`
(see [04-data-model.md](../04-data-model.md)).

## Shape

Every `AuditEntry` row: `action` (free string, not an enum — see the list below),
`performerId`/`performerName` (who did it — `"system"`/`"System (cascade reject)"`/etc.
for automated actions), `targetUserId`/`targetUserName` (who it affects, if applicable),
`groupId`, `accessRequestId`, `details` (JSON, action-specific), `createdAt`. Entries are
never updated or deleted by application code — this is a write-once log.

## What gets written, by domain

- **Access requests**: `REQUEST_CREATED`, `REQUEST_REJECTED`, `PROVISION_FAILED`.
- **Access grants**: `ACCESS_GRANTED`, `ACCESS_RENEWED`, `ACCESS_LEVEL_CHANGED`,
  `ACCESS_REVOKED`, `ACCESS_EXPIRED`, `ACCESS_EXPIRY_FAILED`, `ACCESS_QUEUED_FOR_SETUP`,
  `ACCESS_BULK_REVOKED`, `ACCESS_IMPORTED`.
- **Admin management**: `PLATFORM_ADMIN_ASSIGNED`/`_REVOKED`,
  `GROUP_ADMIN_ASSIGNED`/`_REVOKED`, `GROUP_CREATED`/`_UPDATED`/`_DELETED`/`_ARCHIVED`,
  `GROUP_LEVEL_CREATED`/`_UPDATED`/`_DELETED`/`_DEACTIVATED`, `GROUP_PATHS_RECONCILED`.
- **Platform/global**: `MANUAL_SYNC_TRIGGERED`, `ADMIN_RECONCILE_TRIGGERED`,
  `REDASH_IMPORT_TRIGGERED`, `REDASH_RESYNC_TRIGGERED`, `ZOOKEEPER_MIGRATION_TRIGGERED`,
  `PLATFORM_ACCOUNT_DISABLED`, `ACCOUNTS_BULK_DISABLED`.

See [access-workflow.md](access-workflow.md), [admin-management.md](admin-management.md)
and [provisioning.md](provisioning.md) for the actions that trigger each of these.

## Bulk correlation

When N requests are submitted together (`createRequestsBulk`), each still gets its own
`REQUEST_CREATED` row, but all share a `bulkId` (UUID) inside `details` so they can be
grouped in the UI, and only **one** consolidated event/notification fires for the whole
batch rather than N.

## Querying

`GET /api/audit` (super admin only): filters on `action` (exact), `search` (matches
performer or target name), `performerId`, `groupId` **or** `platform` (resolved to that
platform's groupIds), `fromDate`/`toDate` (accepts a bare `YYYY-MM-DD` or a full ISO
timestamp). Paginated via `pageno`/`pagesize` headers (default 1/10, max pagesize 100),
sorted `createdAt DESC`.

## Why this exists separately from the event bus

Audit entries are written **synchronously, inside the same transaction/call path as the
state change**, before the corresponding event is emitted. This ordering matters: if
event delivery is lost (see [notifications.md](notifications.md) — fire-and-forget, no
retry), the audit trail is unaffected. Audit is the durable record; notifications are
best-effort UX on top of it.
