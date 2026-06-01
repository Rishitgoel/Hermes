# Hermes — Roadmap

The prioritized implementation backlog for Hermes, grouped **P2 → P3** (P0/P1 are finished — see the Done table). Each open item has enough detail that you can paste a single section into a new chat and start.

> **Re-verified against the codebase on 2026-06-01** (branch `main`, latest commit `42b20006`).
> This doc was originally the "post-P0" backlog written right after commit `36dbcad3`. A lot has shipped since, so several items moved to Done and stale references were corrected. The biggest changes since the first draft:
> - **Dev stack moved off Docker onto Supabase.** The database is a cloud Postgres (Supabase); Keycloak, Redash, and email all run in **simulation mode** by default for local dev. `docker-compose.yml` services are mostly commented out.
> - **Provisioner layer was generalized** (old P3-1): the Redash-specific `redash_users` / `redash_groups` tables were dropped in favour of generic `platform_external_users` / `platform_external_groups`.
> - **Three-tier admin model** (super → platform → group) + Admin Management UI landed.
> - **New features not in the original doc:** a user-creation-with-admin-approval workflow, and AWS SES transactional email (alongside Slack).
> - "Redash sync" is now **platform sync** (adapter-agnostic). Update your mental model when reading older notes below.

---

## How to use this doc

When you want to tackle an item, open a new chat in `D:\Bachatt\Hermes 2` and paste something like:

> Implement **P2-3** from `ROADMAP.md` (Backend lint + Prettier).

Claude will re-read this doc, read the relevant files, ask any clarifying questions, and implement. For larger items (P2-1 Tests) we may split across multiple chats to keep each commit focused — that's fine, just say "continue P2-1 step 2" in the next chat.

If you ever forget the IDs, just say "show me the roadmap" and Claude will read this file.

For setup/commands (how to run, migrate, typecheck), see **`CLAUDE.md`** — this doc no longer duplicates them. The dev DB is Supabase and migrations are already applied there; you only run `npm run prisma:migrate` when you add a *new* migration. After pulling, run `npx prisma generate --schema=prisma/hermes/schema.prisma` to refresh the client.

---

## Done

Everything below is on `main` / `origin/main`. Verified present in the tree on 2026-06-01.

| # | Item | Where / evidence |
|---|------|------------------|
| P0-1 | Keycloak token refresh (fixes 5-min vanish bug) | `frontend/src/contexts/AuthContext.tsx`, `frontend/src/services/apiClient.ts` (commit `36dbcad3`) |
| P0-2 | Replace stale unique index with partial unique | migration `20260526120000_replace_user_access_unique` |
| P0-3 | `Group.platform` enum → String to match DB | `backend/prisma/hermes/schema.prisma` |
| P0-4 | Removed hardcoded `--name init` from `prisma:migrate` | `backend/package.json` |
| P0-5 | Standardised auth-middleware error response shape | `backend/src/middleware/auth.middleware.ts` |
| P1-1 | Extracted admin-check helpers; collapsed duplicated blocks | `backend/src/utils/authz.ts` (commit `afeafccc`) |
| P1-2 | Periodic platform sync cron + `lastSyncAt` on `/health` | `backend/src/services/scheduler.service.ts`, `sync.service.ts` (commit `f5982fca`) |
| P1-3 | Wired up `THREE_MONTHS` duration option | `frontend/src/components/access/AccessRequestModal.tsx`, `frontend/src/pages/Groups.tsx` (commit `d042c097`) |
| P1-4 | `.gitignore` + `backend/.env.example` + `frontend/.env.example` | repo root, `backend/`, `frontend/` (commit `989d9da9`) |
| P1-5 | Migrated every page onto TanStack Query | `frontend/src/main.tsx`, `lib/queryClient.ts`, `lib/queryKeys.ts`, all `pages/*.tsx` (commit `008739e4`) |
| **P3-1** | **Generalized provisioner storage** — generic `platform_external_users` / `platform_external_groups`; dropped Redash-specific cache tables | migrations `20260529100000_add_generic_platform_tables`, `20260529100100_drop_redash_cache_tables`; `backend/src/services/redash.provisioner.ts`, `sync.service.ts` |
| **Admin tiers** | **Three-tier admin model** (super → platform → group) + Admin Management UI. Keycloak-authoritative roles mirrored in `platform_admins` / `group_admins` tables; `adminScopes` on `/auth/me`; group admins auto-enrolled. See **CLAUDE.md → Auth → Admin tiers**. | `backend/src/utils/authz.ts`, `keycloak-admin.service.ts`, `admin-management.controller.ts`, `admin.route.ts`, `scripts/migrate-group-admin-roles.ts`, `frontend/src/pages/AdminManagement.tsx`; migration `20260529110000_add_platform_admins` |
| **User creation** | **User-creation-with-admin-approval workflow** (request account → admin approves → invite link). Not in the original roadmap. | `backend/src/controllers/user-creation.controller.ts`, `services/user-creation.service.ts`; migrations `20260528101716_add_user_creation_workflow`, `20260528104309_add_user_creation_invite_link`, `20260528122344_add_is_invitation_pending`; `frontend/src/pages/AccountStatus.tsx` |
| **Email (SES)** | **AWS SES transactional email** alongside Slack, with shared templates and an `EMAIL_SIMULATION` flag. | `backend/src/services/email.service.ts`, `utils/email-templates.ts`, `notification.service.ts` |
| **Dev stack** | **Docker → Supabase**, Docker-free local dev, simulation flags for Keycloak/Redash/email. | `docker-compose.yml` (commented), `backend/.env.example`, `CLAUDE.md` |

