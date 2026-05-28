# Atlas — Post-P0 Roadmap

This is the implementation backlog for Atlas after the P0 fixes landed in commit `36dbcad3`. Each item has enough detail that you can paste a single section to Claude in a new chat and we can start.

---

## How to use this doc

When you want to tackle an item, open a new chat in `D:\Bachatt\Atlas 2` and paste something like:

> Implement **P1-1** from `ROADMAP.md` (Extract admin-check helper).

Claude will re-read this doc, read the relevant files, ask any clarifying questions, and implement. For larger items (P2-1 Tests, P3-1 Generalize provisioner) we may split across multiple chats to keep each commit focused — that's fine, just say "continue P3-1 step 2" in the next chat.

If you ever forget the IDs, just say "show me the roadmap" and Claude will read this file.

---

## What's already done (P0)

| # | Item | Where |
|---|------|-------|
| P0-1 | Keycloak token refresh (fixes 5-min vanish bug) | `frontend/src/contexts/AuthContext.tsx`, `frontend/src/services/apiClient.ts` |
| P0-2 | Replace stale unique index with partial unique | `backend/prisma/atlas/migrations/20260526120000_replace_user_access_unique/` |
| P0-3 | `Group.platform` enum → String to match DB | `backend/prisma/atlas/schema.prisma` |
| P0-4 | Removed hardcoded `--name init` from prisma:migrate | `backend/package.json` |
| P0-5 | Standardised auth-middleware error response shape | `backend/src/middleware/auth.middleware.ts` |
| P1-1 | Extracted `isGroupAdminOf` helper; collapsed 4 duplicated admin-check blocks into one call | `backend/src/utils/authz.ts`, `backend/src/controllers/user-access.controller.ts`, `backend/src/controllers/access-request.controller.ts` |
| P1-2 | Periodic Redash sync cron (15 min prod / 5 min dev) + `lastRedashSyncAt` on `/health` | `backend/src/services/scheduler.service.ts`, `backend/src/services/sync.service.ts`, `backend/src/index.ts` |

All in commit `36dbcad3`, on `main`, on `origin/main`.

**Before continuing**, run these once locally:

```powershell
cd D:\Bachatt\Atlas 2\backend
npm run prisma:migrate  
npx prisma generate --schema=prisma/atlas/schema.prisma
```

The first applies the new index. The second refreshes the generated Prisma client so `Group.platform` is now `string` and the old `userId_groupId_isActive` composite key is gone.

---

## Quick index — P1 through P3

| ID | Item | Effort | Risk |
|----|------|--------|------|
| **P1** | **Cleanup & drift (this week)** | | |
| ~~P1-1~~ | ~~Extract admin-check helper~~ — Done in `afeafccc` | S | Low |
| ~~P1-2~~ | ~~Periodic Redash sync~~ — Done (commit pending) | S | Low |
| P1-3 | Reconcile THREE_MONTHS duration | XS | Low |
| P1-4 | Add .env.example files | XS | Low |
| P1-5 | Frontend data-fetching hook | M | Low |
| **P2** | **Hardening (next sprint)** | | |
| P2-1 | Tests (vitest) | L | Low |
| P2-2 | Bulk endpoints | M | Low |
| P2-3 | Backend lint + Prettier | S | Low |
| P2-4 | CI on push | M | Low |
| P2-5 | Audit log filtering | S | Low |
| P2-6 | Replace polling with SSE | M | Med |
| **P3** | **Architecture for scale** | | |
| P3-1 | Generalize provisioner pattern | L | Med |
| P3-2 | Event bus → BullMQ | L | Med |
| P3-3 | Idempotency keys on provisioning | M | Med |
| P3-4 | Split Groups.tsx | M | Low |
| P3-5 | OpenAPI spec from Zod | M | Low |
| P3-6 | OpenTelemetry traces | M | Low |

Effort: XS ≈ 15 min · S ≈ 1–2 h · M ≈ half day · L ≈ 1–2 days. Risk = chance of breaking existing flows.

---

# P1 — Cleanup & drift (do this week)

## P1-1 — Extract admin-check helper

**Why:** the same "is this user a group admin of this group?" block is copy-pasted in four places. A bug fixed in one won't propagate. This is also the highest-touch code path for security, so duplication is risky.

