# Hermes — Project Guide for Claude

Read this first whenever you start a chat in this repo. It encodes how the project works and how the user (solo dev, Rishit) wants to work in it.

## TL;DR

Hermes is an internal **access-management portal**. Users request access to groups; admins approve; the backend provisions the user on the target platform (currently only Redash; AWS / Jira / etc. are stubs in the UI). Stack: Node/Express + Prisma + Postgres on the backend, React + Vite on the frontend, Keycloak for auth.

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
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
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

To save RAM on local development (especially on 8GB machines), the project runs **completely Docker-free by default**.
* **Database**: Runs in the cloud on **Supabase** (credentials are configured in `backend/.env`).
* **Authentication**: Skips Keycloak and runs in **Simulation Mode** (enabled in `.env` files).
* **Integrations**: Skips Redash and runs in **Simulation Mode** (enabled in `.env` files).

### Docker Services (`docker-compose.yml`)
All services in `docker-compose.yml` (Postgres, Keycloak, Redis, Redash) are currently commented out to prevent background RAM usage. If you eventually need to run a live service locally:
1. Uncomment the service in [docker-compose.yml](file:///d:/Bachatt/Hermes%202/docker-compose.yml).
2. Start Docker Desktop and run `docker compose up -d`.
3. Set the respective simulation flags to `false` in your `.env` files.

### Environment files

- `backend/.env` and `frontend/.env` exist locally (gitignored).
- `.env.example` files exist as templates ([backend/.env.example](file:///d:/Bachatt/Hermes%202/backend/.env.example), [frontend/.env.example](file:///d:/Bachatt/Hermes%202/frontend/.env.example)).
- Key flags:
  - `KEYCLOAK_SIMULATION=true|false` (backend). When `true`, the backend accepts `Bearer super_admin`, `Bearer group_admin`, or `Bearer user` as the entire token. Enabled (`true`) by default for local dev.
  - `VITE_KEYCLOAK_SIMULATION=true|false` (frontend). When `true`, AuthContext skips Keycloak entirely and reads a mock role from `localStorage['hermes_mock_token']`. Enabled (`true`) by default for local dev.
  - `REDASH_SIMULATION=true|false` (backend). When `true`, `redash.service.ts` returns mock users/groups instead of hitting Redash. Enabled (`true`) by default for local dev.
- **The user runs in simulation mode for local dev** (`KEYCLOAK_SIMULATION=true`, `REDASH_SIMULATION=true`, `VITE_KEYCLOAK_SIMULATION=true`).

### Commands (run from the directory shown)

```powershell
# Backend
cd backend
npm run dev                              # nodemon, port 8001
npm run build                            # tsc → dist/
npm run prisma:migrate                   # applies pending migrations to Supabase
npm run prisma:seed                      # seeds the Supabase database
npx prisma generate --schema=prisma/hermes/schema.prisma   # ⚠ always pass --schema flag
npx prisma validate --schema=prisma/hermes/schema.prisma
npx tsc --noEmit                         # typecheck only

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

- **`backend/src/app.ts`** is the entrypoint. Order on boot: load env → register event listeners → load AWS secrets → ensure Keycloak client/roles exist → start scheduler → run initial Redash sync (non-blocking) → `app.listen()`.
- **Routes** in `src/routes/<resource>.route.ts`. Pattern: `authenticateToken` middleware, optional `requireRole`, then `new Controller(req, res, next).method(req, res, next).catch(next)`.
- **Controllers** all extend `BaseController` (`src/controllers/base.controller.ts`). Use `this.sendResponse(data, msg)`, `this.handleError(err, msg)`, `this.validateWithZod(schema, data)`, `this.getUserId()`.
- **Services** in `src/services/`. Workflow logic lives in `access-workflow.service.ts`. Provisioning is abstracted behind `provisioner.interface.ts` + `provisioning.registry.ts`.
- **Event bus** (`src/services/event-bus.ts`) is an in-process EventEmitter. Subscribers in `event-listeners.ts`. Notifications + Slack come off this. (Will move to BullMQ — P3-2.)
- **Scheduler** (`src/services/scheduler.service.ts`) runs hourly in prod, every 5 min in dev. Currently only handles auto-expiry of time-bound grants.

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
- Simulation mode: `checkJwtSimulated` reads the bearer string and maps to one of three hardcoded mock users.
- **`requireRole(['hermes_super_admin', ...])`** middleware does basic role checks.
- **Group-admin checks** are currently duplicated in 4 controllers — see P1-1 in ROADMAP.md for the cleanup plan.
- **Keycloak token refresh is wired** on the frontend (P0-1 fix in commit `36dbcad3`). The default 5-min access token lifespan no longer breaks the UI — `AuthContext` has `onTokenExpired` + 60s heartbeat, `apiClient` does proactive `updateToken(30)` + one-shot 401 retry.

### Provisioning (key extension point)

To support a new platform (AWS, Jira), implement `PlatformAdapter` (`backend/src/services/provisioner.interface.ts`):

```ts
interface PlatformAdapter {
  readonly platform: string;
  provision(ctx): Promise<ProvisionResult>;
  deprovision(ctx): Promise<void>;
  checkUserStatus(email): Promise<PlatformUserStatus>;
  inviteUser(email, name): Promise<ProvisionResult>;
  healthCheck(): Promise<{ healthy, message? }>;
}
```

Then register in `provisioning.registry.ts` constructor. The workflow service picks the right adapter based on `Group.platform`.

Storage for cached platform state is currently Redash-specific (`redash_users`, `redash_groups`). Generic tables come with P3-1.

### Frontend

- React 19, Vite 6, React Router 7.
- **No data-fetching library** yet — pages use raw `apiClient.get` inside `useEffect`. Migrating to React Query is P1-5.
- `AuthContext` wraps the app; `useAuth()` returns `{ user, isAuthenticated, isLoading, login, logout, switchSimulatedRole }`.
- `NotificationContext` polls `/api/notifications` every 60s. SSE replacement is P2-6.
- `apiClient` is the only HTTP client. It owns the response unwrap + 401 retry. Don't `import axios` directly in components.

---

## Conventions (please follow when adding code)

- **Validation** at the controller boundary using Zod schemas in `backend/src/validations/`. Call via `this.validateWithZod(schema, input, 'msg')`. Don't validate inside services.
- **Errors**: throw `BaseError` subclasses. Don't `res.status(...).json(...)` directly in controllers — go through `BaseController` helpers.
- **Logging**: `import logger from '../utils/logger'` (pino). Don't `console.log` in backend.
- **Config access**: import `config from '../config/config'`. **Don't read `process.env.NODE_ENV` directly** — use `config.isDev`, `config.isProd`. (There are still a few violations in the codebase; fix them when you touch those files.)
- **Audit logs**: every state-changing action should write a row to `audit_entries` via `prisma.auditEntry.create({...})`. Patterns: `REQUEST_CREATED`, `REQUEST_REJECTED`, `ACCESS_GRANTED`, `ACCESS_REVOKED`, `ACCESS_EXPIRED`, `PROVISION_FAILED`, `MANUAL_SYNC_TRIGGERED`.
- **Events**: after a state change, also emit on `eventBus` (`backend/src/services/event-bus.ts`) so notifications/Slack fire async.
- **Frontend types**: each page redeclares its data shape as an `interface`. Until P3-5 (OpenAPI codegen), this is the convention — match the backend response shape exactly.
- **CSS**: there's a `frontend/src/styles/global.css` with CSS variables (`--primary`, `--text-muted`, `--radius-md`, `--shadow-md`, etc.). Use them. Inline styles are heavily used today but should be migrating out (smaller-wins list in ROADMAP.md).

---

## Don'ts

- ❌ Don't add `--name <x>` to `prisma:migrate` in package.json — that's what caused the duplicate `_init` migration folders before P0-4.
- ❌ Don't create Redash-specific tables for new platforms (use the generic pattern that P3-1 will land).
- ❌ Don't swallow errors in controllers (`try { ... } catch {}` with no log). Always `this.handleError(err, 'message')`.
- ❌ Don't bypass `apiClient` on the frontend (axios directly). It owns auth + retry + unwrap.
- ❌ Don't push to `origin/main` with force unless the user explicitly asks.
- ❌ Don't create `feature/...` or `fix/...` branches. Direct commits on `main`.
- ❌ Don't create new `.md` documentation files unless the user asks for them. Update `ROADMAP.md` or this file when relevant.

---

## Verification commands (run after non-trivial changes)

```powershell
# Always
cd "D:\Bachatt\Hermes 2\backend"; npx tsc --noEmit
cd "D:\Bachatt\Hermes 2\frontend"; npx tsc --noEmit

# If you changed Prisma schema
cd "D:\Bachatt\Hermes 2\backend"; npx prisma validate --schema=prisma/hermes/schema.prisma

# If you changed frontend
cd "D:\Bachatt\Hermes 2\frontend"; npm run lint

# Tests don't exist yet (P2-1). Backend lint doesn't exist yet (P2-3). CI doesn't exist yet (P2-4).
```

Tell the user what passed/failed before reporting "done."

---

## Current state checklist

- ✅ Token refresh works (P0-1, commit 36dbcad3)
- ✅ Schema and migrations are in sync (P0-2, P0-3, commit 36dbcad3)
- ✅ Error response shape is uniform (P0-5, commit 36dbcad3)
- ❌ No tests
- ❌ No CI
- ❌ No backend linter
- ❌ No `.env.example`
- ❌ Redash sync only at boot (drifts during the day)
- ❌ Group-admin authorization check is duplicated in 4 places
- ❌ Frontend pages do raw fetch in useEffect (no caching)

When the user asks "what's next?" — open `ROADMAP.md` and suggest the next P1 item that fits the time they have.

---

## When in doubt

Ask. The user prefers a quick clarifying question over you going down the wrong path for 30 minutes. Especially before:
- changing the response shape or auth model
- touching migrations
- adding any new top-level dependency
- doing anything visible on `origin/main`
