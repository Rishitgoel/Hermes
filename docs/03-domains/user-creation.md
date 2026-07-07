# Domain: User (platform account) creation

**Key files:** `services/user-creation.service.ts`, `controllers/user-creation.controller.ts`,
`services/keycloak-admin.service.ts` (Keycloak-side operations only — see
[02-auth-rbac.md](../02-auth-rbac.md)). Data model: `UserCreationRequest`,
`PlatformExternalUser`.

This is a **separate, per-platform gate that sits in front of group access requests**.
Before a user can hold access to any group on platform X, they need an *account* on
platform X, and that account creation is itself admin-approved. A user can have
independent creation requests per platform (e.g. Redash approved, AWS still pending).

## Lifecycle

```
DRAFT ──(user submits justification)──► PENDING ──(admin approves)──► APPROVED
  │                                         │                            │
  │                                    (admin rejects)              invite call
  │                                         ▼                            │
  │                                     REJECTED                 ┌───────┴────────┐
  │                                 (cascade-rejects              │                │
  │                                  pending group requests   invite link     no invite link
  │                                  for this platform)        issued          (or already exists)
  │                                         ▲                    ▼                ▼
  └── resubmit clears review fields ────────┘             AWAITING_SETUP      COMPLETED
                                                                  │
                                                        user finishes setup /
                                                        platform sync detects them
                                                                  ▼
                                                             COMPLETED
```

- **`ensureDraftForUser()`** — called on every `GET /auth/me`. Idempotent: creates a
  `DRAFT` row per (userId, platform) unless the user is already known on that platform
  (checked against the `PlatformExternalUser` cache), in which case the row is
  auto-completed and the onboarding banner never shows.
- **`submitRequest()`** — `DRAFT → PENDING`, requires a justification (min 10 chars).
  Re-submission after a rejection clears prior review fields. Validates the platform is
  actually registered in the provisioning registry before accepting — otherwise you'd get
  a `PENDING` row that can never be approved.
- **Email is the stable identity**, not the Keycloak userId — if a user gets recreated in
  Keycloak (same email, new `sub`), the code re-points the existing row at the new userId
  rather than creating a duplicate.

## Approval → provisioning (`_executeInvite()`, shared by first-approval and retry)

1. Mark `APPROVED`.
2. Call the platform adapter's `inviteUser()`.
3. If it returns an `inviteLink` → `AWAITING_SETUP` (Redash-style: user has to click
   through).
4. If not (existing Redash user, or a just-created AWS account) → `COMPLETED` directly,
   and any of that user's group requests sitting in `WAITING_FOR_SETUP` are released via
   `accessWorkflowService.provisionWaitingRequests()`.
5. On invite failure, the row **stays `APPROVED`** with `inviteError` set — retryable via
   resend, not a dead end.

## Getting from AWAITING_SETUP to COMPLETED

Two paths, both converging on the same completion logic:
- **`resendInvite()`** (`POST /api/user-creation-requests/me/resend`, 60s rate limit):
  Redash supports `regenerateInvite()` (fresh one-time link); AWS doesn't, so this
  re-runs `_executeInvite()` instead (retrying account creation).
- **`handlePlatformUserDetected()`**: called from a platform sync loop when the platform
  reports the user now exists and is no longer pending. Advances to `COMPLETED`, clears
  the invite link, emits `user-creation.completed`.
- **`forceSync()`** (`POST /api/user-creation-requests/me/sync-now`): user-facing "I just
  finished setup, check now" button — runs a single-user sync rather than waiting for the
  next scheduled platform sync.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/user-creation-requests` | user | Submit / move DRAFT→PENDING |
| GET | `/api/user-creation-requests/me` | user | Current request for the active platform |
| GET | `/api/user-creation-requests/me/all` | user | All requests, all platforms |
| POST | `/api/user-creation-requests/me/resend` | user | Resend invite link |
| POST | `/api/user-creation-requests/me/sync-now` | user | Force a sync after finishing setup |
| GET | `/api/user-creation-requests/pending` | platform/super admin | Scoped to manageable platforms |
| PUT | `/api/user-creation-requests/:id/review` | platform/super admin | Approve or reject |

## Gotchas

- **Cascading rejection is per-platform.** Rejecting a Redash account request
  cascade-rejects that user's pending Redash group requests only — their AWS requests
  are untouched.
- **`APPROVED` is meant to be transient** — it's immediately followed by the invite call
  in the same operation. If you see a row stuck on `APPROVED` for a while, that means the
  invite call failed (`inviteError` will be set) and it's waiting on a resend.
- **Invite link staleness**: stored Redash links are re-normalized against the *current*
  `REDASH_BASE_URL` on every read, since the base URL can drift after the link was
  issued.
