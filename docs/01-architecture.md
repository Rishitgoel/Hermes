# Architecture

## High-level flow

```
User (browser)
   │  React SPA (frontend/src) — Keycloak-authenticated, or mock role in simulation
   ▼
Express API (backend/src/app.ts)
   │  auth.middleware → controllers → services
   ▼
Postgres (Prisma, prisma/hermes/schema.prisma)   ◄──── source of truth for Hermes state
   │
   ├─► Provisioner adapters (services/*.provisioner.ts) ──► external platforms:
   │        AWS Identity Center · Redash (prod/QA) · ZooKeeper · Secrets Manager
   │
   ├─► Event bus (services/event-bus.ts) ──► event-listeners.ts ──► Notifications
   │                                                                (in-app / SSE / Slack / email)
   │
   └─► Scheduler (services/scheduler.service.ts) — cron jobs: auto-revoke, platform
        sync, admin reconciliation, stuck-request sweeps, notification prune
```

Hermes' own Postgres database (`DATABASE_URL_HERMES`) is the single source of truth for
requests, grants, group config, admin assignments, and audit history. External platforms
are treated as **provisioning targets**, not sources of truth — Hermes maintains a
read-through cache of each platform's users/groups (`PlatformExternalUser`,
`PlatformExternalGroup`) that periodic sync keeps aligned.

Keycloak is the source of truth for **identity and admin role grants**
(`hermes_super_admin`, `hermes_platform_admin_*`, `hermes_group_admin_*`), but Hermes
authorizes against its own DB mirror tables (`PlatformAdmin`, `GroupAdmin`) for
speed and offline/simulation support — see [02-auth-rbac.md](02-auth-rbac.md).

## Request lifecycle (the core loop)

This is the central workflow everything else hangs off. Full detail (including level
swaps, renewals, bulk operations, and every edge case) is in
[03-domains/access-workflow.md](03-domains/access-workflow.md); this is the shape of it:

```
                 user submits
                      │
                      ▼
                  PENDING ──────────────► REJECTED (admin rejects)
                      │
              admin approves
                      │
        ┌─────────────┴──────────────┐
        │                             │
  user's platform account       user's platform account
  already COMPLETED             not yet COMPLETED
        │                             │
        ▼                             ▼
   PROVISIONING              WAITING_FOR_SETUP
        │                             │
        │                    (user-creation.completed
        │                     event fires later)
        │                             │
        │                             ▼
        │                       PROVISIONING
        │                             │
        └──────────────┬──────────────┘
                        ▼
                 PROVISIONED ──(platform call throws)──► PROVISION_FAILED
                        │
          ┌─────────────┼─────────────────┐
          │                               │
   expiresAt reached              admin revokes
   (scheduler, hourly)                    │
          │                               │
          ▼                               ▼
       EXPIRED                        REVOKED
```

Key design decisions worth internalizing up front:

- **One active grant per (user, group), enforced by a partial unique index**
  (`UserAccess (userId, groupId) WHERE isActive = true`), not by application logic alone.
  Level changes and renewals go through an atomic "swap" (deactivate old, create new,
  mark old request superseded) rather than two separate grants ever coexisting.
- **Provisioning is best-effort on the platform side once Hermes' own state is
  committed.** A revoke or expiry commits the DB change first; if the external platform
  call then fails, that failure is logged/audited for manual cleanup rather than rolling
  back the Hermes-side revoke. The reasoning: Hermes' grant record is the thing being
  protected, and a partial revoke (DB says revoked, platform still has them) is safer
  than the reverse.
- **WAITING_FOR_SETUP is not a dead end.** It exists because a group access request can
  be approved before the user has finished setting up an account on the target platform.
  It's cleared automatically when the platform account transitions to `COMPLETED`
  (event-driven, not polled).

## Event bus

`services/event-bus.ts` is a plain Node `EventEmitter` wrapper. Services that change
state (access-workflow, user-creation, zookeeper-config, secret-ingestion) emit events;
`services/event-listeners.ts` is the single place that subscribes and fans out to
notifications (and, for one specific case, default group membership — see below). This
exists purely to **decouple the request/approval transaction from side effects**: a Slack
outage or email failure must never block or roll back an approval.