**Files where it appears (each one greps `groupAdmin.findUnique` paired with `checkIsGroupAdmin`):**
- `backend/src/controllers/user-access.controller.ts:36-60` (`getGroupAccessList`)
- `backend/src/controllers/user-access.controller.ts:95-115` (`revokeAccess`)
- `backend/src/controllers/access-request.controller.ts:152-167` (`getRequestDetail`)
- `backend/src/controllers/access-request.controller.ts:199-216` (`reviewRequest`)

**Approach:**
1. Add `isGroupAdminOf(user, groupId): Promise<boolean>` to `backend/src/middleware/auth.middleware.ts` (or a new `backend/src/utils/authz.ts` if you prefer to keep middleware lean). Behaviour:
   - returns `true` if user has `atlas_super_admin`
   - else if user has `atlas_group_admin` AND either has a `GroupAdmin` DB row for that group, OR has a `atlas_group_admin_<slug>` Keycloak role matching the group's slug → `true`
   - else `false`
2. Replace the four blocks. Each becomes ~2 lines: call helper, throw `AuthorizationError` if false.
3. (Optional) Also expose `requireGroupAdmin(groupIdParam: string)` as an Express middleware so route definitions can do the check before reaching the controller. Useful for the `revokeAccess` route which already needs the group id from the access row.

**Done when:**
- `grep -r 'groupAdmin.findUnique' backend/src/controllers/` returns nothing (only the helper itself, in `auth.middleware.ts` or `utils/authz.ts`).
- All four endpoints still allow / reject the same cases as before: super admin, DB-only group admin, Keycloak-only group admin, non-admin, requester themselves.

---

## P1-2 — Periodic Redash sync

**Why:** sync only happens on backend boot ([`backend/src/app.ts:32-38`](backend/src/app.ts)). If a Redash user is added or disabled during the day, Atlas's cached `redash_users` / `redash_groups` drift until restart. This makes `checkUserStatus` and the "invite missing user" flow unreliable, which is what the user-facing "Create Redash Account" banner depends on.

**Files:**
- `backend/src/services/scheduler.service.ts` — add a second cron job.
- `backend/src/services/sync.service.ts` — already idempotent, just call `syncWithRedash()`.

**Approach:**
1. Extend `SchedulerService` with a second job alongside the existing expiry one:
   - Pattern: `*/15 * * * *` (every 15 min) in prod, `*/5 * * * *` in dev (gate via `config.isDev`).
   - Body: `await syncService.syncWithRedash()`. Wrap in try/catch; log errors but never throw — a transient Redash hiccup shouldn't crash the scheduler.
2. Log the next sync time on startup so you can see it's running.
3. Make sure both jobs are stopped on `SIGTERM` (extend the existing `stop()` method).
4. (Optional) Add `lastRedashSyncAt` to the `/health` response so you can see drift externally.

**Done when:**
- Backend log shows a sync line every 15 min in prod / 5 min in dev.
- Adding a user directly in the Redash UI shows up in Atlas's cache within 15 min without restart.

---

## P1-3 — Reconcile THREE_MONTHS duration

**Why:** the Prisma `AccessDuration` enum (`backend/prisma/atlas/schema.prisma:200-206`) has `THREE_MONTHS`, but no frontend dropdown exposes it. Dead value. Either remove it or wire it up.

**Recommend (B) — wire it up.** Less migration risk; users sometimes ask for a quarter.

**Option B files:**
- `frontend/src/components/access/AccessRequestModal.tsx:118-122` — add `<option value="THREE_MONTHS">3 Months</option>`.
- `frontend/src/pages/Groups.tsx:779-783` — same `<option>` in the bulk request panel.

**Option A (remove) is heavier:** Postgres enums can't drop a value cleanly. You'd either recreate the type or convert the column to text. If you want to remove it instead of expose it, ping Claude and we'll do the conversion safely.

**Done when:** "3 Months" appears in every place "1 Month" does, and a created request with `duration: 'THREE_MONTHS'` gets the correct +3-month expiry.

---

## P1-4 — Add .env.example files

**Why:** the real `.env` is the only source of truth for required vars. A fresh clone of the repo (or a teammate joining) has no template. Also, secrets shouldn't be tracked — `.env.example` is the right home for "here's the shape, fill in your own values".

**Files to create:**
- `backend/.env.example`
- `frontend/.env.example`

**Content:** copy the current `.env` files structurally; replace any secret value (`KEYCLOAK_ADMIN_PASSWORD`, `REDASH_API_KEY`, `SLACK_WEBHOOK_URL`, `AWS_*`) with `<set-me>` or an empty string. Add a comment header per section explaining required vs optional.

