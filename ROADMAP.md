# Hermes — Roadmap

The prioritized implementation backlog for Hermes, grouped **P2 → P3** (P0/P1 are finished — see the Done table). Each open item has enough detail that you can paste a single section into a new chat and start.

> **Re-verified against the codebase on 2026-06-11** (branch `main`, latest commit `107fbf03`).
> This doc was originally the "post-P0" backlog written right after commit `36dbcad3`. A lot has shipped since, so several items moved to Done and stale references were corrected. The biggest changes since the first draft:
> - **Dev stack moved to local Docker Postgres.** The database is a local Postgres container (`localhost:15433`); Keycloak, Redash, and email all run in **simulation mode** by default for local dev.
> - **Provisioner layer was generalized** (old P3-1): the Redash-specific `redash_users` / `redash_groups` tables were dropped in favour of generic `platform_external_users` / `platform_external_groups`.
> - **Three-tier admin model** (super → platform → group) + Admin Management UI landed.
> - **AWS IAM Identity Center adapter** is live (`aws.provisioner.ts` + `aws-identity-center.service.ts`), with simulation mode for local dev.
> - **Per-platform account creation** — `UserCreationRequest` is unique per `(user, platform)`; approval on one platform doesn't imply another.
> - **Group levels (subgroups)** — each level backed by its own external group; non-breaking (level-less groups unchanged).
> - **New features not in the original doc:** user-creation-with-admin-approval, AWS SES transactional email (alongside Slack), group CRUD from Admin UI, admin set-member-level (self-service promote/demote was built then removed — too much complexity for little value).
> - "Redash sync" is now **platform sync** (adapter-agnostic). Update your mental model when reading older notes below.

---

## How to use this doc

When you want to tackle an item, open a new chat in `D:\Bachatt\Hermes 2` and paste something like:

> Implement **P2-3** from `ROADMAP.md` (Backend lint + Prettier).

Claude will re-read this doc, read the relevant files, ask any clarifying questions, and implement. For larger items (P2-1 Tests) we may split across multiple chats to keep each commit focused — that's fine, just say "continue P2-1 step 2" in the next chat.

If you ever forget the IDs, just say "show me the roadmap" and Claude will read this file.

For setup/commands (how to run, migrate, typecheck), see **`CLAUDE.md`** — this doc no longer duplicates them. The dev DB is a local Docker Postgres (`localhost:15433`); you run `npm run prisma:migrate` when you add a *new* migration. After pulling, run `npx prisma generate --schema=prisma/hermes/schema.prisma` to refresh the client.

---

## Done

