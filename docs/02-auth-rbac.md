# Auth & the three-tier admin model

## Two separate things: authentication vs. authorization

- **Authentication** — is this JWT valid, who is the user. Handled by
  `middleware/auth.middleware.ts` (real Keycloak JWT verification via JWKS, or a
  simulation mode that accepts one of four magic Bearer tokens: `super_admin`,
  `platform_admin`, `group_admin`, `user`).
- **Authorization** — what can this user do. This is the three-tier model below, and
  it is **checked against Hermes' own database, not against the JWT roles directly**.

## The three tiers

| Tier | Scope | Keycloak role | DB mirror |
|---|---|---|---|
| Super admin | everything, every platform | `hermes_super_admin` | none needed — role check only |
| Platform admin | every group on one platform | `hermes_platform_admin_{platform}` | `PlatformAdmin (userId, platform)` |
| Group admin | one group | `hermes_group_admin_{platform}_{slug}` | `GroupAdmin (groupId, userId)` |

Every authenticated user also implicitly gets `hermes_user`. Admin tiers are **additive
and independent of group membership** — being a group admin does not grant you access to
the group's data; you request access like anyone else. Conversely, assigning someone as
an admin doesn't consume/require an active grant.

## Why mirror-authoritative, not Keycloak-authoritative

Keycloak is the system of record for *role grants* (an admin assigns a role there via
`keycloak-admin.service.ts`), but every authorization check in route/controller code
reads the `PlatformAdmin`/`GroupAdmin` **database tables**
(`utils/authz.ts` — `isSuperAdmin()`, `isPlatformAdminOf()`, `isGroupAdminOf()`,
`isAnyAdmin()`, `computeAdminScopes()`), not the JWT's role claims for platform/group
tiers. Reasons:

1. **Immediate revocation.** Deleting the mirror row revokes authorization instantly.
   Removing the Keycloak role only affects the *next* token the user gets (JWTs are
   self-validating and don't expire early) — `keycloak-admin.service.ts` also
   best-effort logs the user out (`logoutUser()`) as defense-in-depth, but that's
   secondary.
2. **Works in simulation/offline mode.** No dependency on a live Keycloak connection for
   every authorization check.
3. **Fast.** Local DB read vs. an admin API round-trip.

`AdminReconciliationService.reconcileAll()` is the job that keeps the mirrors in sync
with Keycloak (Keycloak → DB, one direction only, never writes back to Keycloak). It
runs on a schedule (every 30 min prod) and can be triggered manually
(`POST /api/admin/reconcile?dryRun=true`, super admin only). If Keycloak isn't reachable,
reconciliation is skipped entirely rather than wiping local mirrors.

`computeAdminScopes(user)` returns `{ superAdmin: bool, platforms: string[], groups:
string[] }` and is what `/auth/me` returns to the frontend for nav/route gating (see
[05-frontend.md](05-frontend.md)); it's memoized per-request via a `WeakMap` since
multiple checks in one request would otherwise repeat the same DB queries.

## What each tier can do

**Super admin**
- Assign/remove platform admins and group admins, anywhere.
- Create/update/delete/archive groups and levels, any platform.
- View and manage members across all groups.
- View the audit log.
- Trigger manual platform sync, admin reconciliation, Redash import/resync, ZooKeeper ACL
  migration.
- Approve/reject platform account (user-creation) requests, any platform.
- Disable/delete platform accounts, any platform.

**Platform admin** (e.g. "redash")
- Everything a group admin can do, for every group on that platform.
- Group CRUD and level CRUD on that platform.
- Assign/remove group admins on that platform.
- Approve/reject account-creation requests for that platform.
- Cannot trigger global sync/reconciliation or manage other platforms.

**Group admin**
- Approve/reject access requests for their group.
- View/add/remove members, set member levels directly (admin override, bypasses the
  normal request flow).
- Cannot create groups or manage admins beyond their own group.

## Keycloak specifics worth knowing

- Role assignment changes only reach a user's JWT on their **next login or token
  refresh** — not instantly. `logoutUser()` (best-effort session termination) is the only
  lever to force this sooner, and it doesn't invalidate already-issued tokens.
- `ensureCompositeRole()` sets up e.g. `hermes_group_admin_growth` as a *composite* of the
  marker role `hermes_group_admin`, so a scoped role automatically carries the marker
  into the JWT.
- In simulation mode (`KEYCLOAK_SIMULATION=true`, non-prod), all Keycloak-mutating calls
  become logged no-ops; the DB mirrors are still maintained by the calling code, so
  authorization behaves identically to live mode.

## Related reading

- [03-domains/access-workflow.md](03-domains/access-workflow.md) — how `isGroupAdminOf`
  etc. gate the actual request-review endpoints.
- [03-domains/admin-management.md](03-domains/admin-management.md) — the
  assign/remove-admin endpoints and reconciliation in more depth.
