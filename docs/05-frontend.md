# Frontend

React 19 + Vite + TypeScript SPA, no Tailwind — a custom CSS-variable design system
(`styles/global.css`; purple/white palette, status-badge colors, spacing/font tokens).

## Route map

| Path | Page | Purpose |
|---|---|---|
| `/` | `Dashboard` | Active access, pending-approval count, upcoming expirations, recent provision failures (super admin), account status |
| `/groups` | `Groups` | Browse groups per platform, bulk-submit access requests |
| `/groups/:slug` | `GroupDetail` | Group detail, members, admins, levels, request/renew UI |
| `/my-requests` | `MyRequests` | User's own requests across all groups |
| `/pending-approvals` | `PendingApprovals` | Admin review hub — account creation, access grants, ZK changes, secret ingestion; polls every 15s |
| `/admin` | `AdminManagement` | Group/member/admin CRUD, Redash resync/import, ZK ACL migration, secrets-group maintenance |
| `/audit-log` | `AuditLog` | Super-admin only; filterable audit log with drill-in detail |
| `/zookeeper` | `ZookeeperConfig` | Path tree browser, draft/submit/review znode changes |
| `/secrets` | `SecretIngestion` | Select secret, draft/submit/review key-value entries |

## Component inventory by domain (`components/`)

- **`access/`** — `AccessRequestModal`, `RenewAccessModal`, `PlatformInviteModal`
  (setup guidance), `PlatformInstanceModal` (pick prod vs QA when a platform has
  multiple instances).
- **`admin/`** — `GroupDrawer` (tabbed: Admins/Members/Levels/Settings) with its tab
  components (`GroupSettingsTab`, `GroupAdminsTab`, `GroupMembersTab`,
  `GroupLevelsTab`), `GroupFormModal`, `UserAccessModal` (cross-platform view +
  offboarding), `AddMemberModal`, `AssignAdminModal`, `ConfirmModal`, `UserPicker`,
  `RedashResyncModal` (mapping/count/safety-cap report).
- **`audit/`** — `AuditDetailModal`.
- **`common/`** — `ProtectedRoute`, `ErrorBoundary`, `LoadingSpinner`, `Skeleton`,
  `StatusBadge`, `ExpiryBadge`, `Modal`, `ReasonModal`, `CommandPalette` (Cmd/Ctrl+K),
  `ToastViewport`, `SectionHeader`, `EmptyState`, `PlatformTabs`, `SearchableSelect`.
- **`layout/`** — `MainLayout`, `Sidebar` (nav + pending-approval badge, 60s poll),
  `TopBar` (notification bell via SSE, user menu / role switcher in simulation mode).
- **`secrets/`** — `SecretIngestionApprovals` (pending table for `/pending-approvals`).
- **`user-creation/`** — `AccountStatusPanel` (per-platform lifecycle stepper),
  `UserCreationFormModal`, `UserApprovalsTable`.
- **`zookeeper/`** — `ZkChangeApprovals`, `ZkRow`, `TypeChip` (data-type badge).

## Auth & context

- **`AuthContext` (`useAuth()`)** — Keycloak in live mode, or mock role simulation when
  `VITE_KEYCLOAK_SIMULATION=true` and not production (mock tokens `super_admin |
  platform_admin | group_admin | user` in localStorage; role switch triggers a full page
  reload to re-auth). Exposes `roles`, `adminScopes` (`{ superAdmin, platforms, groups }`
  — mirrors `computeAdminScopes()` from the backend, see
  [02-auth-rbac.md](02-auth-rbac.md)), `hasZookeeperAccess`, `hasSecretsAccess`,
  `userCreation` status. Token auto-refreshes ~30s before expiry.
- **`NotificationContext` (`useNotifications()`)** — connects to the SSE stream
  (`/api/notifications/stream?token=`), reconnects with a 3s backoff on error, hydrates
  on connect to catch anything missed while disconnected.
- **`ToastContext` (`useToast()`)** — simple stack, max 4 visible, auto-dismiss
  (4s success/info, 6s error).
- **`ProtectedRoute`** — gates by either a simple `allowedRoles` array or a custom
  `allowIf` predicate over `adminScopes` (needed because `/pending-approvals` is visible
  to any admin tier but self-hides sections the viewer can't act on). Renders an inline
  "Access Denied" rather than throwing.

## API layer (`services/apiClient.ts` + `services/api/`)

Axios, `VITE_BASE_URL_BACKEND` base, 20s timeout. Request interceptor injects the Bearer
token (refreshing if <30s from expiry); response interceptor unwraps the backend's
`{ success, data }` envelope and throws a typed `ApiClientError` on `success: false`; a
401 triggers one refresh-and-retry before redirecting to Keycloak login.

React Query on top (`lib/queryClient.ts`, 30s default staleTime; query keys centralized
in `lib/queryKeys.ts` for prefix-invalidation).

API modules map close to 1:1 with backend controllers: `api/platforms.ts`,
`api/admin.ts`, `api/userCreation.ts`, `api/zookeeperApi.ts`, `api/secretsApi.ts`. Core
group/access-request/audit reads have no dedicated module — pages call `apiClient`
directly (`GET /api/groups`, `/api/user-access/me`, `/api/access-requests/my`,
`/api/access-requests/pending`, `/api/audit`).

## Notable frontend-only patterns

- **Multi-instance platforms** (Redash prod/QA): backend registry exposes `family` +
  `label` per platform; the Groups page shows an instance-picker modal only when a
  family has more than one live instance.
- **ZooKeeper drafts persist to `localStorage`** (`hermes_zk_drafts`) so switching tabs
  doesn't lose in-progress edits. **Secret ingestion entries are deliberately NOT
  persisted** — plaintext secret values shouldn't sit on disk.
- **Bulk access requests**: the Groups page allows multi-select + one submit, with
  shared or per-group justification and a single duration applied across the selection.

## Verifying changes locally

Before calling any frontend change done, run it in a browser (`npm run dev` in
`frontend/`) and exercise the actual flow — type-checking and lint don't verify UI
behavior. See [07-setup.md](07-setup.md) for how to get a working local stack (including
simulation mode, which lets you test role-gated UI without a live Keycloak).