Everything below is on `main` / `origin/main`. Verified present in the tree on 2026-06-11.

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
| **Admin tiers** | **Three-tier admin model** (super → platform → group) + Admin Management UI. Keycloak-authoritative roles mirrored in `platform_admins` / `group_admins` tables; `adminScopes` on `/auth/me`. Group admins are **not** auto-enrolled into groups (approval rights only). See **CLAUDE.md → Auth → Admin tiers**. | `backend/src/utils/authz.ts`, `keycloak-admin.service.ts`, `admin-management.controller.ts`, `admin.route.ts`, `scripts/migrate-group-admin-roles.ts`, `frontend/src/pages/AdminManagement.tsx`; migration `20260529110000_add_platform_admins` |
| **User creation** | **User-creation-with-admin-approval workflow** (request account → admin approves → invite link). Per-platform: `UserCreationRequest` unique per `(user, platform)`. | `backend/src/controllers/user-creation.controller.ts`, `services/user-creation.service.ts`; migrations `20260528101716_add_user_creation_workflow`, `20260528104309_add_user_creation_invite_link`, `20260528122344_add_is_invitation_pending`; `frontend/src/components/user-creation/AccountStatusPanel.tsx` |
| **Email (SES)** | **AWS SES transactional email** alongside Slack, with shared templates and an `EMAIL_SIMULATION` flag. | `backend/src/services/email.service.ts`, `utils/email-templates.ts`, `notification.service.ts` |
| **AWS adapter** | **AWS IAM Identity Center** provisioner live. `AWS_SIMULATION` mock by default; real Identity Store when configured. Handles create-user, provision/deprovision to groups, sync, and eventual-consistency retries. | `backend/src/services/aws.provisioner.ts`, `aws-identity-center.service.ts`; `provisioning.registry.ts` (registered alongside Redash) |
| **Group levels** | **Group levels / subgroups** — each level backed by its own external group; non-breaking (level-less groups unchanged). Level changes via admin set-member-level with atomic swap (self-service promote/demote removed). CRUD is super/platform-admin only. | `backend/src/services/access-workflow.service.ts` (`_swapGrant`, `adminSetMemberLevel`), `admin-management.controller.ts`; `frontend/src/pages/AdminManagement.tsx` |
| **Group CRUD** | **Group create/edit/archive** from Admin Management UI. Delete is pristine-only; referenced groups are archived. | `admin-management.controller.ts` (`createGroup` / `updateGroup` / `deleteGroup`); `frontend/src/pages/AdminManagement.tsx` |
| **Dev stack** | **Local Docker Postgres** (`localhost:15433`), simulation flags for Keycloak/Redash/AWS/email. | `docker-compose.yml`, `backend/.env.example`, `CLAUDE.md` |
| **P2-1** | **Tests (vitest)** | Root-level `npm test` sequentially running backend integration tests (via `@testcontainers/postgresql`) and frontend unit/smoke tests (via `jsdom` and React Testing Library). |
| **P2-2** | **Bulk endpoints** — `POST /api/access-requests/bulk` + `PUT /api/access-requests/bulk/review`; the Groups + Pending Approvals pages now make one HTTP call instead of N. Create is one transaction with partial-success per-item results + one consolidated `requests.bulk.created` notification (one Slack ping + one summary per admin). Review reuses the per-item path so each requester still gets their own notification; returns per-item `reviewed`/`failed`. | `backend/src/routes/access-request.route.ts`, `controllers/access-request.controller.ts`, `services/access-workflow.service.ts` (`createRequestsBulk`), `validations/access-request.validation.ts`, `services/event-bus.ts`, `event-listeners.ts`, `notification.service.ts` (`notifyRequestsCreatedBulk`), `utils/email-templates.ts`; `frontend/src/pages/Groups.tsx`, `PendingApprovals.tsx` |
| **P2-3** | **Backend lint + Prettier** — flat ESLint config mirroring the frontend + type-aware `@typescript-eslint/no-floating-promises` (fixed the dropped promises it surfaced: scheduler `stop()`, redash chain cleanup, `bootstrap()`). `npm run lint` / `format` / `format:check`. | `backend/eslint.config.mjs`, `backend/.prettierrc`, `backend/package.json` |
| **P2-4** | **CI on push** — GitHub Actions on push + PR to `main`: backend/frontend typecheck, backend/frontend lint, prisma-validate, backend tests (testcontainers), frontend tests. Node 22, per-project npm cache. Also fixed pre-existing breakage so the typecheck/build are green (see note below). | `.github/workflows/ci.yml` |
| **P2-5** | **Audit log filtering** — extended `auditQuerySchema` + controller with `performerId`, `fromDate`, `toDate`, `groupId`, `platform` (platform resolved to its group ids since `AuditEntry` has no platform column); AuditLog UI gained date range + platform + group selectors + Clear filters. | `backend/src/validations/audit.validation.ts`, `controllers/audit.controller.ts`; `frontend/src/pages/AuditLog.tsx`, `lib/queryKeys.ts` |
| **P2-6** | **SSE instead of polling** — `GET /api/notifications/stream` (Server-Sent Events) replaces the 60s `NotificationContext` poll. `createNotification` emits a scoped `notification.created`; a single-listener `notification-stream.service` fans out per user. EventSource authenticates via `?token=` (header-injection middleware reuses the normal auth chain); the client re-hydrates on (re)connect. In-process today; subscribes to the queue when P3-2 (BullMQ) lands. | `backend/src/services/notification-stream.service.ts`, `event-bus.ts`, `notification.service.ts`, `controllers/notification.controller.ts`, `routes/notification.route.ts`, `middleware/auth.middleware.ts`; `frontend/src/contexts/NotificationContext.tsx` |
| **P3-7** | **ZooKeeper value change-requests** — approval-only config edits under user's scoped grants using a world-open znode model. | `backend/src/services/zookeeper-config.service.ts`, `frontend/src/pages/ZookeeperConfig.tsx` (commits `64d7ca0f`, `247090cf`) |
| **Win-1** | **Replace window.prompt** — revoke-reason input replaced with a proper `<ReasonModal>` component in GroupDetail page. | `frontend/src/pages/GroupDetail.tsx` (L441-456) |

