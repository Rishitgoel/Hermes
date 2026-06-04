# Hermes HLD Flowchart

Hermes is an access governance application for requesting, approving, provisioning, auditing, and expiring access to external platforms. Redash is the active platform adapter today; the backend is already shaped so AWS, Jira, or other platforms can be added through the provisioning registry.

## 1. System Context

```mermaid
flowchart TB
    User["End User"]
    Admin["Group / Platform / Super Admin"]

    subgraph Browser["Browser"]
        React["React Frontend<br/>Vite + React Router"]
        AuthCtx["Auth Context<br/>Keycloak session or simulation token"]
        NotifyCtx["Notification Context"]
        ApiClient["API Client<br/>Bearer token"]
    end

    subgraph Backend["Hermes Backend<br/>Node.js + Express + TypeScript"]
        Security["Security Middleware<br/>CORS, Helmet, rate limit, request id"]
        AuthMw["Auth Middleware<br/>token validation + role scopes"]
        Routes["REST Routes<br/>auth, groups, requests, admin, audit, notifications"]
        Controllers["Controllers<br/>validation + request orchestration"]
        Services["Domain Services<br/>access workflow, user creation, sync, notifications"]
        EventBus["In-process Event Bus"]
        Scheduler["Scheduler<br/>expiry + periodic sync"]
        Registry["Provisioning Registry<br/>platform -> adapter"]
    end

    subgraph Data["Data Layer"]
        Prisma["Prisma Client"]
        HermesDB["Hermes Postgres / Supabase<br/>groups, requests, grants, admins, audit, notifications, platform cache"]
    end

    subgraph Identity["Identity"]
        Keycloak["Keycloak<br/>users, roles, admin scopes"]
    end

    subgraph Platforms["External Platforms"]
        RedashAdapter["Redash Provisioner"]
        Redash["Redash API<br/>users, groups, invites"]
        FutureAdapters["Future Adapters<br/>AWS / Jira / others"]
    end

    subgraph Channels["Notification Channels"]
        InApp["In-app Notifications"]
        Slack["Slack DM / channel"]
        Email["AWS SES Email"]
    end

    User --> React
    Admin --> React
    React --> AuthCtx
    React --> NotifyCtx
    React --> ApiClient
    ApiClient --> Security
    Security --> AuthMw
    AuthMw --> Routes
    Routes --> Controllers
    Controllers --> Services
    Services --> Prisma
    Prisma --> HermesDB
    Services --> EventBus
    EventBus --> InApp
    EventBus --> Slack
    EventBus --> Email
    Services --> Registry
    Registry --> RedashAdapter
    Registry --> FutureAdapters
    RedashAdapter --> Redash
    AuthCtx --> Keycloak
    AuthMw --> Keycloak
    Scheduler --> Services
    Scheduler --> Registry
```

## 2. Backend Module Flow

```mermaid
flowchart LR
    Request["HTTP Request"] --> Security["Security + utility middleware"]
    Security --> Auth["Auth middleware<br/>except health"]
    Auth --> Route["Express route"]
    Route --> Validation["Zod validation"]
    Validation --> Controller["Controller"]
    Controller --> Service["Domain service"]

    Service --> DB["Prisma + Postgres"]
    Service --> Authz["AuthZ helpers<br/>super, platform, group admin"]
    Service --> Registry["Provisioning Registry"]
    Registry --> Adapter["Platform Adapter<br/>Redash today"]
    Adapter --> External["External Platform API"]

    Service --> Audit["Audit entries"]
    Service --> Events["Event Bus"]
    Events --> Notify["Notification Service"]
    Notify --> InApp["Notification table"]
    Notify --> Slack["Slack Service"]
    Notify --> Email["Email Service / SES"]
```

## 3. Account Creation Flow

```mermaid
flowchart TD
    Login["User logs in through Keycloak"] --> Me["Frontend calls GET /auth/me"]
    Me --> DraftCheck["UserCreationService.ensureDraftForUser"]
    DraftCheck --> Existing{"User already exists in Redash cache?"}

    Existing -- yes --> Completed["Create or return COMPLETED user-creation row"]
    Existing -- no --> Draft["Create or return DRAFT user-creation row"]

    Draft --> Submit["User submits account justification"]
    Submit --> Pending["Status = PENDING"]
    Pending --> NotifyAdmins["Emit user-creation.submitted<br/>notify admins"]
    NotifyAdmins --> AdminReview["Super admin reviews request"]

    AdminReview --> Decision{"Approved?"}
    Decision -- no --> Rejected["Status = REJECTED"]
    Rejected --> CascadeReject["Cascade-reject pending group access requests"]
    CascadeReject --> NotifyRejected["Notify requester"]

    Decision -- yes --> Approved["Status = APPROVED"]
    Approved --> Invite["Redash findOrInviteUser"]
    Invite --> InviteResult{"Invite link returned?"}

    InviteResult -- yes --> Awaiting["Status = AWAITING_SETUP<br/>store invite link"]
    Awaiting --> UserSetup["User completes Redash setup"]
    UserSetup --> SyncNow["Periodic sync or user clicks Sync Now"]
    SyncNow --> Detect["Redash user detected as active"]
    Detect --> MarkComplete["Status = COMPLETED"]

    InviteResult -- no --> MarkComplete
    MarkComplete --> ProvisionWaiting["Provision any WAITING_FOR_SETUP group requests"]
    MarkComplete --> NotifyComplete["Notify user setup complete"]
```

