# Domain: Admin management, groups/levels, reconciliation, sync

**Key files:** `controllers/admin.controller.ts`, `controllers/admin-management.controller.ts`,
`controllers/group.controller.ts`, `services/admin-reconciliation.service.ts`,
`services/sync.service.ts`. Data model: `Group`, `GroupLevel`, `GroupAdmin`,
`PlatformAdmin`, `PlatformExternalUser`, `PlatformExternalGroup`.

This doc covers the "manage the shape of the system" surface: who's an admin of what,
what groups/levels exist, and how Hermes' view of each platform's groups stays in sync
with reality.

## Admin assignment

Covered in depth in [02-auth-rbac.md](../02-auth-rbac.md). The endpoints:

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET/POST/DELETE | `/api/admin/platform-admins` | super admin | Assign/remove platform admin |
| GET/POST/DELETE | `/api/admin/group-admins` | super or platform admin | Assign/remove group admin |

Assigning an admin role does **not** create a group membership grant; removing one does
**not** revoke existing membership. The two are deliberately independent.

## Group & level CRUD

- **Groups** (`POST/PUT/DELETE /api/admin/groups/:groupId`, super or platform admin):
  - Delete is **hard** if the group is pristine (no request/access/admin history) —
    levels and admins cascade-delete.
  - Delete is a **soft archive** (`isActive=false`) if history exists; existing members
    keep access until expiry/revoke, but the group can't be selected for new requests.
  - `?force=true` on delete ignores the safety checks.
  - `(platform, name)` is unique; slugs are globally unique (auto-suffixed on collision).
- **Levels** (`/api/admin/groups/:groupId/levels`, super or platform admin):
  - Hard delete only if no active members **and** no in-flight requests (terminal
    requests don't block — their `levelId` is set null by the FK).
  - Otherwise soft-deactivate.
  - `(groupId, slug)` unique, but the same slug can be reused across different groups.

## Members & cross-platform user view

- `GET /api/admin/groups/:groupId/members` / `POST .../members` / `PUT
  .../members/:userAccessId/level` / `DELETE .../members/:userAccessId` — group admin+.
- `GET /api/admin/user-access?userId=` — cross-platform view of everything a user holds,
  for offboarding decisions.
- `GET /api/admin/user-platform-accounts?userId=` / `POST
  /api/admin/user-access/disable-accounts` — offboarding: disable or delete a user's
  platform account(s), scoped to platforms the caller administers. Remember AWS's
  `disableUser` is **irreversible** while Redash's is reversible — see
  [provisioning.md](provisioning.md).

## Admin reconciliation (Keycloak ↔ DB mirrors)

`AdminReconciliationService.reconcileAll()` — one-directional, **Keycloak is the source
of truth, DB mirrors are corrected to match it, never the other way**:

1. For each `hermes_platform_admin_{platform}` and `hermes_group_admin_{platform}_{slug}`
   role, fetch the users holding it in Keycloak.
2. Diff against the `PlatformAdmin`/`GroupAdmin` tables: insert missing mirror rows,
   delete mirror rows for users no longer in the Keycloak role.
3. Per-role error isolation — one role's read failing doesn't block the others.
4. **If Keycloak isn't live, the whole reconciliation is skipped** (never wipes local
   mirrors based on an absence of data).

Triggered by the scheduler (every 30 min prod) or manually: `POST
/api/admin/reconcile?dryRun=true` (report without writing) or without the flag (apply),
super admin only.

## Platform sync (`sync.service.ts`)

Distinct concern from the above — this keeps the **platform user/group cache** current,
not admin roles.

- `syncAllPlatforms()` — loops every non-disabled registered adapter, calls
  `syncSinglePlatform()` per platform via `Promise.allSettled` (one platform's failure
  doesn't block others). Triggered by the scheduler (every 15 min prod) or manually
  (`POST /api/admin/sync?platform=`).
- `syncSinglePlatform()` — `adapter.syncGroups()` then `adapter.syncUsers()` (groups
  first, since member counts depend on both), then `reconcileHermesGroups()`.
- **`reconcileHermesGroups()`** — the part worth understanding in detail, since it's
  where "a platform group was renamed/recreated outside Hermes" gets healed rather than
  silently orphaning Hermes' group record:
  1. Heal levels/groups whose backing platform group was recreated (matched by name,
     dash/whitespace-insensitive), reactivating if needed — **healing always runs before
     archiving**, so a deleted-and-recreated group gets re-linked rather than archived.
  2. Fold stray sync-created groups back into levels if their name parses as
     `"<parent> — <level>"` and the parent exists.
  3. Auto-create Hermes groups/levels for platform groups Hermes doesn't know about yet
     (skipping reserved groups and duplicates).
  4. Deactivate levels / archive groups whose backing platform group has vanished — but
     only after a **10-minute grace period** from creation (avoids archiving something
     that appeared moments ago in a still-settling cache) and, for groups, only if *all*
     of its levels are already inactive.
  5. **An empty sync result aborts reconciliation entirely** — this is a deliberate
     safety valve against archiving everything because of a transient platform API
     outage.

Every reconciliation action writes its own audit entry (`performerId: "system"`,
`performerName: "Platform Sync"`).

## Related maintenance tooling (super admin only)

- `POST /api/admin/import-redash-memberships`, `POST
  /api/admin/resync-redash-memberships` — see
  [provisioning.md](provisioning.md#redash-prod--qa).
- `POST /api/admin/migrate-zookeeper-acls` — see
  [provisioning.md](provisioning.md#zookeeper).
- `POST /api/admin/maintenance/ensure-secrets-group` — idempotently creates the "All
  Secrets" group.