**Completed "smaller wins"** (were in the original tail list, now verified done): `process.env.NODE_ENV` reads consolidated into `config.isDev`/`config.isProd` (only `config.ts` reads the raw env); `expireAccess` calls parallelised with `Promise.allSettled` in the scheduler; `ErrorBoundary` added (`frontend/src/components/common/ErrorBoundary.tsx`, wired in `App.tsx`); redash provisioner no longer hardcodes `groupIds: [1]` for invited users; Slack/email message strings extracted to `backend/src/utils/email-templates.ts`.

> ⚠️ **Removed as moot:** the old "add a Redis ping to `/health`" win. Redis isn't referenced anywhere in `backend/src/` (it's only a commented service in `docker-compose.yml`). Revisit only if P3-2 (BullMQ) lands.

> 🛠 **Pre-existing typecheck/build fix (done alongside P2-4):** `tsc` (both `npx tsc --noEmit` and `npm run build`) was silently failing on `main` because the test files were inside the production `tsconfig` — `backend/src/test/setup.ts` uses top-level `await` (illegal under CommonJS) and the frontend test files trip `noUnusedLocals`. Tests are run by Vitest's esbuild pipeline, not `tsc`, so both `tsconfig.json`s now `exclude` `*.test.*` / the test dir (backend also excludes them from ESLint). This makes typecheck/build/CI green. If you add a test-type-check step later, point it at a separate `tsconfig.test.json`.

---

## Quick index — open items

| ID | Item | Effort | Risk |
|----|------|--------|------|
| **P2** | **Hardening** | | |
| ~~P2-1~~ | ~~Tests (vitest)~~ — **Done** (see Done table) | — | — |
| ~~P2-2~~ | ~~Bulk endpoints~~ — **Done** (see Done table) | — | — |
| ~~P2-3~~ | ~~Backend lint + Prettier~~ — **Done** (see Done table) | — | — |
| ~~P2-4~~ | ~~CI on push~~ — **Done** (see Done table) | — | — |
| ~~P2-5~~ | ~~Audit log filtering~~ — **Done** (see Done table) | — | — |
| ~~P2-6~~ | ~~Replace polling with SSE~~ — **Done** (see Done table) | — | — |
| **P3** | **Architecture for scale** | | |
| ~~P3-1~~ | ~~Generalize provisioner pattern~~ — **Done** (see Done table) | — | — |
| P3-2 | Event bus → BullMQ (+ idempotency keys) | L | Med |
| ~~P3-3~~ | ~~Idempotency keys~~ — **Folded into P3-2** (adapters handle conflicts inline now) | — | — |
| P3-4 | Split large pages (Groups, GroupDetail, PendingApprovals) | M | Low |
| P3-5 | OpenAPI spec from Zod | M | Low |
| P3-6 | OpenTelemetry traces | M | Low |
| ~~P3-7~~ | ~~ZooKeeper value change-requests (approval-gated edits)~~ — **Done** (see Done table) | — | — |

Effort: XS ≈ 15 min · S ≈ 1–2 h · M ≈ half day · L ≈ 1–2 days. Risk = chance of breaking existing flows.

---

# P2 — Hardening

All hardening (P2) tasks have been completed. Refer to the Done table above.

---

# P3 — Architecture for scale