## 4. Group Access Request Flow

```mermaid
flowchart TD
    Browse["User browses platform groups"] --> Select["Select group(s), reason, duration"]
    Select --> Create["POST /api/access-requests"]
    Create --> Validate["Validate duplicate active or pending access"]
    Validate --> RequestRow["Create AccessRequest<br/>status = PENDING"]
    RequestRow --> AuditCreated["Audit REQUEST_CREATED"]
    RequestRow --> NotifyReviewers["Emit request.created<br/>notify group/platform/super admins"]

    NotifyReviewers --> Review["Admin reviews in Pending Approvals"]
    Review --> Decision{"Approve?"}

    Decision -- reject --> Rejected["Status = REJECTED"]
    Rejected --> AuditRejected["Audit REQUEST_REJECTED"]
    AuditRejected --> NotifyUserRejected["Notify requester"]

    Decision -- approve --> UserReady{"User-creation status COMPLETED?"}
    UserReady -- no --> Waiting["Status = WAITING_FOR_SETUP"]
    Waiting --> NotifyQueued["Notify requester access is queued"]
    Waiting --> CompletedLater["Account setup later completes"]
    CompletedLater --> ProvisionStart

    UserReady -- yes --> ProvisionStart["Status = PROVISIONING"]
    ProvisionStart --> ResolvePlatform["Resolve group.platform in Provisioning Registry"]
    ResolvePlatform --> Adapter["Call platform adapter provision"]
    Adapter --> Platform["External platform group membership"]
    Adapter --> Grant["Create UserAccess<br/>isActive = true"]
    Grant --> Provisioned["AccessRequest status = PROVISIONED"]
    Provisioned --> AuditGranted["Audit ACCESS_GRANTED"]
    AuditGranted --> NotifyApproved["Notify requester"]

    Adapter -- failure --> Failed["Status = PROVISION_FAILED"]
    Failed --> AuditFailed["Audit PROVISION_FAILED"]
```

## 5. Revocation, Expiry, and Sync Flow

```mermaid
flowchart TD
    subgraph Manual["Manual Revocation"]
        AdminRevoke["Admin revokes active UserAccess"] --> Deprovision["Adapter deprovisions external membership"]
        Deprovision --> DisableGrant["Set UserAccess.isActive = false"]
        DisableGrant --> MarkRevoked["Set AccessRequest = REVOKED"]
        MarkRevoked --> AuditRevoked["Audit ACCESS_REVOKED"]
        AuditRevoked --> NotifyRevoked["Notify user"]
    end

    subgraph Scheduled["Scheduled Expiry"]
        Scheduler["Scheduler scans expired active grants"] --> Expire["AccessWorkflowService.expireAccess"]
        Expire --> ExpireDeprovision["Adapter deprovisions external membership"]
        ExpireDeprovision --> DisableExpired["Set UserAccess.isActive = false"]
        DisableExpired --> MarkExpired["Set AccessRequest = EXPIRED"]
        MarkExpired --> AuditExpired["Audit ACCESS_EXPIRED"]
        AuditExpired --> NotifyExpired["Notify user"]
    end

    subgraph CacheSync["Platform Cache Sync"]
        Sync["Initial / scheduled / admin-triggered sync"] --> Registry["Provisioning Registry"]
        Registry --> SyncAdapters["Registered adapters sync users and groups"]
        SyncAdapters --> Cache["Upsert platform_external_users and platform_external_groups"]
        Cache --> UserCreationDetect["Detect completed Redash setup"]
        UserCreationDetect --> WaitingProvision["Provision queued access requests"]
    end
```

## 6. Main Responsibilities

| Layer | Responsibility |
| --- | --- |
| React frontend | Authenticated user experience, role-aware navigation, request forms, approval screens, admin management, audit log, notifications |
| Auth context | Keycloak login/token refresh in live mode, simulation roles in dev mode |
| Express API | REST boundary, security middleware, validation, controller orchestration |
| Domain services | Access workflow, user creation lifecycle, notifications, platform sync, scheduler logic |
| Prisma/Postgres | Source of truth for Hermes groups, admins, access requests, active grants, notifications, audit, platform cache |
| Keycloak | Source of truth for identity and admin role assignments |
| Provisioning registry | Platform routing by `Group.platform`, allowing Redash today and future adapters later |
| Redash provisioner | External user invite, group membership provisioning, deprovisioning, user/group sync |
| Event bus | In-process fanout for notification side effects |
| Notification services | In-app notification rows, Slack messages, and SES emails |

## 7. Current Scale Notes

- The event bus is in-process, so notification side effects are not durable across backend crashes.
- Bulk request/review endpoints are planned but not implemented yet; current UI paths can make multiple HTTP calls.
- Platform cache storage is already generic, so adding a new platform should mainly require a new adapter and registry registration.
- The Redash account creation gate is still Redash-specific; future platform onboarding may need a generalized account-readiness model.