**Completed "smaller wins"** (were in the original tail list, now verified done): `process.env.NODE_ENV` reads consolidated into `config.isDev`/`config.isProd` (only `config.ts` reads the raw env); `expireAccess` calls parallelised with `Promise.allSettled` in the scheduler; `ErrorBoundary` added (`frontend/src/components/common/ErrorBoundary.tsx`, wired in `App.tsx`); redash provisioner no longer hardcodes `groupIds: [1]` for invited users; Slack/email message strings extracted to `backend/src/utils/email-templates.ts`.

> ⚠️ **Removed as moot:** the old "add a Redis ping to `/health`" win. Redis isn't referenced anywhere in `backend/src/` (it's only a commented service in `docker-compose.yml`). Revisit only if P3-2 (BullMQ) lands.

---

## Quick index — open items

| ID | Item | Effort | Risk |
|----|------|--------|------|
| **P2** | **Hardening** | | |
| P2-1 | Tests (vitest) | L | Low |
| P2-2 | Bulk endpoints | M | Low |
| P2-3 | Backend lint + Prettier | S | Low |
| P2-4 | CI on push | M | Low |
| P2-5 | Audit log filtering | S | Low |
| P2-6 | Replace polling with SSE | M | Med |
| **P3** | **Architecture for scale** | | |
| ~~P3-1~~ | ~~Generalize provisioner pattern~~ — **Done** (see Done table) | — | — |
| P3-2 | Event bus → BullMQ | L | Med |
| P3-3 | Idempotency keys on provisioning | M | Med |
| P3-4 | Split Groups.tsx (and other large pages) | M | Low |
| P3-5 | OpenAPI spec from Zod | M | Low |
| P3-6 | OpenTelemetry traces | M | Low |

Effort: XS ≈ 15 min · S ≈ 1–2 h · M ≈ half day · L ≈ 1–2 days. Risk = chance of breaking existing flows.

---

# P2 — Hardening

## P2-1 — Tests (vitest)

**Why:** zero test coverage today (verified — no `*.test.ts` / `*.spec.ts` anywhere). The access workflow (request → approve → provision → revoke → expire) is the riskiest code and has the most state transitions. Regressions here will silently break authorization. The newer **user-creation** and **admin-tier authorization** paths are now equally worth covering.

**Stack:**
- **vitest** for both backend and frontend (same runner, simpler than jest + babel).
- **@testcontainers/postgresql** for backend integration tests against a real Postgres. ⚠️ Don't point integration tests at the Supabase dev DB — spin up an ephemeral local Postgres so tests can't pollute shared data.
- **@testing-library/react** for component tests.

**Backend tests, in priority order:**
1. **Unit:** `AccessWorkflowService.calculateExpiry` — pure function, easy first win. Also `backend/src/utils/authz.ts` helpers (`isSuperAdmin`, `isPlatformAdminOf`, `isGroupAdminOf`) — pure-ish and security-critical.
2. **Integration (high-value):** full lifecycle
   - Seed: a group + a regular user.
   - `createRequest()` → assert request row exists with status PENDING, audit entry created.
   - `reviewRequest(id, reviewer, 'APPROVED')` → assert PROVISIONED + UserAccess row + audit entry + event emitted.
   - Advance system clock OR call `expireAccess(userAccessId)` directly → assert UserAccess.isActive=false + access request status=EXPIRED + audit entry.