**Verify .gitignore:**
- `*.env` or `.env` is ignored (it currently shouldn't be tracked but verify).
- `.env.example` is NOT ignored.

**Done when:** running `cp backend/.env.example backend/.env && cp frontend/.env.example frontend/.env` on a fresh clone gives a runnable starting point (after filling in secrets).

---

## P1-5 — Frontend data-fetching hook (React Query)

**Why:** every page (`Dashboard.tsx`, `Groups.tsx`, `MyRequests.tsx`, `PendingApprovals.tsx`, `GroupDetail.tsx`, `AuditLog.tsx`) reimplements the same `useState + useEffect + isLoading + try/catch` pattern. Each navigation re-fetches; nothing is cached. After every mutation (`approve`, `revoke`, `create request`) there's a manual `fetchX()` call to refresh — easy to forget.

**Recommended: TanStack Query (React Query).** ~13kb gzipped; industry standard; built-in retry/cache/refetch-on-focus.

**Approach:**
1. `cd frontend && npm install @tanstack/react-query`.
2. In `frontend/src/main.tsx`, wrap `<App />` in `<QueryClientProvider client={queryClient}>` where `queryClient` is a single module-level instance.
3. Replace each page's fetch boilerplate. Example for `Groups.tsx`:
   ```ts
   const { data: groups = [], isLoading, refetch } = useQuery({
     queryKey: ['groups'],
     queryFn: () => apiClient.get('/api/groups').then(r => r.data),
   });
   ```
4. Mutations use `useMutation` and invalidate relevant queries on success — removes the manual `fetchGroups()` / `fetchPending()` after every action.
   ```ts
   const createRequestMutation = useMutation({
     mutationFn: (body) => apiClient.post('/api/access-requests', body),
     onSuccess: () => queryClient.invalidateQueries({ queryKey: ['groups'] }),
   });
   ```
5. Delete the now-unused `isLoading` state, `useEffect` fetch blocks, and `fetch*()` helpers.

**Bonus:** install `@tanstack/react-query-devtools` for visibility — toggle in dev only.

**Done when:**
- No direct `apiClient.get(...)` inside `useEffect` in any page.
- Navigating `Groups → GroupDetail → Groups` doesn't re-fetch the groups list (you see cached state instantly, then a background refetch if stale).
- After approving a request, the pending list updates without a manual `await fetchPending()` line.

---

# P2 — Hardening (next sprint)

## P2-1 — Tests (vitest)

**Why:** zero test coverage today. The access workflow (request → approve → provision → revoke → expire) is the riskiest code and has the most state transitions. Regressions here will silently break authorization.

**Stack:**
- **vitest** for both backend and frontend (same runner, simpler than jest + babel).
- **@testcontainers/postgresql** for backend integration tests against a real Postgres (not SQLite — Prisma's behaviour differs).
- **@testing-library/react** for component tests.

**Backend tests, in priority order:**
1. **Unit:** `AccessWorkflowService.calculateExpiry` — pure function, easy first win.
2. **Integration (high-value):** full lifecycle
   - Seed: a group + a regular user.
   - `createRequest()` → assert request row exists with status PENDING, audit entry created.
   - `reviewRequest(id, reviewer, 'APPROVED')` → assert PROVISIONED + UserAccess row + audit entry + event emitted.
   - Advance system clock OR call `expireAccess(userAccessId)` directly → assert UserAccess.isActive=false + access request status=EXPIRED + audit entry.
3. **Failure paths:**
   - Re-requesting access when already active → ConflictError.
   - Approving as wrong group admin → AuthorizationError.
   - Provisioner throwing → request goes to PROVISION_FAILED, audit entry includes error.

**Frontend tests:**
1. `AuthContext` simulation-mode role switcher (no Keycloak needed).
2. Each page renders without crashing given a mocked `apiClient`.
3. (Stretch) one Playwright/Cypress happy-path end-to-end run.

**Done when:**
- `npm test` runs in <60 s and covers grant/revoke/expire.
- The CI job (P2-4) fails on red tests.

---

## P2-2 — Bulk endpoints

**Why:** `Groups.tsx` bulk-requests N groups by firing N parallel HTTP calls. `PendingApprovals.tsx` does the same for review. Each call hits the DB independently, fires its own events, sends its own Slack ping — no transaction, partial failures are confusing, and Slack gets N pings for what should be one summary.

**Files:**
- `backend/src/routes/access-request.route.ts` — add `POST /bulk` and `PUT /bulk/review`.
- `backend/src/controllers/access-request.controller.ts` — new controller methods.
- `backend/src/services/access-workflow.service.ts` — `createRequestsBulk` and `reviewRequestsBulk` inside a single Prisma transaction.
- `frontend/src/pages/Groups.tsx` — replace the `Promise.allSettled(checkedGroupIds.map(...))` with a single call.
- `frontend/src/pages/PendingApprovals.tsx` — same for review.

**Approach:**
- Wrap in `prisma.$transaction(async (tx) => {...})`. If any item validates as a duplicate or violates an invariant, fail the whole batch and return per-item error details so the UI can show "3 succeeded, 2 had errors: ...".
- The event bus emits one summary event per bulk call (`requests.bulk.created` with `{requestIds[]}`) instead of N. Notification service formats it as one Slack message.
- Audit log gets one bulk audit entry referencing all the request IDs in `details`.

**Done when:** one HTTP call from the frontend; one transaction in the DB; one Slack message; one audit entry referencing all items.

---

## P2-3 — Backend lint + Prettier

**Files:**
- `backend/.eslintrc.cjs` or `backend/eslint.config.js`
- `backend/.prettierrc`
- `backend/package.json` — add `lint` and `format` scripts.

**Approach:** mirror the frontend's eslint config; add `@typescript-eslint/eslint-plugin` recommended rules. Turn on `@typescript-eslint/no-floating-promises` — your routes use `.catch(next)` everywhere; this rule will catch the missing ones.

**Done when:** `npm run lint` in `backend/` runs and either passes or produces an actionable list.

---

## P2-4 — CI on push

**File:** `.github/workflows/ci.yml` (new).

**Approach:**
- Trigger on PR to `main` + push to `main`.
- Jobs (in parallel where possible): `backend-typecheck`, `frontend-typecheck`, `backend-lint`, `frontend-lint`, `prisma-validate`, (eventually) `backend-tests`, `frontend-tests`.
- Use `actions/setup-node@v4` with Node 22 (matches `@types/node@22.15.19`).
- Cache `node_modules` keyed on `package-lock.json` hash and Prisma generation cache.

**Done when:** any push or PR shows a green/red CI status icon on GitHub.

---

## P2-5 — Audit log filtering

**Why:** `auditQuerySchema` (`backend/src/validations/audit.validation.ts`) only accepts `action` and `search`. When investigating an incident, the most common questions are "what happened on date X" and "what did user Y do" — neither of which the UI supports.

**Files:**
- `backend/src/validations/audit.validation.ts` — extend schema with `performerId`, `fromDate`, `toDate`, `groupId`.
- `backend/src/controllers/audit.controller.ts` — wire all filters into the `where` clause.
- `frontend/src/pages/AuditLog.tsx` — add filter UI (date pickers, performer search input, group dropdown).

**Done when:** filtering by `(performerId, fromDate, toDate)` correctly narrows the audit table.

---

## P2-6 — Replace polling with SSE

**Why:** `NotificationContext.tsx:76` polls `/api/notifications` every 60 s for every authenticated user. Wasteful, laggy, and gets worse as users grow.

**Approach:**
- Server: `GET /api/notifications/stream` using Server-Sent Events. The handler subscribes to the in-process event bus for `notification.*` events scoped to `req.user.id` and writes them to the response.
- Frontend: replace `setInterval(fetchNotifications, 60000)` with an `EventSource('/api/notifications/stream?token=' + keycloak.token)`. EventSource doesn't support custom headers, so token-as-query-param is the standard pattern; rotate on token refresh.
- Keep the initial `fetchNotifications()` call so the unread list is populated on mount.
- Watch for: connection drop reconnect logic (`EventSource` retries automatically with backoff, but token may have expired — handle 401 by closing and re-opening).

**Caveat:** if you later move to BullMQ (P3-2), the SSE handler needs to subscribe to the Redis queue events instead of the in-process emitter. Worth doing P3-2 first, or at least planning for it.

**Done when:** marking a notification as read in one tab updates an open tab in another within ~1 s, with no polling visible in the network tab.

---

# P3 — Architecture for scale (when adding AWS / Jira)

## P3-1 — Generalize the provisioner pattern

**Why:** today `redash_users` and `redash_groups` are Redash-specific tables. The seed hardcodes Redash group IDs (101–106). Adding AWS means duplicating tables and wrapper logic. The interface `PlatformAdapter` is already generic — only the storage layer leaks.

**Approach:**
1. New tables (one migration):
   - `platform_external_users` `(platform String, external_id String, email, name, is_disabled, last_synced_at, metadata Jsonb)` with `@@unique([platform, email])` and `@@unique([platform, external_id])`.
   - `platform_external_groups` `(platform String, external_id String, name, type, member_count, last_synced_at, metadata Jsonb)` with `@@unique([platform, external_id])`.
2. Migrate existing data: `INSERT INTO platform_external_users SELECT 'redash', id::text, email, name, is_disabled, last_synced_at, jsonb_build_object('groupIds', group_ids) FROM redash_users;` then drop `redash_users` / `redash_groups`.
3. Update `redash.provisioner.ts` and `sync.service.ts` to use the generic tables (filter `WHERE platform='redash'`).
4. Define an abstract `BaseProvisioner` so adding `AwsProvisioner` is just: implement the four methods on the interface.

**Done when:**
- A stub `AwsProvisioner` can be registered without changing the schema.
- `/health` shows all registered platforms.
- All existing Redash flows still work.

---

## P3-2 — Event bus → BullMQ (Redis-backed)

**Why:** in-process `EventEmitter` (`backend/src/services/event-bus.ts`) loses events on crash. A Slack ping failure is silently swallowed — no retry. As you add platforms and notification channels (email, MS Teams), this gets worse. Redis is already running in `docker-compose.yml` for Redash; reuse it.

**Approach:**
1. `npm i bullmq`.
2. Create a `backend/src/services/queue.ts` that exports a single `Queue('atlas-events')` instance pointing at `redis://redis:6379/1` (different DB than Redash so they don't collide).
3. Replace `eventBus.emitAccessEvent(...)` with `queue.add(eventType, payload)`.
4. Each consumer (notification, slack, audit) becomes a BullMQ `Worker` with retry/backoff config.
5. Failed jobs land in a dead-letter queue. Add a small admin endpoint `GET /api/admin/queues` returning `await queue.getJobCounts()` for visibility.
6. Update tests + bring up Redis in CI.

**Done when:**
- Stopping Slack mid-grant and restarting it: the notification is eventually delivered (not silently dropped).
- Crashing the backend mid-event-emit: the event is picked up on restart.

---

## P3-3 — Idempotency keys on provisioning

**Why:** if `redash.addUserToGroup` hangs after Redash applied the change but before returning, the workflow retries and the user gets double-added. Or it errors and the workflow rolls back even though Redash succeeded. Currently there's no way to tell.

**Approach:**
1. Add `provisioningKey String? @unique` to `AccessRequest` — a deterministic key like `req-${requestId}` (or `req-${requestId}-${attempt}` if you support retries).
2. Provisioner caches the result of `provision()` keyed by `provisioningKey` in a new `provisioning_attempts` table. On retry with the same key, return cached result instead of re-calling Redash.
3. For deprovisioning: same pattern keyed by `userAccessId`.
4. Add a job in BullMQ (depends on P3-2) that periodically reconciles: for every `UserAccess` marked active, verify membership exists in Redash; for every revoked, verify it's gone.

**Done when:** killing the backend mid-provision and restarting doesn't double-add or skip the user.

---

## P3-4 — Split Groups.tsx

**Why:** `frontend/src/pages/Groups.tsx` is ~840 lines. It does platform-grid + groups-table + bulk-request panel + 3 modals + reason-popover state management. Hard to test, hard to reason about, hard to onboard anyone to.

**Suggested decomposition:**
- `pages/Groups.tsx` — orchestrator only (~80 lines).
- `components/groups/PlatformGrid.tsx` — the 8-platform card grid (active vs coming-soon).
- `components/groups/GroupsTable.tsx` — the searchable table of groups for the active platform.
- `components/groups/BulkRequestPanel.tsx` — the bottom panel for justification + duration + submit.
- `components/groups/ReasonPopover.tsx` — the per-group reason popover.
- Selection + reasons state into a custom hook `useGroupSelection`.

**Done when:** no single file in `frontend/src/pages/` exceeds 300 lines.

---

## P3-5 — OpenAPI spec from Zod

**Why:** the validation schemas already exist in `backend/src/validations/*`. With `@asteasolutions/zod-to-openapi` you can derive an OpenAPI 3 spec, host it at `/api/docs`, and codegen a typed frontend client. Eliminates the manual `interface GroupData {...}` re-declarations in every frontend page.

**Files (new):**
- `backend/src/openapi.ts` — registry that wraps each Zod schema with `.openapi(...)` metadata.
- `backend/src/routes/docs.route.ts` — serves the JSON spec + Swagger UI at `/api/docs`.
- Frontend codegen via `openapi-typescript` (just types) or `orval` (types + a generated client).

**Done when:**
- `/api/docs` returns a browseable Swagger UI.
- The frontend imports generated types; changing a Zod schema in backend produces a TS error in frontend if the response shape diverges.

---

## P3-6 — OpenTelemetry traces

**Why:** pino logs are great for events but you can't follow a request's path across the backend → Prisma → Redash without OTEL.

**Approach:**
1. `npm i @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`.
2. Initialise in a new `backend/src/observability.ts` imported FIRST in `backend/src/app.ts` (before any other import — instrumentation needs to wrap Express/Prisma/Axios before they're loaded).
3. Auto-instrumentation gives you free spans for every HTTP call (in + out) and every Prisma query.
4. Ship traces to whatever Bachatt uses. If undecided, enable the console exporter to see the structure first, then switch.

**Done when:** a single "approve request" action produces one trace showing: incoming HTTP → Prisma queries → outgoing Redash API → outgoing Slack webhook, all under one trace ID.

---

# Smaller wins (do anytime — each ~5–15 min)

These came out of the audit but didn't merit their own P-number. Pick one when you have a stray 10 minutes.

- **`backend/src/middleware/error.middleware.ts`, `backend/src/services/scheduler.service.ts`, `backend/src/utils/errors.ts`**: switch `process.env.NODE_ENV === 'production'` checks to `config.isProd` (or `config.isDev`). Single source of truth.
- **`backend/src/services/redash.provisioner.ts:46-52`**: don't hardcode `groupIds: [1]` when caching newly invited users. Fetch the actual default group from Redash, or store `[]`.
- **`backend/src/services/scheduler.service.ts:51-57`**: parallelise `expireAccess` calls with `Promise.allSettled`. Sequential loop blocks if a backlog ever builds up.
- **`backend/src/index.ts:52-77` (`/health` endpoint)**: add a Redis ping. Redis is in `docker-compose.yml` but never health-checked from the API side.
- **`frontend/src/pages/GroupDetail.tsx:85`**: replace `window.prompt('Enter a reason')` with a proper modal for the revoke-reason input.
- **`frontend/src/components/layout/MainLayout.tsx`**: wrap children in a React `ErrorBoundary` so a single component crash doesn't blank the whole app.
- **Frontend inline styles**: lift the giant inline-style objects in `Groups.tsx` and `Dashboard.tsx` into the existing `frontend/src/styles/global.css`. You're already loading it; it's barely used.
- **`backend/src/services/notification.service.ts:39`**: extract the Slack message template strings to constants at the top of the file so the formatting is easy to change in one place.

---

# Suggested order if you have ~1 evening a week

| Week | Items | Why |
|------|-------|-----|
| 1 | P1-1 + P1-3 + P1-4 | All mechanical, low risk, big readability win. |
| 2 | P1-2 + P2-5 | Operational visibility — you'll notice drift and bad actors faster. |
| 3 | P1-5 | Frontend hook. Pays off every page from now on. |
| 4 | P2-3 + P2-4 | Lint + CI. Sets up the rails everything after this rides on. |
| 5–6 | P2-1 (tests) | Take as long as you need. Cover the access workflow first. |
| 7+ | Start picking from P2-2, P2-6, P3-* based on what hurts most. | |

You can also just open a chat and say *"what should I do next?"* — Claude will read this doc + check git log to see what's been done and suggest one item.

---

# Notes for future Claude reading this doc

- The audit that produced this list is in the chat history of session `claude/sleepy-mclean-c48446` (commit `36dbcad3`'s session).
- The user prefers to work directly on `main` — no worktrees, no feature branches. Any work goes into a clean `main` commit, then `git push`.
- The user is a solo dev. Don't suggest workflows that require multiple reviewers / PR templates / code-owners.
- When implementing an item, update this doc: tick the item as done in the quick index by replacing the row with `~~P1-1~~ Done in commit `<sha>``, and update the "What's already done" table at the top.
