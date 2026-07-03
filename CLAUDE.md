# Hermes — Project Guide for Claude

Read this first whenever you start a chat in this repo. It encodes how the project works and how the user (solo dev, Rishit) wants to work in it.

## TL;DR

Hermes is an internal **access-management portal**. Users request access to groups; admins approve; the backend provisions the user on the target platform. **Two adapters are live today — Redash and AWS IAM Identity Center** — both registered behind `PlatformAdapter` / `ProvisioningRegistry`; Jira / etc. are still UI stubs. The provisioning layer is platform-agnostic: adding a platform is implement-the-adapter-and-register-it (no workflow / schema / Keycloak changes). Stack: Node/Express + Prisma + Postgres on the backend, React + Vite on the frontend, Keycloak for auth.

If the user asks for "the roadmap" or for the next thing to work on, check **`ROADMAP.md`** at the repo root — that's the prioritized backlog (P1 → P3).

---

## How Rishit wants to work

These preferences came up explicitly. Don't violate them without asking.

- **Always work on `main`.** Don't create feature branches. Don't create worktrees. Don't open PRs. Commit directly to main, push to `origin/main`.
- **Don't suggest** branches/worktrees/PRs as a "best practice." They're not wanted here.
- **Keep things simple.** Solo dev, single-environment, no team. Skip ceremony.
- **Ask before destructive remote operations** (force push, remote branch delete) — local stuff is fine.
- **The user is not a senior engineer.** Be explicit about file paths, commands, and what you're about to do. Don't assume context.

## Commit style

- Single subject line summarizing the change, then a body explaining what & why.


---

## Project layout

```
D:\Bachatt\Hermes 2\
├── backend/                       # Node + Express + Prisma
│   ├── prisma/hermes/             # ⚠ non-default Prisma path
│   │   ├── schema.prisma
│   │   ├── seed.ts
│   │   └── migrations/
│   ├── src/
│   │   ├── app.ts                 # bootstrap (entrypoint)
│   │   ├── index.ts               # express app + routes wired
│   │   ├── config/                # config.ts, prisma.ts, keycloak-setup.ts, secrets.ts
│   │   ├── controllers/           # extend BaseController
│   │   ├── routes/                # one router per resource
│   │   ├── services/              # business logic + provisioners + event bus
│   │   ├── middleware/            # auth, security, error
│   │   ├── validations/           # Zod schemas
│   │   └── utils/                 # errors, http-client, logger
│   └── package.json
├── frontend/                      # Vite + React 19
│   └── src/
│       ├── pages/                 # one per route
│       ├── components/access/...
│       ├── components/common/...
│       ├── components/layout/...
│       ├── contexts/              # AuthContext, NotificationContext
│       └── services/apiClient.ts
├── docker-compose.yml             # postgres, keycloak, redis, redash stack
├── ROADMAP.md                     # post-P0 backlog (P1-P3) — read this for "what next"
└── CLAUDE.md                      # this file
```

---

## Dev environment

To save RAM on local development (especially on 8GB machines), the project keeps its local footprint minimal: the only required Docker container is **Postgres**, while **auth and integrations run in Simulation Mode** so Keycloak and Redash don't need to run.
* **Database**: A local **Postgres** running in Docker (`localhost:15433`, database `hermes`) — connection string in `backend/.env` as `DATABASE_URL_HERMES`.
* **Authentication**: Skips Keycloak and runs in **Simulation Mode** (enabled in `.env` files).
* **Integrations**: Skips Redash and AWS and runs in **Simulation Mode** (enabled in `.env` files).