3. **Failure paths:**
   - Re-requesting access when already active → ConflictError.
   - Approving as wrong group admin → AuthorizationError.
   - Provisioner throwing → request goes to PROVISION_FAILED, audit entry includes error.
4. **(New) user-creation flow:** request account → admin approve → invite link issued; reject path; duplicate-request guard.

**Frontend tests:**
1. `AuthContext` simulation-mode role switcher (four roles: super_admin / platform_admin / group_admin / user).
2. Each page renders without crashing given a mocked `apiClient`.
3. (Stretch) one Playwright/Cypress happy-path end-to-end run.

**Done when:**
- `npm test` runs in <60 s and covers grant/revoke/expire.
- The CI job (P2-4) fails on red tests.

---

## P2-2 — Bulk endpoints

**Why:** verified still N parallel HTTP calls. `Groups.tsx` bulk-requests groups via `Promise.allSettled(requestsToSubmit.map(...))` (`frontend/src/pages/Groups.tsx:156`), and `PendingApprovals.tsx` does the same for review (`:117`). Each call hits the DB independently, fires its own events, sends its own Slack/email — no transaction, partial failures are confusing, and notifications get N pings for what should be one summary.

**Files:**
- `backend/src/routes/access-request.route.ts` — add `POST /bulk` and `PUT /bulk/review`.
- `backend/src/controllers/access-request.controller.ts` — new controller methods.
- `backend/src/services/access-workflow.service.ts` — `createRequestsBulk` and `reviewRequestsBulk` inside a single Prisma transaction.
- `frontend/src/pages/Groups.tsx` — replace the `Promise.allSettled(...)` with a single call.
- `frontend/src/pages/PendingApprovals.tsx` — same for review.

**Approach:**
- Wrap in `prisma.$transaction(async (tx) => {...})`. If any item validates as a duplicate or violates an invariant, fail the whole batch and return per-item error details so the UI can show "3 succeeded, 2 had errors: ...".
- The event bus emits one summary event per bulk call (`requests.bulk.created` with `{requestIds[]}`) instead of N. Notification service formats it as one Slack/email message.
- Audit log gets one bulk audit entry referencing all the request IDs in `details`.

**Done when:** one HTTP call from the frontend; one transaction in the DB; one Slack message; one audit entry referencing all items.

---

## P2-3 — Backend lint + Prettier

**Why:** verified — frontend has ESLint (`npm run lint` works), backend has **none** (no `.eslintrc*` / `eslint.config.*` / `.prettierrc`, no `lint`/`format` scripts in `backend/package.json`).

**Files:**
- `backend/eslint.config.js` (flat config, to match frontend)
- `backend/.prettierrc`
- `backend/package.json` — add `lint` and `format` scripts.

**Approach:** mirror the frontend's eslint flat config; add `@typescript-eslint` recommended rules. Turn on `@typescript-eslint/no-floating-promises` — routes use `.catch(next)` everywhere; this rule will catch the missing ones.

**Done when:** `npm run lint` in `backend/` runs and either passes or produces an actionable list.

---

## P2-4 — CI on push

**Why:** verified — no `.github/workflows/` at all.

**File:** `.github/workflows/ci.yml` (new).

**Approach:**
- Trigger on PR to `main` + push to `main`.
- Jobs (in parallel where possible): `backend-typecheck`, `frontend-typecheck`, `backend-lint` (after P2-3), `frontend-lint`, `prisma-validate`, (eventually) `backend-tests`, `frontend-tests` (after P2-1).
- Use `actions/setup-node@v4` with Node 22 (matches `@types/node@22.15.19`).
- Cache `node_modules` keyed on `package-lock.json` hash and Prisma generation cache.
- `prisma-validate` runs `npx prisma validate --schema=prisma/hermes/schema.prisma` (non-default path — see CLAUDE.md).

**Done when:** any push or PR shows a green/red CI status icon on GitHub.

---

## P2-5 — Audit log filtering

**Why:** verified — `auditQuerySchema` (`backend/src/validations/audit.validation.ts`) still only accepts `action` and `search`. When investigating an incident, the most common questions are "what happened on date X" and "what did user Y do" — neither of which the UI supports.

**Files:**
- `backend/src/validations/audit.validation.ts` — extend schema with `performerId`, `fromDate`, `toDate`, `groupId`.
- `backend/src/controllers/audit.controller.ts` — wire all filters into the `where` clause.
- `frontend/src/pages/AuditLog.tsx` — add filter UI (date pickers, performer search input, group dropdown).