> **P3-1 (generalize the provisioner pattern) is done** — `platform_external_users` / `platform_external_groups` are live and the Redash-specific tables were dropped. See the Done table. AWS is already using these tables with `platform='aws'`. A new adapter (Jira, etc.) reuses them with its own `platform` value; **don't** add per-platform cache tables.

## P3-2 — Event bus → BullMQ (Redis-backed) + idempotency keys

**Why:** in-process `EventEmitter` (`backend/src/services/event-bus.ts`) loses events on crash. A Slack/email send failure is silently swallowed — no retry. With two live platforms and three notification channels (in-app + Slack + email), the blast radius is growing.

> **Urgency note (2026-06-11):** lower than originally estimated. The scheduler's `MAX_EXPIRY_ATTEMPTS=3` retry cap prevents infinite deprovision loops, and both the Redash and AWS adapters now handle conflicts inline (`EntityAlreadyExists`, 404-tolerant cleanup). The remaining real pain point is silently dropped Slack/email notifications on send failure. Revisit urgency when adding a third platform or deploying multi-instance.

> **State note:** Redis is **not used anywhere in the code** today. The dev stack runs a local Docker Postgres — Redis would sit alongside it in `docker-compose.yml`. To adopt BullMQ: uncomment/start the `redis` service, or point at a hosted Redis, and add a `REDIS_URL` env var.

**Approach:**
1. `npm i bullmq`.
2. Create a `backend/src/services/queue.ts` that exports a single `Queue('hermes-events')` instance pointing at `REDIS_URL`.
3. Replace `eventBus.emit*(...)` with `queue.add(eventType, payload)`.
4. Each consumer (notification, slack, email, audit) becomes a BullMQ `Worker` with retry/backoff config.
5. Failed jobs land in a dead-letter queue. Add a small admin endpoint `GET /api/admin/queues` returning `await queue.getJobCounts()` for visibility.
6. **(Folded from old P3-3)** Add `provisioningKey String? @unique` to `AccessRequest`. BullMQ retries use this key to avoid double-provisioning — the adapter checks `provisioning_attempts` for a cached result before calling the platform. Both live adapters already handle conflicts at the API level, so this is defense-in-depth for retry storms.
7. Update tests + bring up Redis in CI.

**Done when:**
- Stopping Slack mid-grant and restarting it: the notification is eventually delivered (not silently dropped).
- Crashing the backend mid-event-emit: the event is picked up on restart.

---

## ~~P3-3 — Idempotency keys on provisioning~~ → Folded into P3-2

> **2026-06-11:** Both live adapters now handle the "applied but response lost" scenario inline: Redash's cleanup tolerates 404 (already gone), AWS catches `EntityAlreadyExists` conflicts and treats idempotent add-to-group/remove-from-group as success. A formal `provisioningKey` + `provisioning_attempts` table still adds defense-in-depth for BullMQ retry storms, but it's no longer a standalone item — folded into P3-2 step 6.

---

## P3-4 — Split large pages (Groups.tsx, GroupDetail.tsx, and friends)

**Why:** verified line counts (2026-06-11) — `Groups.tsx` is **858** lines, `PendingApprovals.tsx` **526**, `GroupDetail.tsx` **467**, `AdminManagement.tsx` **364**. `Groups.tsx` does platform-grid + groups-table + bulk-request panel + level pickers + reason-popover state. `GroupDetail.tsx` grew significantly with the level-change UI + member management + settings tab. Hard to test, hard to reason about, hard to onboard anyone to.

**Suggested decomposition (Groups.tsx first):**
- `pages/Groups.tsx` — orchestrator only (~80 lines).
- `components/groups/PlatformGrid.tsx` — the platform card grid (active vs coming-soon).
- `components/groups/GroupsTable.tsx` — the searchable table of groups for the active platform.
- `components/groups/BulkRequestPanel.tsx` — the bottom panel for justification + duration + level pickers + submit.
- `components/groups/ReasonPopover.tsx` — the per-group reason popover.
- Selection + reasons + levels state into a custom hook `useGroupSelection`.

