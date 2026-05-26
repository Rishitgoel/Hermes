# Atlas — Company Internal Platform

## Product Requirements Document (PRD) — v3 (MVP)

---

## 1. Executive Summary

**Atlas** is a company-wide internal platform for Bachatt. Access management is its first feature module, with additional features planned for future versions.

**MVP Scope:** Redash access management — a group-centric workflow where employees request access to predefined groups (Growth, Retention, Lending, Credit Card), admins approve/reject, and Atlas auto-provisions via Redash API. Built on the same foundation as Apollo.

### Key Decisions

| Decision | Answer |
|----------|--------|
| Notifications | Simple Slack ping to admin/group admin + in-app notification. Email deferred to v2 |
| Auto-provisioning | Yes, via Redash API on approval |
| Import existing users | Yes — sync on first setup |
| Multi-tenancy | Single Redash instance |
| Access review cadence | Deferred to v2 |
| Communication | **One-way: Atlas → Redash only** |
| Keycloak setup | Auto-configure client + roles via Keycloak Admin API |
| Redash API key | Existing admin account; dummy key for development |
| Scope | **MVP — core functionality only** |

### What's IN the MVP

- ✅ Keycloak login (auto-configured client via Admin API)
- ✅ Browse groups (Growth, Retention, Lending, Credit Card)
- ✅ Request access to a group (with justification + duration)
- ✅ Admin/group admin approval queue (approve/reject with note)
- ✅ Auto-provisioning to Redash (add user to group via API)
- ✅ Auto-revocation on expiry (scheduler)
- ✅ Simple Slack notification ping to admins (just a link to approve in Atlas)
- ✅ In-app notifications (bell icon with count)
- ✅ My Access / My Requests pages
- ✅ Basic audit log (who did what, when)
- ✅ Import existing Redash users/groups on setup

### What's DEFERRED to v2+

- ❌ Email notifications (Nodemailer templates)
- ❌ Rich Slack Block Kit messages
- ❌ CSV export of audit logs
- ❌ Advanced dashboard analytics / charts
- ❌ Access review cadence (quarterly reviews)
- ❌ Settings UI for service configuration
- ❌ Multiple Redash instances
- ❌ Other services (Jira, AWS, Azure, GCP, Grafana, GitHub, Apollo)

---

## 2. Apollo Architecture — Reused Patterns