**Done when:** filtering by `(performerId, fromDate, toDate)` correctly narrows the audit table.

---

## P2-6 — Replace polling with SSE

**Why:** verified — `NotificationContext.tsx:76` still polls via `setInterval(fetchNotifications, 60000)` for every authenticated user. Wasteful, laggy, and gets worse as users grow.

**Approach:**
- Server: `GET /api/notifications/stream` using Server-Sent Events. The handler subscribes to the in-process event bus for `notification.*` events scoped to `req.user.id` and writes them to the response.
- Frontend: replace `setInterval(fetchNotifications, 60000)` with an `EventSource('/api/notifications/stream?token=' + keycloak.token)`. EventSource doesn't support custom headers, so token-as-query-param is the standard pattern; rotate on token refresh.
- Keep the initial `fetchNotifications()` call so the unread list is populated on mount.
- Watch for: connection drop reconnect logic (`EventSource` retries automatically with backoff, but token may have expired — handle 401 by closing and re-opening).

**Caveat:** if you later move to BullMQ (P3-2), the SSE handler needs to subscribe to the Redis queue events instead of the in-process emitter. Worth doing P3-2 first, or at least planning for it.

**Done when:** marking a notification as read in one tab updates an open tab in another within ~1 s, with no polling visible in the network tab.

---

# P3 — Architecture for scale (when adding AWS / Jira)

> **P3-1 (generalize the provisioner pattern) is done** — `platform_external_users` / `platform_external_groups` are live and the Redash-specific tables were dropped. See the Done table. A new adapter (AWS, Jira) now reuses those generic tables with its own `platform` value; **don't** add per-platform cache tables.

## P3-2 — Event bus → BullMQ (Redis-backed)

**Why:** in-process `EventEmitter` (`backend/src/services/event-bus.ts`) loses events on crash. A Slack/email send failure is silently swallowed — no retry. As you add platforms and notification channels (now email + Slack; later MS Teams), this gets worse.

> **State note:** Redis is **not used anywhere in the code** today, and the dev stack is Docker-free (Supabase for DB). To adopt BullMQ you'll need to stand up a Redis instance — uncomment/start the `redis` service in `docker-compose.yml`, or point at a hosted Redis — and add a `REDIS_URL` env var.

**Approach:**
1. `npm i bullmq`.
2. Create a `backend/src/services/queue.ts` that exports a single `Queue('hermes-events')` instance pointing at `REDIS_URL`.
3. Replace `eventBus.emit*(...)` with `queue.add(eventType, payload)`.
4. Each consumer (notification, slack, email, audit) becomes a BullMQ `Worker` with retry/backoff config.
5. Failed jobs land in a dead-letter queue. Add a small admin endpoint `GET /api/admin/queues` returning `await queue.getJobCounts()` for visibility.
6. Update tests + bring up Redis in CI.

**Done when:**
- Stopping Slack mid-grant and restarting it: the notification is eventually delivered (not silently dropped).
- Crashing the backend mid-event-emit: the event is picked up on restart.

---

## P3-3 — Idempotency keys on provisioning

**Why:** if `redash.addUserToGroup` hangs after Redash applied the change but before returning, the workflow retries and the user gets double-added. Or it errors and the workflow rolls back even though Redash succeeded. Currently there's no way to tell (verified — no `provisioningKey` / idempotency anywhere).

**Approach:**
1. Add `provisioningKey String? @unique` to `AccessRequest` — a deterministic key like `req-${requestId}` (or `req-${requestId}-${attempt}` if you support retries).
2. Provisioner caches the result of `provision()` keyed by `provisioningKey` in a new `provisioning_attempts` table. On retry with the same key, return cached result instead of re-calling the platform.
3. For deprovisioning: same pattern keyed by `userAccessId`.
4. Add a reconcile job (depends on P3-2) that periodically verifies: for every active `UserAccess`, membership exists on the platform; for every revoked, it's gone. (Note: the **admin** side already has `adminReconciliationService` for Keycloak↔mirror drift — this is the equivalent for platform access.)

**Done when:** killing the backend mid-provision and restarting doesn't double-add or skip the user.

---

## P3-4 — Split large pages (Groups.tsx and friends)

**Why:** verified line counts — `Groups.tsx` is **879** lines, `AdminManagement.tsx` **624**, `PendingApprovals.tsx` **536**. `Groups.tsx` does platform-grid + groups-table + bulk-request panel + 3 modals + reason-popover state. Hard to test, hard to reason about, hard to onboard anyone to.

