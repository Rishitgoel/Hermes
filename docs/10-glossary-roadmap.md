# Glossary & roadmap

## Glossary

| Term | Meaning |
|---|---|
| **Group** | The unit a user requests access to; maps to a real group/path/pattern on one external platform. |
| **Level** | An optional permission tier within a group (e.g. "Intern" vs "Senior"), each backed by its own platform-side group so real permissions differ per tier. |
| **Grant** (`UserAccess`) | The actual provisioned access record — distinct from the `AccessRequest` that led to it. |
| **Adapter / Provisioner** | The per-platform implementation of `PlatformAdapter` that does the real API calls (AWS, Redash, ZooKeeper, Secrets). |
| **Registry** | `ProvisioningRegistry` — the single lookup point from platform key → adapter. |
| **Super / platform / group admin** | The three-tier RBAC model — see [02-auth-rbac.md](02-auth-rbac.md). |
| **Mirror table** | `PlatformAdmin`/`GroupAdmin` — DB copies of Keycloak role assignments, used as the actual source of truth for authorization checks. |
| **WAITING_FOR_SETUP** | An approved access request that can't provision yet because the user's platform *account* isn't `COMPLETED`. |
| **UserCreationRequest** | The gate on getting an *account* on a platform at all, separate from and prior to any group access request on that platform. |
| **Simulation mode** | Per-integration flag (Keycloak, each platform, Slack, email) that swaps the real client for an in-memory mock — the default locally. |
| **Family / instance** | A platform can have multiple deployed instances (Redash prod + QA) sharing a `family` for frontend grouping, each with its own registry key. |
| **Event bus** | In-process `EventEmitter` decoupling state changes from notifications/side-effects — fire-and-forget, no retry (see roadmap P3-2 below). |
| **Reconciliation** | Two distinct things, don't conflate them: **admin reconciliation** (Keycloak roles → DB mirrors) and **platform sync's group reconciliation** (external platform groups → Hermes `Group`/`GroupLevel` rows). |

## Roadmap snapshot

Full detail and "done when" criteria live in `ROADMAP.md` at the repo root — this is a
summary as of the doc's last verification (2026-06-11, commit `107fbf03`). **Check
`ROADMAP.md` directly for anything current** — it's actively maintained and this snapshot
will go stale.

All **P2 (hardening)** items are done: tests, bulk endpoints, backend lint/Prettier, CI
on push, audit log filtering, SSE notifications.

Open **P3 (architecture for scale)** items:

| ID | Item | Effort | Why it's not urgent yet |
|---|---|---|---|
| P3-2 | Event bus → BullMQ/Redis + idempotency keys | L | Both live adapters already handle conflicts inline (idempotent add/remove); the main remaining gap is silently-dropped Slack/email on send failure. Revisit when adding a third platform or deploying multi-instance. |
| P3-4 | Split large frontend pages (`Groups.tsx` 858 lines, `PendingApprovals.tsx` 526, `GroupDetail.tsx` 467, `AdminManagement.tsx` 364) | M | Not urgent, but the biggest quality-of-life win for anyone extending these pages. |
| P3-5 | Generate an OpenAPI spec from the existing Zod validation schemas | M | Would remove the manual TS interface duplication between backend and frontend. |
| P3-6 | OpenTelemetry tracing across backend → Prisma → platform APIs | M | Call graphs are already multi-hop (approve → Keycloak + platform + Slack + SES); tracing would help debug latency/failures across that chain. |

One smaller open item: lift the ~50+ inline style objects in `Groups.tsx`/`GroupDetail.tsx`/`AdminManagement.tsx`/`Dashboard.tsx`
into the existing `styles/global.css` CSS variables.

## Working conventions (from `ROADMAP.md`, still current)

- This is a **solo-dev repo**: commits go straight to `main`, no branches/PRs, no
  code-owner workflow. (Admin-panel is the opposite — see
  [06-admin-panel-sync.md](06-admin-panel-sync.md).)
- `access-workflow.service.ts` (~52 KB) and `admin-management.controller.ts` (~46 KB) are
  the two largest backend files — when adding tests or making structural changes,
  decompose fixtures carefully rather than importing the whole service.
- Don't trust hardcoded line numbers from old notes for large frontend files — grep for
  the actual pattern instead.