Events emitted include `request.created`, `requests.bulk.created`, `request.approved`,
`request.rejected`, `access.revoked`, `access.expired`, `access.expiry-failed`,
`access.queued-for-setup`, `user-creation.submitted` / `.invited` / `.rejected` /
`.completed`, `zk-change.submitted` / `.reviewed`, `secret-ingestion.submitted` /
`.reviewed`. A wildcard listener (`eventBus.on('*', ...)`) logs every event for
debugging.

Delivery is **at-most-once, fire-and-forget** — there's no queue or retry. This is an
accepted tradeoff (see `ROADMAP.md` item P3-2, "event bus → BullMQ/Redis"): notifications
are idempotent enough that an occasional dropped event is a minor UX gap, not a
correctness bug, since the audit trail (written before the event fires) is the
authoritative record regardless of whether the notification made it out.

One listener is *not* about notifications: on `user-creation.completed`,
`default-membership.service.ts` grants the platform's built-in "default" group
membership (mirroring what platforms like Redash do automatically for every new user).
It's registered as a separate listener from the notification handler specifically so
that a failure in one never blocks the other.

## Scheduler (background jobs)

`services/scheduler.service.ts` runs cron jobs in-process (node-cron). **There is no
leader election or distributed lock in Hermes 2** — this is fine because Hermes 2 runs a
single process. It becomes a real constraint the moment this code runs multiple
replicas, which is exactly why admin-panel's vendored copy wraps this in a Redis leader
lock (`hermes/services/leader-election.service.ts`) — see
[06-admin-panel-sync.md](06-admin-panel-sync.md).

| Job | Cadence (prod / dev) | Purpose |
|---|---|---|
| Auto-revocation | hourly / every 5 min | Revoke grants past `expiresAt`, 5 concurrent |
| Platform sync | every 15 min / every 5 min | Refresh platform user/group cache, reconcile Hermes groups |
| Admin reconciliation | every 30 min / every 10 min | Sync Keycloak roles → `PlatformAdmin`/`GroupAdmin` mirrors |
| ZooKeeper APPLYING sweep | every 10 min / every 5 min | Recover change requests stuck mid-apply after a crash/redeploy |
| Secret ingestion APPLYING sweep | every 10 min / every 5 min | Same recovery, for secret ingestion requests |
| Notification prune | daily 03:15 UTC / hourly | Delete read notifications >30 days old, all notifications >90 days |

Every job swallows its own errors (logs, doesn't throw) so one bad run never kills the
scheduler.

## Bootstrap sequence (`backend/src/app.ts`)

1. Load config (`config/config.ts`, module-level, `.env`-driven).
2. `loadSecrets()` — in production, pulls a JSON blob from AWS Secrets Manager and injects
   it into `process.env` before anything else initializes; **fails closed** (crashes) if
   this fails outside dev.
3. Dynamic imports of the Express app, Keycloak setup, scheduler, sync, event listeners —
   deliberately deferred so their module-level config reads see the secrets injected in
   step 2.
4. `registerEventListeners()`.
5. `keycloakSetupService.ensureClientAndRolesExist()` — idempotently ensures the Keycloak
   client and the four `hermes_*` marker roles exist.
6. `schedulerService.start()`.
7. `syncService.syncAllPlatforms()` — initial cache warm, backgrounded (doesn't block
   server start).
8. `app.listen(PORT)`.
9. `SIGTERM`/`SIGINT` handlers stop the scheduler and close the server.

## Data flow summary

- **Frontend → Backend**: Axios (`apiClient.ts`) with a Bearer token (Keycloak or a
  mock token in simulation mode), envelope-unwrapped by a response interceptor. See
  [05-frontend.md](05-frontend.md).
- **Backend → Postgres**: Prisma, single client (`config/prisma.ts`), one schema
  (`prisma/hermes/schema.prisma`). See [04-data-model.md](04-data-model.md).
- **Backend → external platforms**: only through the `PlatformAdapter` interface via
  `provisioning.registry.ts` — no controller or service calls a platform SDK directly.
  See [03-domains/provisioning.md](03-domains/provisioning.md).
- **Backend → user (real-time)**: Server-Sent Events (`GET /api/notifications/stream`),
  token passed as a query param since `EventSource` can't set headers.