| Pattern | Source |
|---------|--------|
| **Base Controller** — `ApiResponse`, validation, pagination | [base.controller.ts](file:///d:/Bachatt/admin-panel-main/backend/src/controllers/base.controller.ts) |
| **Keycloak Auth** — JWKS validation + role mapping | [auth.middleware.ts](file:///d:/Bachatt/admin-panel-main/backend/src/middleware/auth.middleware.ts) |
| **Audit Logging** — MongoDB audit trail for mutations | [audit.middleware.ts](file:///d:/Bachatt/admin-panel-main/backend/src/middleware/audit.middleware.ts) |
| **Security Stack** — Helmet, rate limiting, error handling | [security.middleware.ts](file:///d:/Bachatt/admin-panel-main/backend/src/middleware/security.middleware.ts) |
| **API Client** — Axios + Keycloak token injection | [apiClient.ts](file:///d:/Bachatt/admin-panel-main/frontend/src/services/apiClient.ts) |
| **Layout System** — Sidebar + TopBar + scrollable content | [MainLayout.tsx](file:///d:/Bachatt/admin-panel-main/frontend/src/components/layout/MainLayout.tsx) |
| **Secrets** — AWS Secrets Manager (prod), `.env` (dev) | [secrets.ts](file:///d:/Bachatt/admin-panel-main/backend/src/config/secrets.ts) |
| **External API** — typed service classes wrapping API clients | [jira.service.ts](file:///d:/Bachatt/admin-panel-main/backend/src/services/jira.service.ts) |

---

## 3. Core Workflow

### 3.1 User Flow (MVP)

```
1. LOGIN
   └─▶ User authenticates via Keycloak SSO

2. BROWSE GROUPS
   └─▶ User sees group cards:
       ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌─────────────┐
       │  Growth   │  │ Retention │  │ Lending  │  │ Credit Card │
       │           │  │           │  │          │  │             │
       │ [Request] │  │ [Request] │  │ [Request]│  │  [Request]  │
       └──────────┘  └───────────┘  └──────────┘  └─────────────┘

3. REQUEST ACCESS
   └─▶ User clicks "Request Access"
   └─▶ Fills: justification + duration
   └─▶ Status: PENDING

4. ADMINS NOTIFIED
   └─▶ Group admin: in-app notification 🔔 + Slack ping 💬
   └─▶ Super admin: in-app notification 🔔 + Slack ping 💬
   └─▶ Slack message: "[User] requested access to [Group] — Review in Atlas: [link]"

5. APPROVAL
   └─▶ Admin opens Pending Approvals in Atlas
   └─▶ Approves or Rejects (with note)
   └─▶ If APPROVED → Atlas auto-provisions in Redash via API
   └─▶ If REJECTED → User notified in-app
   └─▶ Requester gets in-app notification + Slack ping

6. ACCESS ACTIVE
   └─▶ User can now query tables in their group
   └─▶ Time-bound access auto-expires via hourly cron

7. REVOCATION
   └─▶ Admin-initiated or auto-expiry
   └─▶ Atlas removes user from Redash group via API
   └─▶ User notified in-app + Slack
```

### 3.2 One-Way Communication

```
┌──────────┐                     ┌──────────┐
│  ATLAS   │ ─── API calls ───▶  │  REDASH  │
│          │                     │          │
│  Source   │   • invite user    │  Target   │
│  of truth │   • add to group   │  system   │
│  for      │   • remove from    │           │
│  access   │     group          │  No direct│
│  mgmt     │   • disable user   │  access   │
│          │                     │  mgmt     │
└──────────┘                     └──────────┘
```

---

## 4. User Roles

| Role | Who | Can Do |
|------|-----|--------|
| `atlas_super_admin` | IT / Platform team | Everything: manage groups, approve any request, assign group admins, view audit |
| `atlas_group_admin` | Team leads | Approve/deny requests for their groups, view their group's members |
| `atlas_user` | All employees | Browse groups, request access, view own access + requests |

**Keycloak auto-configuration:** On first startup, Atlas backend will use the Keycloak Admin API to:
1. Create client `atlas-prod` if it doesn't exist
2. Create realm roles `atlas_super_admin`, `atlas_group_admin`, `atlas_user`
3. Assign `atlas_user` as a default role for the realm

---

## 5. Database Schema (Prisma)

```prisma
// prisma/atlas/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL_ATLAS")
}

generator client {
  provider = "prisma-client-js"
  output   = "../../generated/atlas"
}

// ══════════════════════════════════════════
// GROUPS
// ══════════════════════════════════════════

model Group {
  id               String           @id @default(uuid())
  name             String           @unique            // "Growth", "Retention"
  slug             String           @unique            // "growth", "retention"
  description      String                              // What tables/data this gives access to
  icon             String?                              // Lucide icon name
  color            String?                              // Hex color for card
  externalGroupId  String?          @map("external_group_id")  // Redash group ID
  isActive         Boolean          @default(true) @map("is_active")
  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")

  admins           GroupAdmin[]
  accessRequests   AccessRequest[]
  userAccesses     UserAccess[]

  @@map("groups")
}

model GroupAdmin {
  id               String           @id @default(uuid())
  groupId          String           @map("group_id")
  userId           String           @map("user_id")           // Keycloak user ID
  userName         String           @map("user_name")
  userEmail        String           @map("user_email")
  assignedAt       DateTime         @default(now()) @map("assigned_at")
  assignedBy       String           @map("assigned_by")

  group            Group            @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([groupId, userId])
  @@map("group_admins")
}

// ══════════════════════════════════════════
// ACCESS REQUESTS
// ══════════════════════════════════════════

model AccessRequest {
  id               String           @id @default(uuid())
  groupId          String           @map("group_id")

  // Requester (from Keycloak token)
  requesterId      String           @map("requester_id")
  requesterName    String           @map("requester_name")
  requesterEmail   String           @map("requester_email")

  // Request
  justification    String
  duration         AccessDuration   @default(PERMANENT)
  expiresAt        DateTime?        @map("expires_at")

  // Review
  status           RequestStatus    @default(PENDING)
  reviewerId       String?          @map("reviewer_id")
  reviewerName     String?          @map("reviewer_name")
  reviewNote       String?          @map("review_note")
  reviewedAt       DateTime?        @map("reviewed_at")

  // Provisioning
  provisionedAt    DateTime?        @map("provisioned_at")
  provisionError   String?          @map("provision_error")
  revokedAt        DateTime?        @map("revoked_at")
  revokeReason     String?          @map("revoke_reason")

  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")

  group            Group            @relation(fields: [groupId], references: [id])
  auditEntries     AuditEntry[]

  @@index([requesterId])
  @@index([status])
  @@index([groupId, status])
  @@index([expiresAt])
  @@map("access_requests")
}

// ══════════════════════════════════════════
// USER ACCESS (source of truth)
// ══════════════════════════════════════════

model UserAccess {
  id               String           @id @default(uuid())
  userId           String           @map("user_id")
  userName         String           @map("user_name")
  userEmail        String           @map("user_email")
  groupId          String           @map("group_id")
  externalUserId   String?          @map("external_user_id")  // Redash user ID

  isActive         Boolean          @default(true) @map("is_active")
  grantedAt        DateTime         @default(now()) @map("granted_at")
  expiresAt        DateTime?        @map("expires_at")
  revokedAt        DateTime?        @map("revoked_at")

  grantedBy        String           @map("granted_by")
  accessRequestId  String?          @map("access_request_id")

  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")

  group            Group            @relation(fields: [groupId], references: [id])

  @@unique([userId, groupId, isActive])
  @@index([expiresAt, isActive])
  @@map("user_accesses")
}

// ══════════════════════════════════════════
// NOTIFICATIONS (in-app)
// ══════════════════════════════════════════

model Notification {
  id               String           @id @default(uuid())
  userId           String           @map("user_id")
  title            String
  message          String
  linkUrl          String?          @map("link_url")
  isRead           Boolean          @default(false) @map("is_read")
  createdAt        DateTime         @default(now()) @map("created_at")

  @@index([userId, isRead])
  @@map("notifications")
}

// ══════════════════════════════════════════
// AUDIT LOG
// ══════════════════════════════════════════

model AuditEntry {
  id               String           @id @default(uuid())
  action           String                                     // "REQUEST_CREATED", "APPROVED", etc.
  performerId      String           @map("performer_id")
  performerName    String           @map("performer_name")
  targetUserId     String?          @map("target_user_id")
  targetUserName   String?          @map("target_user_name")
  groupId          String?          @map("group_id")
  accessRequestId  String?          @map("access_request_id")
  details          Json?
  ipAddress        String?          @map("ip_address")
  createdAt        DateTime         @default(now()) @map("created_at")

  accessRequest    AccessRequest?   @relation(fields: [accessRequestId], references: [id])

  @@index([performerId])
  @@index([action])
  @@index([createdAt])
  @@map("audit_entries")
}

// ══════════════════════════════════════════
// REDASH CACHE (synced from Redash on setup)
// ══════════════════════════════════════════

model RedashUser {
  id               Int              @id
  name             String
  email            String           @unique
  isDisabled       Boolean          @default(false) @map("is_disabled")
  groupIds         Int[]            @map("group_ids")
  lastSyncedAt     DateTime         @map("last_synced_at")
  createdAt        DateTime         @default(now()) @map("created_at")

  @@map("redash_users")
}

model RedashGroup {
  id               Int              @id
  name             String
  type             String
  memberCount      Int              @default(0) @map("member_count")
  lastSyncedAt     DateTime         @map("last_synced_at")
  createdAt        DateTime         @default(now()) @map("created_at")

  @@map("redash_groups")
}

// ══════════════════════════════════════════
// ENUMS
// ══════════════════════════════════════════

enum AccessDuration {
  ONE_DAY
  ONE_WEEK
  ONE_MONTH
  THREE_MONTHS
  PERMANENT
}

enum RequestStatus {
  PENDING
  APPROVED
  REJECTED
  PROVISIONING
  PROVISIONED
  PROVISION_FAILED
  EXPIRED
  REVOKED
}
```

---

## 6. Backend API Contracts (MVP)

### Auth
```
GET    /auth/me                                   # Current user info + roles
```

### Groups
```
GET    /api/groups                                 # List all groups (with member count, user's access status)
GET    /api/groups/:slug                           # Group detail + members
```

### Access Requests
```
POST   /api/access-requests                       # Create request (user)
GET    /api/access-requests/my                    # My request history (user)
GET    /api/access-requests/pending               # Pending queue (admin/group admin)
GET    /api/access-requests/:id                   # Request detail
PUT    /api/access-requests/:id/review            # Approve or reject (admin/group admin)
```

### User Access
```
GET    /api/user-access/me                        # My active accesses (user)
GET    /api/user-access/group/:groupId            # Group members (admin/group admin)
DELETE /api/user-access/:id                       # Revoke access (admin)
```

### Notifications
```
GET    /api/notifications                         # My notifications
PUT    /api/notifications/:id/read                # Mark as read
PUT    /api/notifications/read-all                # Mark all read
GET    /api/notifications/unread-count            # Badge count
```

### Audit
```
GET    /api/audit                                 # Search audit log (admin)
```

### Admin
```
POST   /api/admin/sync                            # Trigger Redash sync (super admin)
```

---

## 7. Frontend Pages (MVP)

### Sidebar Navigation

```
📊 Dashboard
──────────────────
🏢 Groups
──────────────────
📋 My Requests
🔐 My Access
──────────────────
✅ Pending Approvals (3)     ← admin only
──────────────────
📜 Audit Log                  ← admin only
```

### Pages

| Page | Who | What |
|------|-----|------|
| **Dashboard** | Everyone | Group cards grid + quick stats (pending count, active access count) |
| **Groups** | Everyone | Browse groups, see "Request" / "Pending" / "Active" status per group |
| **Group Detail** | Everyone | Group info, current members list, request access button |
| **My Requests** | Everyone | Table of user's requests with status badges |
| **My Access** | Everyone | Cards showing active group access with expiry info |
| **Pending Approvals** | Admin/Group Admin | List of pending requests with approve/reject actions |
| **Audit Log** | Admin | Filterable table of all actions |

### Dashboard Wireframe

```
┌─────────────────────────────────────────────────────────┐
│  Atlas                                       🔔 (3)  👤 │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │ 3 Pending  │  │ 2 Active   │  │ 47 Users   │         │
│  │ Requests   │  │ Accesses   │  │ Total      │         │
│  └────────────┘  └────────────┘  └────────────┘         │
│                                                          │
│  ─── Groups ────────────────────────────────────        │
│                                                          │
│  ┌───────────────┐  ┌───────────────┐                   │
│  │ 📈 Growth      │  │ 🔄 Retention   │                   │
│  │ Marketing,     │  │ Churn, Engage- │                   │
│  │ Funnel, Acq    │  │ ment, Lifecycle│                   │
│  │ 12 members     │  │ 8 members      │                   │
│  │ [✓ Active]     │  │ [Request ▶]    │                   │
│  └───────────────┘  └───────────────┘                   │
│                                                          │
│  ┌───────────────┐  ┌───────────────┐                   │
│  │ 💰 Lending     │  │ 💳 Credit Card │                   │
│  │ Loans, Under-  │  │ CC txns,       │                   │
│  │ writing, EMI   │  │ Rewards, Bills │                   │
│  │ 6 members      │  │ 5 members      │                   │
│  │ [⏳ Pending]   │  │ [Request ▶]    │                   │
│  └───────────────┘  └───────────────┘                   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 8. Slack Notifications (Simple)

Slack integration is a simple ping — not rich interactive messages. Just a text notification with a link:

```
📋 Atlas Access Request
──────────────────────────
Ankit Sharma requested access to Growth group.
Reason: "Need access for Q3 campaign analysis"
Duration: 1 month

👉 Review in Atlas: https://atlas.bachatt.app/pending-approvals
```

Implementation: single `SLACK_WEBHOOK_URL` env var → `SlackService.sendPing(message, url)` — a simple `axios.post()` to the webhook.

---

## 9. Redash Integration (One-Way)

### RedashService (MVP Methods)

```typescript
class RedashService {
  // Sync (import existing data on setup)
  syncUsers(): Promise<void>         // GET /api/users → cache
  syncGroups(): Promise<void>        // GET /api/groups → cache

  // Provisioning (called on approval)
  addUserToGroup(redashUserId: number, redashGroupId: number): Promise<void>
  removeUserFromGroup(redashUserId: number, redashGroupId: number): Promise<void>

  // User lookup
  findOrInviteUser(email: string, name: string): Promise<number>  // returns Redash user ID
  disableUser(redashUserId: number): Promise<void>
}
```

### Provisioning Flow

```
AccessRequest APPROVED
    │
    ├─ Find user in Redash cache by email
    │   ├─ EXISTS → get Redash user ID
    │   └─ NOT FOUND → RedashService.findOrInviteUser() → new ID
    │
    ├─ RedashService.addUserToGroup(userId, group.externalGroupId)
    │
    ├─ Update AccessRequest → PROVISIONED
    ├─ Create UserAccess record
    ├─ Create AuditEntry
    ├─ Create in-app Notification for requester
    └─ SlackService.ping(requester, "Access approved for [Group]")
```

### Auto-Revocation (Hourly Cron)

```
Every hour:
  └─ Find UserAccess WHERE expiresAt < now() AND isActive = true
  └─ For each:
      ├─ RedashService.removeUserFromGroup()
      ├─ UserAccess → isActive: false
      ├─ AccessRequest → EXPIRED
      ├─ AuditEntry → ACCESS_EXPIRED
      ├─ In-app notification to user
      └─ Slack ping to user
```

---

## 10. Keycloak Auto-Configuration

On backend startup, Atlas calls the Keycloak Admin API to ensure its client and roles exist:

```typescript
class KeycloakSetupService {
  async ensureClientExists(): Promise<void> {
    // 1. Get admin token via client credentials grant
    // 2. Check if client "atlas-prod" exists in master realm
    // 3. If not, create it with:
    //    - clientId: "atlas-prod"
    //    - publicClient: true
    //    - redirectUris: ["https://atlas.bachatt.app/*", "http://localhost:5174/*"]
    //    - webOrigins: ["+"]
  }

  async ensureRolesExist(): Promise<void> {
    // Create realm roles if they don't exist:
    // - atlas_super_admin
    // - atlas_group_admin
    // - atlas_user (set as default)
  }
}
```

Environment for Keycloak Admin API:
```env
KEYCLOAK_ADMIN_URL=https://keycloak.bachatt.app
KEYCLOAK_ADMIN_CLIENT_ID=admin-cli
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_ADMIN_PASSWORD=<from-secrets-manager>
```

---

## 11. Project Structure (MVP)

```
atlas/
├── backend/
│   ├── src/
│   │   ├── app.ts                            # Entry: secrets → keycloak setup → index
│   │   ├── index.ts                          # Express, middleware, routes
│   │   │
│   │   ├── config/
│   │   │   ├── prisma.ts                     # Atlas DB client
│   │   │   ├── secrets.ts                    # AWS Secrets Manager / .env
│   │   │   └── keycloak-setup.ts             # Auto-configure Keycloak client + roles
│   │   │
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts             # Keycloak JWKS (from Apollo)
│   │   │   ├── error.middleware.ts            # Error handling (from Apollo)
│   │   │   └── security.middleware.ts         # Helmet, rate limiting (from Apollo)
│   │   │
│   │   ├── controllers/
│   │   │   ├── base.controller.ts            # BaseController (from Apollo)
│   │   │   ├── group.controller.ts           # Browse + manage groups
│   │   │   ├── access-request.controller.ts  # Request + review lifecycle
│   │   │   ├── user-access.controller.ts     # Active access management
│   │   │   ├── notification.controller.ts    # In-app notification CRUD
│   │   │   ├── audit.controller.ts           # Audit log queries
│   │   │   └── admin.controller.ts           # Sync trigger
│   │   │
│   │   ├── services/
│   │   │   ├── redash.service.ts             # Redash API client (one-way)
│   │   │   ├── access-workflow.service.ts    # Request lifecycle engine
│   │   │   ├── notification.service.ts       # In-app + Slack orchestrator
│   │   │   ├── slack.service.ts              # Simple webhook ping
│   │   │   ├── scheduler.service.ts          # Cron: auto-revocation
│   │   │   └── sync.service.ts              # Import Redash users/groups
│   │   │
│   │   ├── routes/
│   │   │   ├── auth.route.ts
│   │   │   ├── group.route.ts
│   │   │   ├── access-request.route.ts
│   │   │   ├── user-access.route.ts
│   │   │   ├── notification.route.ts
│   │   │   ├── audit.route.ts
│   │   │   └── admin.route.ts
│   │   │
│   │   ├── types/
│   │   │   └── access.types.ts
│   │   │
│   │   ├── validations/
│   │   │   ├── access-request.validation.ts
│   │   │   └── group.validation.ts
│   │   │
│   │   └── utils/
│   │       ├── logger.ts                     # Pino (from Apollo)
│   │       └── errors.ts                     # Error classes (from Apollo)
│   │
│   ├── prisma/
│   │   └── atlas/
│   │       ├── schema.prisma
│   │       └── seed.ts                       # Seed initial groups
│   ├── Dockerfile
│   ├── ecosystem.config.js
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── MainLayout.tsx
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   └── TopBar.tsx                # With notification bell
│   │   │   ├── common/
│   │   │   │   ├── ProtectedRoute.tsx
│   │   │   │   ├── StatusBadge.tsx
│   │   │   │   ├── DataTable.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   ├── GroupCard.tsx
│   │   │   │   ├── NotificationBell.tsx
│   │   │   │   └── LoadingSpinner.tsx
│   │   │   └── access/
│   │   │       ├── AccessRequestModal.tsx
│   │   │       └── ApprovalCard.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Groups.tsx
│   │   │   ├── GroupDetail.tsx
│   │   │   ├── MyRequests.tsx
│   │   │   ├── MyAccess.tsx
│   │   │   ├── PendingApprovals.tsx
│   │   │   └── AuditLog.tsx
│   │   ├── contexts/
│   │   │   ├── AuthContext.tsx
│   │   │   └── NotificationContext.tsx
│   │   ├── services/
│   │   │   ├── keycloak.ts
│   │   │   └── apiClient.ts
│   │   ├── hooks/
│   │   │   ├── useGroups.ts
│   │   │   ├── useAccessRequests.ts
│   │   │   └── useNotifications.ts
│   │   ├── types/
│   │   │   └── access.types.ts
│   │   └── styles/
│   │       └── global.css
│   ├── package.json
│   └── vite.config.ts
│
├── docker-compose.yml
└── README.md
```

---

## 12. Environment Variables (MVP)

```env
# ── App ──
NODE_ENV=development
PORT=8001

# ── Database ──
DATABASE_URL_ATLAS=postgresql://atlas_user:atlas_pass@localhost:5433/atlas

# ── Keycloak (token validation) ──
KEYCLOAK_JWKS_URI=https://keycloak.bachatt.app/realms/master/protocol/openid-connect/certs
KEYCLOAK_ISSUER=https://keycloak.bachatt.app/realms/master
KEYCLOAK_AUDIENCE=atlas-prod

# ── Keycloak Admin API (auto-config) ──
KEYCLOAK_ADMIN_URL=https://keycloak.bachatt.app
KEYCLOAK_ADMIN_CLIENT_ID=admin-cli
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_ADMIN_PASSWORD=<secret>

# ── Redash ──
REDASH_BASE_URL=https://redash.bachatt.app
REDASH_API_KEY=dummy-key-for-development

# ── Slack ──
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz

# ── AWS (prod only) ──
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
AWS_SECRET_NAME=Atlas-Prod

# ── Frontend ──
VITE_BASE_URL_BACKEND=http://localhost:8001
VITE_KEYCLOAK_URL=https://keycloak.bachatt.app
VITE_KEYCLOAK_REALM=master
VITE_KEYCLOAK_CLIENT_ID=atlas-prod
```

---

## 13. Proposed Changes — MVP File List

### Backend — Core (from Apollo)

| File | Type | Description |
|------|------|-------------|
| `src/config/prisma.ts` | NEW | Atlas DB client |
| `src/config/secrets.ts` | NEW | AWS Secrets Manager (adapted from Apollo) |
| `src/config/keycloak-setup.ts` | NEW | Auto-configure Keycloak client + roles on startup |
| `src/middleware/auth.middleware.ts` | NEW | Keycloak JWKS (adapted from Apollo for `atlas-prod`) |
| `src/middleware/error.middleware.ts` | NEW | Error handling (from Apollo) |
| `src/middleware/security.middleware.ts` | NEW | Helmet + rate limiting (from Apollo) |
| `src/controllers/base.controller.ts` | NEW | BaseController (from Apollo) |
| `src/utils/logger.ts` | NEW | Pino logger (from Apollo) |
| `src/utils/errors.ts` | NEW | Error classes (from Apollo) |

### Backend — Access Management

| File | Type | Description |
|------|------|-------------|
| `src/controllers/group.controller.ts` | NEW | List groups, group detail, manage admins |
| `src/controllers/access-request.controller.ts` | NEW | Create, list, review requests |
| `src/controllers/user-access.controller.ts` | NEW | List active access, revoke |
| `src/controllers/notification.controller.ts` | NEW | In-app notification CRUD |
| `src/controllers/audit.controller.ts` | NEW | Audit log query |
| `src/controllers/admin.controller.ts` | NEW | Trigger sync |
| `src/services/redash.service.ts` | NEW | Redash API client |
| `src/services/access-workflow.service.ts` | NEW | Request lifecycle engine |
| `src/services/notification.service.ts` | NEW | In-app + Slack orchestrator |
| `src/services/slack.service.ts` | NEW | Simple webhook POST |
| `src/services/scheduler.service.ts` | NEW | Hourly expiry cron |
| `src/services/sync.service.ts` | NEW | Redash import |
| `src/routes/*.route.ts` | NEW | 7 route files |
| `src/validations/*.validation.ts` | NEW | Zod schemas |
| `prisma/atlas/schema.prisma` | NEW | Full schema |
| `prisma/atlas/seed.ts` | NEW | Seed 4 groups |

### Frontend

| File | Type | Description |
|------|------|-------------|
| `src/App.tsx` | NEW | Router + auth provider |
| `src/contexts/AuthContext.tsx` | NEW | Keycloak auth (from Apollo) |
| `src/contexts/NotificationContext.tsx` | NEW | Notification state |
| `src/services/keycloak.ts` | NEW | Keycloak config for `atlas-prod` |
| `src/services/apiClient.ts` | NEW | Axios + token injection (from Apollo) |
| `src/components/layout/*` | NEW | MainLayout, Sidebar, TopBar |
| `src/components/common/*` | NEW | GroupCard, DataTable, Modal, StatusBadge, NotificationBell |
| `src/components/access/*` | NEW | AccessRequestModal, ApprovalCard |
| `src/pages/Dashboard.tsx` | NEW | Group cards + stats |
| `src/pages/Groups.tsx` | NEW | Group browse |
| `src/pages/GroupDetail.tsx` | NEW | Group info + members |
| `src/pages/MyRequests.tsx` | NEW | User's request history |
| `src/pages/MyAccess.tsx` | NEW | User's active access |
| `src/pages/PendingApprovals.tsx` | NEW | Admin approval queue |
| `src/pages/AuditLog.tsx` | NEW | Admin audit table |

---

## 14. MVP Roadmap

| # | Task | Effort |
|---|------|--------|
| 1 | Project scaffolding (backend + frontend + docker + postgres) | 1 day |
| 2 | Prisma schema + migrations + seed 4 groups | 0.5 day |
| 3 | Core middleware from Apollo (auth, security, errors, base controller) | 1 day |
| 4 | Keycloak auto-config service | 0.5 day |
| 5 | Redash service (API client + sync + provisioning) | 1.5 days |
| 6 | Access workflow service (request → review → provision → revoke) | 1.5 days |
| 7 | Notification service (in-app) + Slack ping | 1 day |
| 8 | Scheduler service (hourly expiry cron) | 0.5 day |
| 9 | All backend routes + controllers | 1.5 days |
| 10 | Frontend: layout, sidebar, topbar, notification bell | 1 day |
| 11 | Frontend: dashboard with group cards | 1 day |
| 12 | Frontend: group detail + access request modal | 1 day |
| 13 | Frontend: my requests, my access, pending approvals | 1.5 days |
| 14 | Frontend: audit log page | 0.5 day |
| 15 | E2E testing + error handling + polish | 1.5 days |
| | **Total** | **~15 days** |

---

## Verification Plan

### Automated Tests
- Unit tests for `RedashService` (mocked with `nock`)
- Unit tests for `AccessWorkflowService` (lifecycle states)
- API tests with `supertest`
- `npm run lint` + `npm run type-check` pass

### Manual Verification
1. **Full flow**: Login → Browse Groups → Request → Admin Approves → Verify user added to Redash group
2. **Rejection flow**: Request → Reject → User sees rejection + reason
3. **Notifications**: Verify Slack ping sent, in-app bell updates
4. **RBAC**: Regular user can't see Pending Approvals or Audit Log
5. **Expiry**: Set short duration → verify auto-removal from Redash
6. **Import**: Run sync → verify Redash users/groups appear in Atlas