### Docker Services (`docker-compose.yml`)
The dev **Postgres runs in its own Docker container** on `localhost:15433` (the `postgres` service in `docker-compose.yml` is left commented — Postgres is started separately). The **Keycloak, Redis, and Redash-stack** services in `docker-compose.yml` are uncommented but only matter if you switch off Simulation Mode; otherwise the backend never talks to them. To bring one of those up live locally:
1. Uncomment the service in [docker-compose.yml](file:///d:/Bachatt/Hermes%202/docker-compose.yml).
2. Start Docker Desktop and run `docker compose up -d`.
3. Set the respective simulation flags to `false` in your `.env` files.
4. Run the live Redash reset script from the `backend/` directory to wipe mock state and link groups & levels: `npx ts-node scripts/reset-for-live-redash.ts`.

### Environment files

- `backend/.env` and `frontend/.env` exist locally (gitignored).
- `.env.example` files exist as templates ([backend/.env.example](file:///d:/Bachatt/Hermes%202/backend/.env.example), [frontend/.env.example](file:///d:/Bachatt/Hermes%202/frontend/.env.example)).
- Key flags:
  - `KEYCLOAK_SIMULATION=true|false` (backend). When `true`, the backend accepts `Bearer super_admin`, `Bearer platform_admin`, `Bearer group_admin`, or `Bearer user` as the entire token. Enabled (`true`) by default for local dev.
  - `VITE_KEYCLOAK_SIMULATION=true|false` (frontend). When `true`, AuthContext skips Keycloak entirely and reads a mock role from `localStorage['hermes_mock_token']`. Enabled (`true`) by default for local dev.
  - `REDASH_SIMULATION=true|false` (backend). When `true`, `redash.service.ts` returns mock users/groups instead of hitting Redash. Enabled (`true`) by default for local dev.
  - `AWS_SIMULATION=true|false` (backend). When `true` — or whenever `AWS_IDENTITY_STORE_ID` is unset — `aws-identity-center.service.ts` uses an in-process mock store instead of real Identity Store calls, so the whole grant/revoke/expire flow is testable locally. Enabled (`true`) by default. Going live needs `AWS_SIMULATION=false` + `AWS_IDENTITY_STORE_ID` + a region (code, e.g. `us-east-1`) + credentials (ECS task role / IRSA in prod; never root).
- **The user runs in simulation mode for local dev** (`KEYCLOAK_SIMULATION=true`, `REDASH_SIMULATION=true`, `AWS_SIMULATION=true`, `VITE_KEYCLOAK_SIMULATION=true`).

### Commands (run from the directory shown)

```powershell
# Backend
cd backend
npm run dev                              # nodemon, port 8001
npm run build                            # tsc → dist/
npm run prisma:migrate                   # applies pending migrations to the local Postgres (DATABASE_URL_HERMES)
npm run prisma:seed                      # seeds the local Postgres database
npx prisma generate --schema=prisma/hermes/schema.prisma   # ⚠ always pass --schema flag
npx prisma validate --schema=prisma/hermes/schema.prisma
npx tsc --noEmit                         # typecheck only
npx ts-node scripts/reset-for-live-redash.ts                  # wipes mock transient state + maps live Redash IDs (groups & levels)

# Frontend
cd frontend
npm run dev                              # vite, port 5173
npm run build                            # tsc + vite build
npm run lint                             # eslint
npx tsc --noEmit                         # typecheck only
```

⚠ **The Prisma schema lives at `prisma/hermes/schema.prisma`, not the default `prisma/schema.prisma`.** Every prisma CLI call from outside the npm scripts must include `--schema=prisma/hermes/schema.prisma`. The npm scripts already do this.

---

## Architecture

### Backend (Express + Prisma)

- **`backend/src/app.ts`** is the entrypoint. Order on boot: load env → register event listeners → load AWS secrets → ensure Keycloak client/roles exist → start scheduler → run initial platform sync (`syncService.syncAllPlatforms()`, non-blocking) → `app.listen()`.
- **Routes** in `src/routes/<resource>.route.ts`. Pattern: `authenticateToken` middleware, optional `requireRole`, then `new Controller(req, res, next).method(req, res, next).catch(next)`.
- **Controllers** all extend `BaseController` (`src/controllers/base.controller.ts`). Use `this.sendResponse(data, msg)`, `this.handleError(err, msg)`, `this.validateWithZod(schema, data)`, `this.getUserId()`.
- **Services** in `src/services/`. Workflow logic lives in `access-workflow.service.ts`. Provisioning is abstracted behind `provisioner.interface.ts` + `provisioning.registry.ts`.
- **Event bus** (`src/services/event-bus.ts`) is an in-process EventEmitter. Subscribers in `event-listeners.ts`. Notifications + Slack come off this. (Will move to BullMQ — P3-2.)
- **Scheduler** (`src/services/scheduler.service.ts`) runs three cron jobs: **auto-expiry** of time-bound grants (hourly in prod, every 5 min in dev; revocations run concurrently via `Promise.allSettled`; a grant whose platform deprovision keeps failing is retried up to `MAX_EXPIRY_ATTEMPTS=3` times, then force-expired with an `ACCESS_EXPIRY_FAILED` audit + admin alert so it can't loop forever), a **periodic platform sync** (every 15 min in prod, every 5 min in dev) that calls `syncService.syncAllPlatforms()`, and an **admin reconciliation** (every 30 min in prod, every 10 min in dev) that calls `adminReconciliationService.reconcileAll()` to repair Keycloak↔mirror drift (no-op when Keycloak isn't live).

### Response shape (enforced)

Every success response from the backend is shaped:

```json
{ "success": true, "data": <T>, "message": "...", "metadata": { "timestamp": "..." } }
```

Every error response:

```json
{ "success": false, "error": "human message", "metadata": { "timestamp": "...", "errorCode": "VALIDATION_ERROR" } }
```

The frontend `apiClient` (`frontend/src/services/apiClient.ts`) **unwraps `data` automatically** in its response interceptor. So in pages you get `res.data` = the actual payload, not the envelope. Don't change this without updating both sides.

### Errors

Hierarchy in `backend/src/utils/errors.ts`:

- `BaseError` (abstract): has `statusCode`, `errorCode`, `context`, `isOperational`, `timestamp`.
- `ValidationError` (400, `VALIDATION_ERROR`)
- `AuthenticationError` (401, `AUTHENTICATION_ERROR`)
- `AuthorizationError` (403, `AUTHORIZATION_ERROR`)
- `NotFoundError` (404, `NOT_FOUND_ERROR`)
- `ConflictError` (409, `CONFLICT_ERROR`)
- `ExternalServiceError` (502, `EXTERNAL_SERVICE_ERROR`)
- `InternalServerError` (500, `INTERNAL_SERVER_ERROR`)

**Always throw a subclass of `BaseError`** — `errorHandler` middleware knows how to serialise these into the standard response shape. Raw `Error` works but loses the errorCode and status code mapping.

### Auth

- Live mode: `express-jwt` validates the Keycloak JWT (RS256, fetched via JWKS). `mapLiveKeycloakUser` populates `req.user`.
- Simulation mode: `checkJwtSimulated` reads the bearer string and maps to one of **four** hardcoded mock users — `super_admin`, `platform_admin`, `group_admin`, `user`.
- **`requireRole([...])`** middleware does coarse role-string checks. Finer tier checks live in `backend/src/utils/authz.ts` (below) — use those in controllers, not duplicated inline blocks.
- **Keycloak token refresh is wired** on the frontend (P0-1 fix in commit `36dbcad3`). `AuthContext` has `onTokenExpired` + 60s heartbeat, `apiClient` does proactive `updateToken(30)` + one-shot 401 retry.

#### Admin tiers (super → platform → group)

Three tiers, highest to lowest:

| Tier | Keycloak role | DB mirror | Scope |
|------|---------------|-----------|-------|
| Super admin | `hermes_super_admin` — assigned **manually in Keycloak** (the only role you set by hand) | — | everything, all platforms |
| Platform admin | `hermes_platform_admin_<platform>` (composite of `hermes_platform_admin`) | `platform_admins` table | all groups on one platform |
| Group admin | `hermes_group_admin_<platform>_<slug>` (composite of `hermes_group_admin`) | `group_admins` table | one group |

- **Keycloak is the source of truth** for roles (what lands in the JWT). The DB mirror tables exist so listings, notifications, and authorization work cheaply — and in simulation mode where Keycloak isn't running.
- **All assignments below super_admin go through Hermes** (the Admin Management UI → `/api/admin/*`), which calls `keycloak-admin.service.ts` to create the composite role + map it to the user, **and** writes the mirror row + an audit entry. Scoped roles are created on demand as composites of the blanket marker, so Keycloak expands them into `realm_access.roles` (the JWT carries both `hermes_group_admin` and `hermes_group_admin_<platform>_<slug>`).
- ⚠ A role change only reaches a user's JWT on their **next login / token refresh** — but the mirror row makes authorization work immediately. On **removal**, Hermes also force-logs-out the user's Keycloak sessions (`keycloakAdminService.logoutUser`) so the revoked role leaves their JWT right away instead of lingering until expiry.
- **Reconciliation**: a scheduler job (`adminReconciliationService.reconcileAll`, every 30 min prod / 10 min dev) repairs Keycloak↔mirror drift left by a partial failure — Keycloak → DB only, live-mode only (never wipes seeded sim rows), deletes only after a successful Keycloak read. Super admins can force it via `POST /api/admin/reconcile`.
- **Role naming is platform-qualified** (`hermes_group_admin_redash_growth`), matching the platform tier. Legacy slug-only roles (`hermes_group_admin_growth`) are still recognized for back-compat; `backend/scripts/migrate-group-admin-roles.ts` is the one-shot migrator. Platform keys are single lowercase tokens (no underscores), so `<platform>_<slug>` parses cleanly.
- **Authorization helpers** in `backend/src/utils/authz.ts` are the single home for the hierarchy: `isSuperAdmin`, `isPlatformAdminOf(user, platform)`, `isGroupAdminOf(user, groupId, slug?)` (a platform admin passes for any group on their platform), `getManageablePlatforms(user)`, `computeAdminScopes(user)`. Use these in controllers — don't re-derive admin status inline.
- **`/auth/me` returns `adminScopes: { superAdmin, platforms[], groups[] }`** (via `computeAdminScopes`). The frontend gates nav + the Admin Management page on this, not on raw role strings.
- **Group admins are NOT auto-enrolled** into the groups they administer. The group-admin role grants **approval rights only** (review / approve / reject requests for that group); it creates no membership and no platform grant. If an admin (group, platform, or super) needs actual data access they request it through the normal request → approval → duration flow like any other user — there is no self-request guard, and `accessStatus` in `group.controller` reflects their **real** grant state (the old cosmetic ACTIVE badge for admins is gone). An admin who holds a real grant appears in the members lists with an `isAdmin` badge (`listGroupMembers` returns the flag) and their grant is revocable like any member's. Because no membership is auto-created, **removing a group-admin role only removes approval rights** — any membership the admin requested separately stays until revoke/expiry.

The Admin Management surface is `backend/src/controllers/admin-management.controller.ts` (routes under `/api/admin` in `admin.route.ts`): super admins manage platform admins + group admins + members; platform admins manage group admins + members within their platform(s). All routes are `authenticateToken` only — fine-grained tier checks happen in the controller via the `authz.ts` helpers (the tiers don't map onto a single blanket role). Frontend: `frontend/src/pages/AdminManagement.tsx` + `frontend/src/services/api/admin.ts`.

**User access tool (cross-platform audit + bulk revoke).** `GET /api/admin/user-access?userId=` lists every active grant a given user holds (group, platform, level, granted/expires) and `POST /api/admin/user-access/revoke` revokes some (`userAccessIds`) or all of them in one call — the "check what someone has access to" tool, surfaced as the **"User access"** button on `AdminManagement.tsx`'s header (`UserAccessModal.tsx`). Both endpoints scope by `getManageablePlatforms`: a super admin sees/revokes everything, a platform admin only their platform(s) — grants outside scope are simply excluded, never trusted from the client. The revoke loop calls `accessWorkflowService.revokeAccess` **sequentially per grant** (not `Promise.allSettled`) because ZooKeeper's "retain other paths" logic (`deprovisionWithRetain`) reads the user's still-active grants at call time — concurrent revocation would race that snapshot. Partial failure is reported back (`{ revoked: [...], failed: [...] }`), and one `ACCESS_BULK_REVOKED` audit row is written alongside the normal per-grant `ACCESS_REVOKED` rows.

**Offboarding (disable/delete the platform ACCOUNT itself, not just membership).** Revoking a `UserAccess` grant removes data access but leaves the person's account on the platform intact (they could still sign in to Redash, or exist as an AWS Identity Center user with no permissions). The same "User access" modal has a second, separate section for this: `GET /api/admin/user-platform-accounts?userId=` lists every platform account the user holds (from `UserCreationRequest` rows in `APPROVED`/`AWAITING_SETUP`/`COMPLETED` status — i.e. an account exists or is being created) and `POST /api/admin/user-access/disable-accounts` disables/deletes some (`platforms`) or all of them. This is a new optional hook on `PlatformAdapter`: `disableUser(externalUserId)` plus a `disableUserIsReversible` flag the adapter declares (never inferred from the platform string). **The two adapters differ a lot here — this was a deliberate product decision, not a technical default:**
- **Redash** (`redash.service.ts` `disableUser` / `redash.provisioner.ts`): a real, **reversible** soft-disable via `DELETE /api/users/:id` (`is_disabled=true`; an admin can flip it back in Redash's own admin panel). `disableUserIsReversible = true`.
- **AWS Identity Center** (`aws-identity-center.service.ts` `deleteUser` / `aws.provisioner.ts`): Identity Store has **no disabled flag at all** — the only account-level action is a **permanent** `DeleteUserCommand` (clears group memberships first, then deletes). Irreversible: recreating the person later makes a brand-new user with a new id, losing continuity. `disableUserIsReversible` is omitted (defaults to false/irreversible). This was an explicit choice (asked and confirmed) over the safer alternative of leaving AWS accounts untouched and requiring manual console cleanup — know this before touching `disableUser` on either adapter.
- **ZooKeeper** has no user-account concept at all (no minted credentials — see the ZooKeeper section below) and doesn't implement `disableUser`; offboarding there is fully achieved by the access-grant revoke alone. The endpoint reports platforms with no `disableUser` support back as `unsupported`, not a failure.

Both endpoints use the same scoping/audit pattern as the revoke tool (`getManageablePlatforms`, sequential per-account calls, partial-success reporting, one `ACCOUNTS_BULK_DISABLED` summary row alongside per-account `PLATFORM_ACCOUNT_DISABLED` rows). No schema migration was needed: "already disabled" is read from the existing `PlatformExternalUser.isDisabled` cache column (Redash) or account absence (AWS deletes the cache row too) — `UserCreationRequest.status` is untouched by offboarding.

⚠ **Disabling the account does NOT touch access grants — that's a deliberate, but sharp, split.** `listUserPlatformAccounts` returns `activeGrantCount` per platform so the UI can warn before acting, and the two actions behave differently by necessity:
- **Redash (reversible disable)**: grants are left alone on purpose. Redash keeps the user's group membership even while disabled, so re-enabling the account later (in Redash's own admin panel) instantly restores whatever access Hermes still shows as active — that's correct, not a bug, but the UI should make it visible.
- **AWS (permanent delete)**: `disableUserAccounts` **auto-revokes every active grant on that platform** right after a successful delete (see `accessWorkflowService.revokeAccess` calls inside the `!reversible` branch), because there's no valid state where a `UserAccess` row can keep pointing at a `externalUserId` that no longer exists. This isn't just cosmetic — without it, `access-workflow.service.ts`'s `createRequest` "you already have active access to this group" guard (line ~90) checks only `isActive`, not whether the platform account behind it still exists, so a stale grant would **silently block re-onboarding the same person to the same group** if they're ever re-hired. `disabled[].grantsRevoked` in the response (and `autoRevokedGrantCount` in the `ACCOUNTS_BULK_DISABLED` audit) surfaces exactly what got swept up.

### Provisioning (key extension point)

To support a new platform (AWS, Jira), implement `PlatformAdapter` (`backend/src/services/provisioner.interface.ts`):

```ts
interface PlatformAdapter {
  readonly platform: string;
  provision(ctx): Promise<ProvisionResult>;
  deprovision(ctx): Promise<void>;
  checkUserStatus(email): Promise<PlatformUserStatus>;
  inviteUser(email, name): Promise<ProvisionResult>;
  syncUsers?(): Promise<{ count: number }>;   // optional: refresh cached users
  syncGroups?(): Promise<{ count: number }>;   // optional: refresh cached groups
  createExternalGroup?(name): Promise<{ externalGroupId, name? }>;  // optional: back a group level
  deleteExternalGroup?(externalGroupId): Promise<void>;            // optional: rollback/cleanup
  reconcileMembers?(ctx): Promise<ReconcileMembersResult>;          // optional: re-sync existing members when an editable externalGroupId changes (ZooKeeper)
  getOnboardingMessage?(): OnboardingMessage;  // optional: platform-specific "account ready" copy (notification + email + DM)
  healthCheck(): Promise<{ healthy, message? }>;
}
```

Then register in `provisioning.registry.ts` constructor (one line — `this.register('aws', awsProvisioner)`). The workflow service resolves the adapter via `provisioningRegistry.get(group.platform)`; **`Group.platform` is required (no DB default)** — `access-workflow.service.ts` throws a `ValidationError` if it's ever null. `SyncService` is a thin orchestrator that loops every registered platform and calls the adapter's own `syncUsers()` / `syncGroups()`; the actual Redash sync logic lives in `redash.provisioner.ts`, not in `SyncService`.

Cached platform state lives in **generic, platform-keyed tables** `platform_external_users` / `platform_external_groups` (each row carries a `platform` column, e.g. `'redash'`). The old Redash-specific `redash_users` / `redash_groups` tables were dropped (P3-1, done). A new adapter reuses these tables with its own `platform` value — **do not** add per-platform cache tables.

**Hermes-group reconciliation (live mode only).** After each platform's cache sync, `syncService.reconcileHermesGroups` mirrors the platform's real group list into the `groups` table. **Healing first**: a Hermes group/level whose stored `externalGroupId` no longer exists on the platform is re-linked **by name** (groups by their own name; levels by the `"<Group> — <Level>"` convention, dash/case-insensitive — same matching as `scripts/reset-for-live-aws.ts`) and reactivated, covering the deleted-and-recreated-with-a-new-id case; a pristine duplicate group a previous sync auto-created from a level's backing group is deleted when the level reclaims it (admin-created groups are never deleted). Then: platform groups Hermes doesn't know are auto-created (audited `GROUP_CREATED` by "Platform Sync") — except a name parsing as `"<existing group> — <level>"`, which is created as a **level** of that group instead of a standalone group (and a stray standalone group a previous sync made from such a name is folded back into its parent as a level while still pristine), active Hermes groups/levels whose backing platform group truly vanished are archived / soft-deactivated (never hard-deleted; a leveled group stays visible while any level is live-backed), and **reserved** platform groups are never surfaced — optional adapter hooks `isReservedExternalGroup()` (AWS hides `API-TESTING`, Redash hides its built-in `default`/`admin` groups) and `isSimulation()` (reconciliation is skipped in simulation so dev seed data is never reshuffled). Only a *broken* link being healed reactivates anything (an admin's deliberate archive of a still-live group sticks), it never touches the platform itself, skips on an empty cache, and honors the same 10-min eventual-consistency grace window as cache pruning. Tests: `sync.service.test.ts`.

The admin model keys off the **same** `platform` string (see Auth → Admin tiers). Onboarding a platform is therefore: register the adapter → create `Group` rows with that `platform` → assign a platform admin via the Admin Management UI. No schema migration, no Keycloak role config (scoped roles are created on demand), and the admin-management layer needs no changes — `getManageablePlatforms` reads the registry, so the new platform appears automatically.

**Live adapters today: `redash`, `redash-qa` + `aws`.** Redash is `redash.provisioner.ts` (over `redash.service.ts`); AWS IAM Identity Center is `aws.provisioner.ts` (over `aws-identity-center.service.ts`, which owns every Identity Store SDK call plus the in-process simulation store + the eventual-consistency retry helpers). `GET /api/platforms` (`platform.controller.ts`) returns the registered platform keys, and the frontend derives each platform card's ACTIVE vs COMING_SOON from that — so `frontend/src/lib/platforms.ts` holds **presentation metadata only**; registering an adapter flips its card to ACTIVE with no frontend change. **Onboarding copy is adapter-owned** via `getOnboardingMessage()` (in-app notification + email + DM); `notificationService.notifyUserCreationCompleted` asks the adapter and falls back to generic copy, so it never branches on the platform string.

**Multi-instance platforms (Redash prod + QA).** `RedashProvisioner`/`RedashService` are constructed per-instance rather than as singletons, keyed by platform (`redash` vs `redash-qa`), and registered under a shared `family: 'redash'` so the frontend collapses both into one platform card with an instance chooser instead of two cards. An unconfigured second instance (no `REDASH_QA_BASE_URL`) is simply skipped at registry construction — no dead adapter, no frontend change, until it's actually configured. Invite links normalize against the issuing instance's own base URL (not always prod). A generic `isEnabled()` adapter hook replaces the old hardcoded `platform === 'aws'` checks in sync/reconcile/authz — the pattern to follow for any future adapter that needs a runtime on/off switch.

**ZooKeeper — no-ACL model (Hermes is a scoped, audited front door).** ZooKeeper has no native group object (a znode is just a *path*), so a "ZK group" is a Hermes abstraction: its `externalGroupId` is a **newline-separated list of `path#perms` entries** (a single line = the original one-path form). **Access is NOT enforced on the ensemble — it is enforced inside Hermes.** A grant is just an active `UserAccess` row; `zookeeper.provisioner.ts` `provision`/`deprovision` only mirror the user's granted paths into their `platform_external_users` cache row and write **no per-node ACLs**. The enforcement point is `zookeeper-config.service.ts`, which connects to ZK as a single client, reads/writes znodes, and **filters every browse/export/change against the caller's granted paths server-side** (`#r` vs `#cdrw` → `canWrite`). So the ZK side is left **world-open** (backing znodes are created world-open via `createNodeRecursive`) and any other client — **zkui, ZooNavigator, a service, zkCli — can read/write it directly, unscoped**. This is a deliberate trade for a *trusted internal team*: Hermes gives a scoped view + an audit trail + the request→approve workflow, but is not a hard security boundary (anyone who can reach the ensemble has full access). If you need a real per-user boundary, ZK must be network-restricted to Hermes only, or per-node ACLs reinstated.
- **Hybrid backend (DB vs live ZK), split by path prefix.** `zookeeper.service.ts` routes by `isDbBacked(path) = isAtOrUnder(path, config.zookeeper.rootPath)`. Znodes **at/under the Hermes root** (`rootPath`, default `/hermes`) live in **Postgres** (`zookeeper_nodes`, model `ZookeeperNode` — `path` PK, nullable `value`, tree implicit in the path string); **every other path** (e.g. `/bachatt`) stays on the **live ensemble**. This lets Hermes own its config namespace in the DB while other tools (zkui) own the real ZK, with no collision. Every CRUD primitive (`exists`/`getData`/`setData`/`getChildren`/`ensureNode`/`createNodeRecursive`/`deleteNode`/`descendantPaths`) checks `isDbBacked` first and falls through to the sim/live ZK branch otherwise; the DB helpers mirror ZK semantics exactly (NO_NODE→null, setData-needs-existing-node, NOT_EMPTY refusal, `_`/`%` LIKE-wildcard safety via an exact JS prefix re-filter) so `zookeeper-config.service.ts` can't tell which backend a path lives on. `getAcl`→`[]` and `addAclEntry`/`removeAclEntry`→no-op for DB paths. The `{ forceZk: true }` opt on `exists`/`getData`/`getChildren`/`deleteNode` bypasses routing to hit the real ensemble — used only by the cutover script. **Cutover:** `scripts/migrate-hermes-to-db.ts` copies the live `rootPath` subtree into Postgres (`--apply`, idempotent), with the destructive `--delete-zk` removal of the old subtree gated behind a separate flag. Because Postgres is always available and only ZK is simulated, DB routing is **not** gated on sim mode — the test suite (sim) exercises the DB store as a conformance spec (`zookeeper-config.test.ts` + `zookeeper-db-routing.test.ts`; setup truncates `zookeeper_nodes`).
- **No minted credentials.** `inviteUser` seeds a cache row but mints no ZK digest password; `externalUserId` is a stable per-user id (the email, or a `__zk_uid:<userId>` sentinel for the blank-email Keycloak JWTs), not a digest ACL id. `getOnboardingMessage` is a generic "access is set up" message.
- **Editable path list** is unchanged: `reconcileMembers(ctx)` (in `provisioner.interface.ts`) still diffs old vs new paths and reports added/removed/updated (for the **`GROUP_PATHS_RECONCILED`** audit) — it just refreshes each member's cache instead of rewriting ACLs. **Implementing the hook is what opts an adapter's `externalGroupId` into being editable** — `updateGroup` rejects the edit for platforms without it (Redash/AWS stay immutable). UI: editable paths textarea in the group drawer's Settings tab (`GroupSettingsTab.tsx`) + Levels tab form (`GroupLevelsTab.tsx`).
- The low-level ACL primitives still present in `zookeeper.service.ts` (`addAclEntry`/`removeAclEntry`/`getAcl`/`mutateAcl`/`mintCredential`/admin-digest auth) are **retained but unused by the provisioner** — safe to delete in a follow-up. They (and the world-open `setWorldOpenAcl` ACL-migration in `zookeeper-migration.service.ts`, which now skips DB-backed roots) only matter for the **live-ZK side**. The `ZookeeperService — versioned ACL writes (live)` test block still covers them (using a `/bachatt` path so it routes to ZK). Tests: `zookeeper.provisioner.test.ts`.

**Per-platform account creation.** Before a user can be provisioned on a platform they need an account there, gated by a `UserCreationRequest` that is **unique per `(user, platform)`** (and `externalUserId` is a `String` — Redash int-as-string, AWS Identity Store GUID). The approval gate in `accessWorkflowService.reviewRequest` is per-platform — being approved on Redash does **not** imply approval on AWS. **Who can approve account creation is also per-platform:** `GET /api/user-creation-requests/pending` and `PUT /:id/review` are `authenticateToken` only, with the tier check in `user-creation.controller` — super admins see/approve every platform, a **platform admin** sees/approves only their platform's account requests (`listPending(platforms)` filters by `getManageablePlatforms`; `review` gates on `isPlatformAdminOf(row.platform)`), and group admins have no account-approval rights. The frontend renders the User Approvals table when `adminScopes.superAdmin || adminScopes.platforms.length > 0`. `userCreationService.approveRequest` routes account creation through the adapter's `inviteUser` (extracted into `_executeInvite`, reused by `resendInvite` so a failed non-Redash invite is retryable): a platform that returns a setup link (Redash) → `AWAITING_SETUP`, one that creates a ready account (AWS) → `COMPLETED` immediately. `cascadeRejectForUser(userId, note, platform?)` and `provisionWaitingRequests(userId, platform?)` are both **platform-scoped** — rejecting or releasing one platform's requests never touches another's. `submitRequest` rejects platforms not in the registry.

#### Group CRUD

Groups are created/edited/archived from the **Admin Management UI** (super-admin or platform-admin of the group's platform) — `admin-management.controller.ts` handlers `createGroup` / `updateGroup` / `deleteGroup` under `/api/admin/groups`, surfaced via a **"New group" button + per-group detail drawer (Settings tab)** on `AdminManagement.tsx`. Create resolves the backing platform group the same way level CRUD does (paste an `externalGroupId`, or blank ⇒ `adapter.createExternalGroup`, with rollback on insert failure). **Edits are restricted to `name` / `description` / `icon` / `color` / `tables` / `isActive`** — `slug`, `platform`, and the base `externalGroupId` are **immutable after creation** (changing slug/platform would break group-admin role names + reroute the adapter). **Delete is pristine-only**: a group ever referenced by an access request or user access (FK `Restrict`) is **archived** (`isActive:false`, hidden from the request flow) instead of hard-deleted; only a never-used group is removed (its levels/admins cascade, backing external group best-effort deleted). The seeding scripts (`scripts/create-6-aws-groups.ts`, etc.) remain valid for bulk setup; the UI is the interactive path.

#### Group levels (subgroups)

A `Group` can carry **levels** (`GroupLevel`, table `group_levels`) — e.g. Credit Card → Intern / Junior Dev / Senior Dev — each with a different permission tier. **Each level is backed by its own external group** (its own `externalGroupId`); in Redash, read-only vs write is configured on that level's group's data sources, so Hermes just routes the requester to the right group. The model is platform-agnostic — it works for any adapter.

- **Non-breaking:** a group with **zero active levels** behaves exactly as before (request the group directly, provision to `Group.externalGroupId`). A group **with** levels requires a `levelId` on the request, and that level must have its own `externalGroupId`. Resolution: a level-less grant falls back to `group.externalGroupId` (provision/revoke/expire), but a **leveled** request uses the level's own external group and Hermes **refuses to fall back to the base group** when the level has none — guarded in both `createRequest` (early 400) and `_provision` (hard stop) so it can't silently over-provision into the broader base group.
- `AccessRequest.levelId` / `UserAccess.levelId` are nullable (null = legacy/level-less grant). One active grant per `(user, group)` still holds — the partial unique index is **not** keyed on `levelId`, so a user holds one level per group at a time.
- **Requiredness** ("group has active levels ⇒ levelId required") is enforced in `accessWorkflowService.createRequest`, not the Zod schema (it's DB-state dependent).
- **Level CRUD** is super-admin / platform-admin only (mapping `externalGroupId` is platform config) — `admin-management.controller.ts` handlers under `/api/admin/groups/:groupId/levels`, surfaced in the group detail drawer's **Levels tab** on `AdminManagement.tsx`. Group admins still review requests for **any** level with no new role. Deleting a level with active members **soft-deactivates** it (members keep access until expiry/revoke).
- ⚠ Adding levels to a group does **not** auto-migrate existing members — legacy `levelId=null` grants keep working on the group's base `externalGroupId`; only new requesters pick a level.
- **Changing a member's level (admin-only):** self-service promotion/demotion was **removed** (too much complexity for little value — it lived in `accessWorkflowService.changeLevel` + `POST /api/access-requests/change-level` + a `ChangeLevelModal`; see git history if you ever need it back). A user holds **exactly one level per group**; to move them, an admin sets the level directly from the group detail drawer's **Members tab** (`PUT /api/admin/groups/:groupId/members/:userAccessId/level` → `accessWorkflowService.adminSetMemberLevel`), applied immediately: the grant is swapped in `_provision` (which detects an existing active grant and calls `accessWorkflowService._swapGrant`: atomic deactivate-old + create-new, then a best-effort deprovision of the old level's external group, audited `ACCESS_LEVEL_CHANGED`), carrying the grant's duration over from its originating request. Otherwise a user revokes + re-requests for a different level. First-time access goes through `POST /api/access-requests`, which blocks when the user already has active access to the group. The Admin Management members list shows each member's current level (`listGroupMembers` returns `levelId`/`levelName`).
- **Renewing / extending access:** a member whose grant is about to expire can request an extension via `POST /api/access-requests/renew` → `accessWorkflowService.requestRenewal` (UI: the *Extend* button on the Dashboard's expiring grants + an *Extend Access* button on the group detail page → `RenewAccessModal`). A renewal keeps the user's **current level** (resolved server-side from the active grant) and goes through the **normal admin-approval flow** — deliberately *not* self-service, since letting a user recompute their own expiry window would be a silent self-extension. It reuses the one-open-request-per-group guard. On approval, `_provision` sees an active grant created by a **different** request and routes to `_swapGrant` (the existing-grant branch now keys on `existingGrant.accessRequestId !== request.id`, not on level difference); for a same-level renewal `_swapGrant` deactivates the old grant + creates a fresh one with the new `expiresAt`, **skips the platform deprovision** (identical external group, so membership is never interrupted), and audits **`ACCESS_RENEWED`** instead of `ACCESS_LEVEL_CHANGED`.

### Frontend

- React 19, Vite 6, React Router 7.
- **Data fetching is TanStack Query** (P1-5, done) — pages use `useQuery` / `useMutation` with centralised keys in `frontend/src/lib/queryKeys.ts`; mutations `invalidateQueries`. Don't reintroduce raw `apiClient.get` in `useEffect`.
- `AuthContext` wraps the app; `useAuth()` returns `{ user, isAuthenticated, isLoading, isSimulated, login, logout, switchSimulatedRole, refreshUserCreation }`. `user.adminScopes` carries the resolved admin tiers; `switchSimulatedRole` accepts `super_admin | platform_admin | group_admin | user`.
- `NotificationContext` polls `/api/notifications` every 60s. SSE replacement is P2-6.
- `apiClient` is the only HTTP client. It owns the response unwrap + 401 retry. Don't `import axios` directly in components.

---

## Conventions (please follow when adding code)

- **Validation** at the controller boundary using Zod schemas in `backend/src/validations/`. Call via `this.validateWithZod(schema, input, 'msg')`. Don't validate inside services.
- **Errors**: throw `BaseError` subclasses. Don't `res.status(...).json(...)` directly in controllers — go through `BaseController` helpers.
- **Logging**: `import logger from '../utils/logger'` (pino). Don't `console.log` in backend.
- **Config access**: import `config from '../config/config'`. **Don't read `process.env.NODE_ENV` directly** — use `config.isDev`, `config.isProd`. (All known violations are fixed; `config.ts` itself is the only place that reads `process.env.NODE_ENV`.)
- **Audit logs**: every state-changing action should write a row to `audit_entries` via `prisma.auditEntry.create({...})`. Patterns: `REQUEST_CREATED`, `REQUEST_REJECTED`, `ACCESS_GRANTED`, `ACCESS_REVOKED`, `ACCESS_EXPIRED`, `ACCESS_EXPIRY_FAILED`, `ACCESS_LEVEL_CHANGED`, `ACCESS_RENEWED`, `ACCESS_BULK_REVOKED`, `PLATFORM_ACCOUNT_DISABLED`, `ACCOUNTS_BULK_DISABLED`, `PROVISION_FAILED`, `MANUAL_SYNC_TRIGGERED`, `PLATFORM_ADMIN_ASSIGNED`, `PLATFORM_ADMIN_REVOKED`, `GROUP_ADMIN_ASSIGNED`, `GROUP_ADMIN_REVOKED`, `ADMIN_RECONCILE_TRIGGERED`, `GROUP_CREATED`, `GROUP_UPDATED`, `GROUP_ARCHIVED`, `GROUP_DELETED`, `GROUP_LEVEL_CREATED`, `GROUP_LEVEL_UPDATED`, `GROUP_LEVEL_DELETED`, `GROUP_LEVEL_DEACTIVATED`, `GROUP_PATHS_RECONCILED`, `REDASH_RESYNC_TRIGGERED`, `REDASH_QA_RESYNC_TRIGGERED`, `USER_CREATION_*`. (`action` is a free string — no enum.)
- **Events**: after a state change, also emit on `eventBus` (`backend/src/services/event-bus.ts`) so notifications/Slack fire async.
- **Frontend types**: each page redeclares its data shape as an `interface`. Until P3-5 (OpenAPI codegen), this is the convention — match the backend response shape exactly.
- **CSS**: there's a `frontend/src/styles/global.css` with CSS variables (`--primary`, `--text-muted`, `--radius-md`, `--shadow-md`, etc.). Use them. Inline styles are heavily used today but should be migrating out (smaller-wins list in ROADMAP.md).

---

## Don'ts

- ❌ Don't add `--name <x>` to `prisma:migrate` in package.json — that's what caused the duplicate `_init` migration folders before P0-4.
- ❌ Don't create Redash-specific (or any per-platform) cache tables. Reuse the generic `platform_external_users` / `platform_external_groups` tables with a new `platform` value (P3-1 landed this pattern).
- ❌ Don't swallow errors in controllers (`try { ... } catch {}` with no log). Always `this.handleError(err, 'message')`.
- ❌ Don't bypass `apiClient` on the frontend (axios directly). It owns auth + retry + unwrap.
- ❌ Don't push to `origin/main` with force unless the user explicitly asks.
- ❌ Don't create `feature/...` or `fix/...` branches. Direct commits on `main`.
- ❌ Don't create new `.md` documentation files unless the user asks for them. Update `ROADMAP.md` or this file when relevant.

---

## Verification commands (run after non-trivial changes)

```powershell
# Always (typecheck)
cd "D:\Bachatt\Hermes 2\backend"; npx tsc --noEmit
cd "D:\Bachatt\Hermes 2\frontend"; npx tsc --noEmit

# Run all tests (requires Docker/Postgres running for Testcontainers)
npm test

# Run backend tests only
cd "D:\Bachatt\Hermes 2\backend"; npm run test:run

# Run frontend tests only
cd "D:\Bachatt\Hermes 2\frontend"; npm run test:run

# If you changed Prisma schema
cd "D:\Bachatt\Hermes 2\backend"; npx prisma validate --schema=prisma/hermes/schema.prisma

# If you changed frontend
cd "D:\Bachatt\Hermes 2\frontend"; npm run lint

# If you changed backend (lint exists as of P2-3)
cd "D:\Bachatt\Hermes 2\backend"; npm run lint

# Frontend + backend lint exist. Tests exist (P2-1). CI runs all of these on push/PR to main (P2-4).
```

Tell the user what passed/failed before reporting "done."

---

## Current state checklist

- ✅ Token refresh works (P0-1, commit 36dbcad3)
- ✅ Schema and migrations are in sync (P0-2, P0-3, commit 36dbcad3)
- ✅ Error response shape is uniform (P0-5, commit 36dbcad3)
- ✅ Platform provisioning is fully adapter-based; generic cache tables `platform_external_users` / `platform_external_groups` (P3-1, done)
- ✅ Periodic platform sync runs on the scheduler (every 15 min prod / 5 min dev) — no longer boot-only
- ✅ Backend `Dockerfile` + `.dockerignore` exist (multi-stage; entrypoint runs `prisma migrate deploy` then `node dist/app.js`)
- ✅ Admin authorization consolidated in `backend/src/utils/authz.ts` (P1-1, done) — no more duplicated inline checks
- ✅ Frontend on TanStack Query (P1-5, done) — no raw fetch in `useEffect`
- ✅ `.env.example` files exist for backend + frontend (P1-4, done)
- ✅ Three-tier admin model (super → platform → group) + Admin Management UI; Keycloak-authoritative roles with `platform_admins` / `group_admins` DB mirror
- ✅ Group levels / subgroups (`group_levels`) — each level backed by its own external group; non-breaking (level-less groups unchanged); CRUD is super/platform-admin only (see Provisioning → Group levels)
- ✅ **AWS IAM Identity Center adapter live** (`aws.provisioner.ts` + `aws-identity-center.service.ts`); `AWS_SIMULATION` mock by default, real Identity Store when configured
- ✅ **Redash multi-instance (prod + QA)** — per-instance provisioners keyed by platform (`redash` / `redash-qa`), `family: 'redash'` groups them into one platform card with an instance chooser; `isEnabled()` adapter hook; QA instance is a safe no-op until `REDASH_QA_*` env vars are set
- ✅ Per-platform account creation — `UserCreationRequest` unique per `(user, platform)`, `externalUserId` is `String`; the user-creation gate, `cascadeRejectForUser`, and `provisionWaitingRequests` are all platform-scoped; failed non-Redash invites are retryable
- ✅ Onboarding copy is adapter-owned (`getOnboardingMessage()`); platform notification copy is platform-aware (no hardcoded "Redash")
- ✅ Platform ACTIVE/COMING_SOON derived from the registry via `GET /api/platforms` — `frontend/src/lib/platforms.ts` is presentation-only
- ✅ Frontend ESLint wired (`cd frontend; npm run lint`)
- ✅ Vitest test suite implemented (P2-1)
- ✅ Backend ESLint (flat config `backend/eslint.config.mjs`) + Prettier (P2-3) — `cd backend; npm run lint` / `npm run format`; type-aware `@typescript-eslint/no-floating-promises` is on
- ✅ CI on push/PR to `main` (P2-4) — `.github/workflows/ci.yml`: typecheck + lint + prisma-validate + tests for both projects, Node 22, per-project npm cache
- ✅ Bulk endpoints (P2-2) — `POST /api/access-requests/bulk` + `PUT /api/access-requests/bulk/review`: one HTTP call instead of N. Create is one transaction + partial-success results + one consolidated `requests.bulk.created` notification; review reuses the per-item path (each requester still notified) and returns per-item `reviewed`/`failed`.
- ✅ Audit log filtering (P2-5) — `auditQuerySchema`/controller accept `performerId`, `fromDate`, `toDate`, `groupId`, `platform` (platform → group ids, since `AuditEntry` has no platform column); AuditLog UI has date range + platform + group selectors.
- ✅ Notifications over SSE (P2-6) — `GET /api/notifications/stream`; `createNotification` emits a scoped `notification.created`, `notification-stream.service` fans out per user (one bus listener). Replaces the 60s poll. EventSource auths via `?token=`. In-process today; swap to the queue when P3-2 lands.
- ⚠ Test files are excluded from the production `tsconfig` of **both** projects (Vitest owns them via esbuild). `tsc --noEmit` / `npm run build` no longer type-check `*.test.*`; this fixed pre-existing build breakage. Backend ESLint also ignores test files.

When the user asks "what's next?" — open `ROADMAP.md` and suggest the next P1 item that fits the time they have.

---

## When in doubt

Ask. The user prefers a quick clarifying question over you going down the wrong path for 30 minutes. Especially before:
- changing the response shape or auth model
- touching migrations
- adding any new top-level dependency
- doing anything visible on `origin/main`

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