**Suggested decomposition (Groups.tsx first):**
- `pages/Groups.tsx` — orchestrator only (~80 lines).
- `components/groups/PlatformGrid.tsx` — the platform card grid (active vs coming-soon).
- `components/groups/GroupsTable.tsx` — the searchable table of groups for the active platform.
- `components/groups/BulkRequestPanel.tsx` — the bottom panel for justification + duration + submit.
- `components/groups/ReasonPopover.tsx` — the per-group reason popover.
- Selection + reasons state into a custom hook `useGroupSelection`.

Then give `AdminManagement.tsx` and `PendingApprovals.tsx` the same treatment.

**Done when:** no single file in `frontend/src/pages/` exceeds 300 lines.

---

## P3-5 — OpenAPI spec from Zod

**Why:** the validation schemas already exist in `backend/src/validations/*`. With `@asteasolutions/zod-to-openapi` you can derive an OpenAPI 3 spec, host it at `/api/docs`, and codegen a typed frontend client. Eliminates the manual `interface GroupData {...}` re-declarations in every frontend page (still the convention today).

**Files (new):**
- `backend/src/openapi.ts` — registry that wraps each Zod schema with `.openapi(...)` metadata.
- `backend/src/routes/docs.route.ts` — serves the JSON spec + Swagger UI at `/api/docs`.
- Frontend codegen via `openapi-typescript` (just types) or `orval` (types + a generated client).

**Done when:**
- `/api/docs` returns a browseable Swagger UI.
- The frontend imports generated types; changing a Zod schema in backend produces a TS error in frontend if the response shape diverges.

---

## P3-6 — OpenTelemetry traces

**Why:** pino logs are great for events but you can't follow a request's path across backend → Prisma → Redash/SES without OTEL.

**Approach:**
1. `npm i @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`.
2. Initialise in a new `backend/src/observability.ts` imported FIRST in `backend/src/app.ts` (before any other import — instrumentation needs to wrap Express/Prisma/Axios before they're loaded).
3. Auto-instrumentation gives you free spans for every HTTP call (in + out) and every Prisma query.
4. Ship traces to whatever Bachatt uses. If undecided, enable the console exporter to see the structure first, then switch.

**Done when:** a single "approve request" action produces one trace showing: incoming HTTP → Prisma queries → outgoing Redash API → outgoing Slack/SES, all under one trace ID.

---

# Smaller wins (open — each ~5–15 min)

The rest of the original tail list is done (see the note under the Done table). These two remain:

- **`frontend/src/pages/GroupDetail.tsx:104`**: replace `window.prompt('...Enter a reason')` with a proper modal for the revoke-reason input (matches the modal pattern used elsewhere).
- **Frontend inline styles**: lift the large inline-style objects in `Groups.tsx` and `Dashboard.tsx` into the existing `frontend/src/styles/global.css` (CSS variables already defined there). You're already loading it; it's barely used.

---

# Suggested order if you have ~1 evening a week

| Week | Items | Why |
|------|-------|-----|
| 1 | P2-3 + P2-4 | Lint + CI. Sets up the rails everything after rides on. Mechanical, low risk. |
| 2 | P2-5 + the two smaller wins | Operational visibility (audit filters) + quick UX cleanups. |
| 3+ | P2-1 (tests) | Take as long as you need. Cover the access workflow + authz helpers first. |
| then | P2-2, P2-6 | Bulk endpoints, then SSE. |
| later | P3-2 → P3-3 → P3-4/5/6 | BullMQ first (SSE and idempotency build on it); page splits and tooling anytime. |

You can also just open a chat and say *"what should I do next?"* — Claude will read this doc + check git log to see what's been done and suggest one item.

---

# Notes for future Claude reading this doc

- The audit that produced the original list is in the chat history of session `claude/sleepy-mclean-c48446` (commit `36dbcad3`'s session). This revision (2026-06-01) re-verified every item against the tree at `42b20006`.
- The user prefers to work directly on `main` — no worktrees, no feature branches. Any work goes into a clean `main` commit, then `git push`.
- The user is a solo dev. Don't suggest workflows that require multiple reviewers / PR templates / code-owners.
- When implementing an item, update this doc: move the row into the **Done** table with its commit SHA / evidence, and strike it through in the Quick index.
- Don't trust line numbers blindly — `Groups.tsx` and other large files drift. Grep for the pattern (e.g. `window.prompt`, `setInterval`) rather than jumping to a line.
