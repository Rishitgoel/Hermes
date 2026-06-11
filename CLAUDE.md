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
- Co-author trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Recent example to match: commit `36dbcad3` (the P0 fixes).

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
  getOnboardingMessage?(): OnboardingMessage;  // optional: platform-specific "account ready" copy (notification + email + DM)
  healthCheck(): Promise<{ healthy, message? }>;
}
```

Then register in `provisioning.registry.ts` constructor (one line — `this.register('aws', awsProvisioner)`). The workflow service resolves the adapter via `provisioningRegistry.get(group.platform)`; **`Group.platform` is required (no DB default)** — `access-workflow.service.ts` throws a `ValidationError` if it's ever null. `SyncService` is a thin orchestrator that loops every registered platform and calls the adapter's own `syncUsers()` / `syncGroups()`; the actual Redash sync logic lives in `redash.provisioner.ts`, not in `SyncService`.

Cached platform state lives in **generic, platform-keyed tables** `platform_external_users` / `platform_external_groups` (each row carries a `platform` column, e.g. `'redash'`). The old Redash-specific `redash_users` / `redash_groups` tables were dropped (P3-1, done). A new adapter reuses these tables with its own `platform` value — **do not** add per-platform cache tables.

**Hermes-group reconciliation (live mode only).** After each platform's cache sync, `syncService.reconcileHermesGroups` mirrors the platform's real group list into the `groups` table: platform groups Hermes doesn't know are auto-created (audited `GROUP_CREATED` by "Platform Sync"), active Hermes groups/levels whose backing platform group vanished are archived / soft-deactivated (never hard-deleted), and **reserved** platform groups are never surfaced — optional adapter hooks `isReservedExternalGroup()` (AWS hides `API-TESTING`, Redash hides its built-in `default`/`admin` groups) and `isSimulation()` (reconciliation is skipped in simulation so dev seed data is never reshuffled). It never auto-reactivates an archived group (admin intent wins — reactivate from Admin Management), never touches the platform itself, skips on an empty cache, and honors the same 10-min eventual-consistency grace window as cache pruning. Tests: `sync.service.test.ts`.

The admin model keys off the **same** `platform` string (see Auth → Admin tiers). Onboarding a platform is therefore: register the adapter → create `Group` rows with that `platform` → assign a platform admin via the Admin Management UI. No schema migration, no Keycloak role config (scoped roles are created on demand), and the admin-management layer needs no changes — `getManageablePlatforms` reads the registry, so the new platform appears automatically.

**Live adapters today: `redash` + `aws`.** Redash is `redash.provisioner.ts` (over `redash.service.ts`); AWS IAM Identity Center is `aws.provisioner.ts` (over `aws-identity-center.service.ts`, which owns every Identity Store SDK call plus the in-process simulation store + the eventual-consistency retry helpers). `GET /api/platforms` (`platform.controller.ts`) returns the registered platform keys, and the frontend derives each platform card's ACTIVE vs COMING_SOON from that — so `frontend/src/lib/platforms.ts` holds **presentation metadata only**; registering an adapter flips its card to ACTIVE with no frontend change. **Onboarding copy is adapter-owned** via `getOnboardingMessage()` (in-app notification + email + DM); `notificationService.notifyUserCreationCompleted` asks the adapter and falls back to generic copy, so it never branches on the platform string.

**Per-platform account creation.** Before a user can be provisioned on a platform they need an account there, gated by a `UserCreationRequest` that is **unique per `(user, platform)`** (and `externalUserId` is a `String` — Redash int-as-string, AWS Identity Store GUID). The approval gate in `accessWorkflowService.reviewRequest` is per-platform — being approved on Redash does **not** imply approval on AWS. `userCreationService.approveRequest` routes account creation through the adapter's `inviteUser` (extracted into `_executeInvite`, reused by `resendInvite` so a failed non-Redash invite is retryable): a platform that returns a setup link (Redash) → `AWAITING_SETUP`, one that creates a ready account (AWS) → `COMPLETED` immediately. `cascadeRejectForUser(userId, note, platform?)` and `provisionWaitingRequests(userId, platform?)` are both **platform-scoped** — rejecting or releasing one platform's requests never touches another's. `submitRequest` rejects platforms not in the registry.

#### Group CRUD

Groups are created/edited/archived from the **Admin Management UI** (super-admin or platform-admin of the group's platform) — `admin-management.controller.ts` handlers `createGroup` / `updateGroup` / `deleteGroup` under `/api/admin/groups`, surfaced via a **"New group" button + per-group detail drawer (Settings tab)** on `AdminManagement.tsx`. Create resolves the backing platform group the same way level CRUD does (paste an `externalGroupId`, or blank ⇒ `adapter.createExternalGroup`, with rollback on insert failure). **Edits are restricted to `name` / `description` / `icon` / `color` / `tables` / `isActive`** — `slug`, `platform`, and the base `externalGroupId` are **immutable after creation** (changing slug/platform would break group-admin role names + reroute the adapter). **Delete is pristine-only**: a group ever referenced by an access request or user access (FK `Restrict`) is **archived** (`isActive:false`, hidden from the request flow) instead of hard-deleted; only a never-used group is removed (its levels/admins cascade, backing external group best-effort deleted). The seeding scripts (`scripts/create-6-aws-groups.ts`, etc.) remain valid for bulk setup; the UI is the interactive path.

#### Group levels (subgroups)

A `Group` can carry **levels** (`GroupLevel`, table `group_levels`) — e.g. Credit Card → Intern / Junior Dev / Senior Dev — each with a different permission tier. **Each level is backed by its own external group** (its own `externalGroupId`); in Redash, read-only vs write is configured on that level's group's data sources, so Hermes just routes the requester to the right group. The model is platform-agnostic — it works for any adapter.

- **Non-breaking:** a group with **zero active levels** behaves exactly as before (request the group directly, provision to `Group.externalGroupId`). A group **with** levels requires a `levelId` on the request, and that level must have its own `externalGroupId`. Resolution: a level-less grant falls back to `group.externalGroupId` (provision/revoke/expire), but a **leveled** request uses the level's own external group and Hermes **refuses to fall back to the base group** when the level has none — guarded in both `createRequest` (early 400) and `_provision` (hard stop) so it can't silently over-provision into the broader base group.
- `AccessRequest.levelId` / `UserAccess.levelId` are nullable (null = legacy/level-less grant). One active grant per `(user, group)` still holds — the partial unique index is **not** keyed on `levelId`, so a user holds one level per group at a time.
- **Requiredness** ("group has active levels ⇒ levelId required") is enforced in `accessWorkflowService.createRequest`, not the Zod schema (it's DB-state dependent).
- **Level CRUD** is super-admin / platform-admin only (mapping `externalGroupId` is platform config) — `admin-management.controller.ts` handlers under `/api/admin/groups/:groupId/levels`, surfaced in the group detail drawer's **Levels tab** on `AdminManagement.tsx`. Group admins still review requests for **any** level with no new role. Deleting a level with active members **soft-deactivates** it (members keep access until expiry/revoke).
- ⚠ Adding levels to a group does **not** auto-migrate existing members — legacy `levelId=null` grants keep working on the group's base `externalGroupId`; only new requesters pick a level.
- **Changing levels (promote/demote):** a member who already holds a level can move to a different one via `POST /api/access-requests/change-level` (UI: the *Change Level* button on the group detail page). Direction is decided **server-side by level `rank`**: a move to a **lower** rank is a self-service **demotion** applied immediately (carrying the member's **current grant expiry over unchanged** — the duration label is kept for display, but `expiresAt` is not recomputed, so a demotion can never extend the remaining time; the modal hides the duration picker for it); a move to a **higher or equal** rank (or up from a level-less grant) is a **promotion** that goes through the normal request → admin approval flow, keeping the current level until approved. Either way the user holds **exactly one level per group** — granting the new level swaps out the old one in `_provision` (which detects an existing active grant and calls `accessWorkflowService._swapGrant`: atomic deactivate-old + create-new, then a best-effort deprovision of the old level's external group, audited `ACCESS_LEVEL_CHANGED`). First-time access still goes through `POST /api/access-requests`, which keeps blocking when the user already has active access to the group. **Admins can also set a member's level directly** from the group detail drawer's **Members tab** (`PUT /api/admin/groups/:groupId/members/:userAccessId/level` → `accessWorkflowService.adminSetMemberLevel`): no promote/demote gating (admin authority), applies immediately via the same swap, and carries the grant's duration over from its originating request. The Admin Management members list shows each member's current level (`listGroupMembers` now returns `levelId`/`levelName`).

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
- **Audit logs**: every state-changing action should write a row to `audit_entries` via `prisma.auditEntry.create({...})`. Patterns: `REQUEST_CREATED`, `REQUEST_REJECTED`, `ACCESS_GRANTED`, `ACCESS_REVOKED`, `ACCESS_EXPIRED`, `ACCESS_EXPIRY_FAILED`, `ACCESS_LEVEL_CHANGED`, `PROVISION_FAILED`, `MANUAL_SYNC_TRIGGERED`, `PLATFORM_ADMIN_ASSIGNED`, `PLATFORM_ADMIN_REVOKED`, `GROUP_ADMIN_ASSIGNED`, `GROUP_ADMIN_REVOKED`, `ADMIN_RECONCILE_TRIGGERED`, `GROUP_CREATED`, `GROUP_UPDATED`, `GROUP_ARCHIVED`, `GROUP_DELETED`, `GROUP_LEVEL_CREATED`, `GROUP_LEVEL_UPDATED`, `GROUP_LEVEL_DELETED`, `GROUP_LEVEL_DEACTIVATED`, `USER_CREATION_*`. (`action` is a free string — no enum.)
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

# Frontend lint exists. Tests exist (P2-1). Backend lint doesn't exist yet (P2-3). CI doesn't exist yet (P2-4).
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
- ✅ Per-platform account creation — `UserCreationRequest` unique per `(user, platform)`, `externalUserId` is `String`; the user-creation gate, `cascadeRejectForUser`, and `provisionWaitingRequests` are all platform-scoped; failed non-Redash invites are retryable
- ✅ Onboarding copy is adapter-owned (`getOnboardingMessage()`); platform notification copy is platform-aware (no hardcoded "Redash")
- ✅ Platform ACTIVE/COMING_SOON derived from the registry via `GET /api/platforms` — `frontend/src/lib/platforms.ts` is presentation-only
- ✅ Frontend ESLint wired (`cd frontend; npm run lint`)
- ✅ Vitest test suite implemented (P2-1)
- ❌ No CI
- ❌ No backend linter (frontend has one)

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