Then `GroupDetail.tsx` (members table, level-change panel, settings drawer → separate components) and `PendingApprovals.tsx`. `AdminManagement.tsx` (364 lines) is borderline — revisit after the others.

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

**Why:** pino logs are great for events but you can't follow a request's path across backend → Prisma → Redash/AWS/SES without OTEL. With two live platform adapters, the call graphs are more complex — an "approve request" action now potentially touches Keycloak + (Redash OR AWS Identity Store) + Slack + SES.

**Approach:**
1. `npm i @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`.
2. Initialise in a new `backend/src/observability.ts` imported FIRST in `backend/src/app.ts` (before any other import — instrumentation needs to wrap Express/Prisma/Axios before they're loaded).
3. Auto-instrumentation gives you free spans for every HTTP call (in + out) and every Prisma query.
4. Ship traces to whatever Bachatt uses. If undecided, enable the console exporter to see the structure first, then switch.

**Done when:** a single "approve request" action produces one trace showing: incoming HTTP → Prisma queries → outgoing platform API (Redash or AWS) → outgoing Slack/SES, all under one trace ID.

---

# Smaller wins (open — each ~5–15 min)

The rest of the original tail list is done (see the note under the Done table). This remains:

- **Frontend inline styles**: lift the large inline-style objects in `Groups.tsx`, `GroupDetail.tsx`, `AdminManagement.tsx`, and `Dashboard.tsx` into the existing `frontend/src/styles/global.css` (CSS variables already defined there). You're already loading it; it's barely used. Scope is larger than originally estimated — Groups.tsx alone has 50+ inline style objects.

---

# Suggested order if you have ~1 evening a week

| Week | Items | Why |
|------|-------|-----|
| 1 | P2-3 + P2-4 | Lint + CI. Sets up the rails everything after rides on. Mechanical, low risk. |
| 2 | P2-5 | Operational visibility (audit filters) + quick UX cleanup. |
| 3+ | P2-1 (tests) | Biggest investment. Prioritize: access-workflow lifecycle, authz helpers, AWS provisioner sim, level-swap atomicity. |
| then | P2-2 | Bulk endpoints. Benefits from tests being in place to validate transaction correctness. |
| then | P3-4 | Split Groups.tsx + GroupDetail.tsx. Makes future changes and testing much easier. |
| then | P2-6 | SSE replaces harmless polling. Nice-to-have. |
| later | P3-5, P3-6 | OpenAPI + OTEL. Tooling/observability improvements. |
| defer | P3-2 (BullMQ + idempotency) | Adapter-level mitigations reduce urgency. Revisit when adding a third platform or deploying multi-instance. |
| ongoing | Win 2 (inline styles) | Chip away during other work — don't do as a standalone sprint. |

You can also just open a chat and say *"what should I do next?"* — Claude will read this doc + check git log to see what's been done and suggest one item.

---

# Notes for future Claude reading this doc

- The audit that produced the original list is in the chat history of session `claude/sleepy-mclean-c48446` (commit `36dbcad3`'s session). Revision 2026-06-01 re-verified at `42b20006`; revision 2026-06-11 re-verified at `107fbf03` (AWS adapter, levels, group CRUD, per-platform accounts all landed; P3-3 folded into P3-2; dev DB corrected from Supabase to local Docker Postgres).
- The user prefers to work directly on `main` — no worktrees, no feature branches. Any work goes into a clean `main` commit, then `git push`.
- The user is a solo dev. Don't suggest workflows that require multiple reviewers / PR templates / code-owners.
- When implementing an item, update this doc: move the row into the **Done** table with its commit SHA / evidence, and strike it through in the Quick index.
- Don't trust line numbers blindly — `Groups.tsx` and other large files drift. Grep for the pattern (e.g. `window.prompt`, `setInterval`) rather than jumping to a line.
- `access-workflow.service.ts` is now **52 KB** and `admin-management.controller.ts` is **46 KB** — the two largest backend files. When writing tests (P2-1), decompose test fixtures carefully rather than trying to import the whole service.
