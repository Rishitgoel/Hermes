# Secret Ingestion platform (AWS Secrets Manager, approval-gated)

## Context

Today, adding a key-value pair to one of the company's many AWS secrets is done through Jenkins. We want that self-service flow inside Hermes instead: a user with access to a **Secret Ingestion** group picks which AWS secret to write to, enters key-value pairs, and submits them; a group/platform admin reviews **per key** and approves; Hermes then merges the approved keys into the secret in AWS Secrets Manager (upsert — existing keys overwritten, other keys untouched; the secret is created if it doesn't exist yet).

This maps almost one-to-one onto the existing **ZooKeeper** feature, which is the template throughout this plan:
- a `PlatformAdapter` (`zookeeper`) whose `externalGroupId` encodes a scoped target list, with access enforced **inside Hermes** (not on the platform),
- an **account = a Hermes-only cache row** (no real account minted on the external system — confirmed this is exactly what we want here: a "Secret Ingestion account" exists only in Hermes' DB, never in AWS),
- a **change-request workflow service** (`zookeeper-config.service.ts`) with **per-change (git-style) approve/reject**,
- a **gated config tab** (`ZookeeperConfig.tsx`) shown only to users with an active grant, plus a **reviewer component** (`ZkChangeApprovals.tsx`) surfaced in Pending Approvals.

### Design decisions (locked with the user)
- **Platform key** `secrets`, **display name** "Secret Ingestion". (Single lowercase token — clean role names like `hermes_group_admin_secrets_<slug>`.)
- **Write flow:** admin approval first (staged request → review → apply). Not direct write.
- **Scope:** per-group list of secret names. A group's `externalGroupId` = newline-separated AWS secret names (the ZK-paths analog). Admin-editable.
- **Value visibility:** when browsing a secret, requester sees existing **key names only, values masked**. The values they *type* to ingest are visible to them and to the reviewer (needed for a real approval).
- **Create-if-missing:** if a secret name in the group's list doesn't exist in AWS yet, the first approved ingestion **creates** it.
- **Approval granularity:** **per-key** approve/reject (mirrors ZK per-change decisions). One request targets **one secret**; approved keys are merged, rejected keys dropped.
- **Simulation:** in-process mock secret store locally (no AWS calls), same pattern as the AWS/ZK adapters.

### Key semantic differences from ZooKeeper (simpler)
- One request → **one secret**, N key/value **entries** (ZK: one request → many paths/groups). Owning group = the group that lists that secret name.
- Apply is a single **read-merge-write** of the secret's JSON (AWS writes the whole `SecretString` at once), so per-key granularity is at the *decision* level; the write itself is atomic. No per-change lost-update guard needed — we re-read the current secret at apply time and merge approved keys on top, which is exactly the desired overwrite-and-preserve-others behavior.
- **Value retention caveat:** a PENDING request row stores the entry values in Postgres so the reviewer can see them. After a terminal status we **redact** (null out) applied/rejected entry values so plaintext secret values aren't retained long-term.

---

## Phase 1 — Data model + migration

File: `backend/prisma/hermes/schema.prisma` (mirror `ZookeeperChangeRequest`, lines ~358-398).

- Add enum `SecretIngestionStatus { PENDING APPLYING APPLIED PARTIALLY_APPLIED APPLY_FAILED REJECTED }`.
- Add model `SecretIngestionRequest` → `@@map("secret_ingestion_requests")`:
  - `id`, `requesterId`, `requesterName`, `requesterEmail`
  - `groupId String?` (owning group; `group Group? @relation(..., onDelete: SetNull)`)
  - `secretName String` (the target AWS secret)
  - `entries Json` — array of `{ key, value, decision?: "APPROVED"|"REJECTED", applied?, error? }`
  - `justification String?`
  - review fields: `reviewerId`, `reviewerName`, `reviewNote`, `reviewedAt`
  - execution: `applyError String?`, `appliedAt DateTime?`
  - `createdAt`, `updatedAt`
  - `status SecretIngestionStatus @default(PENDING)`
  - `@@index([status])`, `@@index([requesterId])`, `@@index([groupId])`
- Add inverse relation on `Group`: `secretIngestionRequests SecretIngestionRequest[]` (mirror the ZK back-relation).
- Migration: `cd backend && npm run prisma:migrate` (additive — one new table + enum; nothing existing changes), then `npx prisma generate --schema=prisma/hermes/schema.prisma`.

## Phase 2 — Config + AWS Secrets Manager service

**Config** — `backend/src/config/config.ts`: add a `secrets` block (lazy getters, mirroring the `aws`/`zookeeper` blocks):
- `get region()` → `process.env.SECRETS_INGESTION_REGION || process.env.AWS_REGION`
- `get isSimulation()` → `process.env.SECRETS_INGESTION_SIMULATION === 'true' || !this.region` (sim by default locally; going live needs a region + creds + `SECRETS_INGESTION_SIMULATION=false`).

**New** `backend/src/services/secrets-manager.service.ts` — low-level AWS wrapper + in-process sim store (pattern from `secrets.ts` for the SDK client and from `aws-identity-center.service.ts` for the sim-store + `isSimulation()` short-circuit). Reuse the already-installed `@aws-sdk/client-secrets-manager`. Exposes:
- `parseSecretNames(externalGroupId: string): string[]` — one secret name per line, trimmed, non-empty (the `parseExternalGroupIds` analog).
- `listSecretKeys(name): Promise<{ exists: boolean; keys: string[] }>` — `DescribeSecret`/`GetSecretValue`, return **key names only** (never values). Sim: read mock store.
- `getSecretMap(name): Promise<Record<string,string> | null>` — internal, used only at apply for the merge.
- `putSecretKeyValues(name, kv: Record<string,string>, opts:{ createIfMissing:boolean }): Promise<void>` — read current JSON (or `{}`), merge `kv` on top (upsert/overwrite), write back with `PutSecretValueCommand`; if missing and allowed, `CreateSecretCommand`. Sim: mutate mock store.
- `healthCheck()`.
- Simulation store seeded with a couple of fake secrets so the flow is testable offline.

## Phase 3 — Provisioner adapter + registry

**New** `backend/src/services/secrets.provisioner.ts` — `implements PlatformAdapter` (`PLATFORM = 'secrets'`, `displayName = 'Secret Ingestion'`), mirroring `zookeeper.provisioner.ts`:
- `inviteUser` → seed a Hermes-only `platformExternalUser` row (no AWS account, no inviteLink → account request completes immediately). Reuse ZK's `cacheRowEmail(email, userId)` blank-email/`__secrets_uid:<userId>` keying (live Keycloak JWTs often lack email — see `live-keycloak-empty-emails` memory).
- `checkUserStatus` → cache-only lookup.
- `provision`/`deprovision` → seed/refresh the cache row (bookkeeping only; enforcement is in the workflow service). Cache the granted secret names.
- `validateExternalGroupId` → every line parses to a non-empty secret name.
- `createExternalGroup(name)` → returns a placeholder external id (secret gets created lazily on first approved ingestion). `deleteExternalGroup` → best-effort no-op/log (do **not** delete real AWS secrets on group delete).
- `reconcileMembers` → diff old vs new secret-name lists, report added/removed for the `SECRET_GROUP_SECRETS_RECONCILED` audit (no per-user ACLs to rewrite — access is enforced via active grants). Implementing this hook is what makes the group's secret list **editable** in the admin UI.
- `getOnboardingMessage` → generic "your Secret Ingestion access is set up".
- `isSimulation` → `config.secrets.isSimulation`. `getLaunchUrl` → AWS console secrets URL or `null`. `healthCheck` → delegate to the service.

**Register** — `backend/src/services/provisioning.registry.ts`: add `this.register('secrets', secretsProvisioner)` (one line, next to `zookeeper`).

## Phase 4 — Ingestion workflow service (enforcement + per-key review/apply)

**New** `backend/src/services/secret-ingestion.service.ts` — the enforcement point + workflow (mirror `zookeeper-config.service.ts`). All authorization is computed from the user's **active `secrets` grants**:
- `resolveUserSecretTargets(userId)` → `{ groupId, groupName, secretName }[]` from active grants (`group.platform='secrets'`, `level ?? group` externalGroupId parsed via `parseSecretNames`).
- `getUserScope(userId)` → groups + their secret names (seeds the selector).
- `listSecretKeys(userId, secretName)` → authorize `secretName` is in scope, then return `{ exists, keys }` (masked) from the service.
- `owningGroup(targets, secretName)` → the group granting that secret (deterministic tie-break by groupId), the review-routing target.
- `createIngestionRequest({ requester, secretName, entries, justification })` → authorize secret in scope + at least one entry; stage a `PENDING` row (`entries` = `[{key,value,decision:null,applied:false}]`, `groupId` = owning group); write `SECRET_INGESTION_SUBMITTED` audit; emit `secret-ingestion.submitted`.
- `reviewableGroupIds(user)` / `canReview` → super / `secrets` platform admin / group admin of the owning group (mirror ZK).
- `listIngestionRequests(user, 'mine'|'review')`.
- `reviewIngestionRequest(id, reviewer, decisions[{key,decision}], note)` → claim PENDING→APPLYING via conditional `updateMany` (race-safe, like ZK); mark each entry APPROVED/REJECTED (unlisted ⇒ REJECTED); build merged map of approved keys; one `putSecretKeyValues(secretName, approvedKv, { createIfMissing:true })`; on success mark approved entries `applied:true`; compute `FinalStatus` (APPLIED / PARTIALLY_APPLIED / APPLY_FAILED / REJECTED); **redact entry values** post-terminal; write `SECRET_INGESTION_<status>` audit; emit `secret-ingestion.reviewed`.
- `sweepStuckApplying(maxAgeMs)` → recover orphaned APPLYING rows (mirror ZK; wire into scheduler alongside the ZK sweep if one exists — check `scheduler.service.ts`).

## Phase 5 — Validation + controller + route + mount + auth flag

- **New** `backend/src/validations/secret-ingestion.validation.ts` (mirror `zookeeper.validation.ts`):
  - `submitIngestionSchema`: `secretName` (non-empty, max len), `entries: [{ key: non-empty ≤512, value: string ≤50000 }]` (min 1, max ~200), `justification?` ≤1000.
  - `reviewIngestionSchema`: `decisions: [{ key, decision: 'APPROVED'|'REJECTED' }]` (min 1), `note?` ≤250.
- **New** `backend/src/controllers/secret-ingestion.controller.ts` (mirror `zookeeper.controller.ts`) — `authenticateToken` only; authz in service. Handlers: `getScope`, `listKeys` (`GET /keys?name=`), `submitRequest`, `listRequests` (`?scope=mine|review`), `reviewRequest` (`canReview` gate before delegating).
- **New** `backend/src/routes/secret-ingestion.route.ts` (mirror `zookeeper.route.ts`): `GET /scope`, `GET /keys`, `POST /requests`, `GET /requests`, `PUT /requests/:id/review`.
- **Mount** — `backend/src/index.ts`: `import secretIngestionRouter` + `app.use('/api/secrets', secretIngestionRouter)` (next to the `/api/zookeeper` mount, line ~112).
- **Auth flag** — `backend/src/controllers/auth.controller.ts`: add `hasSecretsAccess` (active grant on a `platform='secrets'` group) exactly like `hasZookeeperAccess` (lines ~67-75); include in the `/auth/me` response.

## Phase 6 — Events, notifications, email templates

- `backend/src/services/event-listeners.ts` — add `secret-ingestion.submitted` → `notifySecretIngestionSubmitted(...)` and `secret-ingestion.reviewed` → `notifySecretIngestionReviewed(...)` (mirror the two `zk-change.*` listeners at lines ~140-156).
- `backend/src/services/notification.service.ts` — add the two notify methods (mirror `notifyZkChangeRequestCreated` / `notifyZkChangeRequestReviewed`, lines ~316-397): resolve reviewers via `groupAdmin` + `platformAdmin.findMany({ platform:'secrets' })`; notify requester with approved/rejected breakdown; deep-link `/secrets`.
- `backend/src/utils/email-templates.ts` — add `adminSecretIngestionRequest`, `userSecretIngestionReviewed`, `userSecretsAccountReady` (mirror `adminZkChangeRequest`, `userZkChangeReviewed`, `userZookeeperAccountReady`).

## Phase 7 — Frontend: config tab + plumbing

- **New** `frontend/src/services/api/secretsApi.ts` — `getSecretScope`, `listSecretKeys(name)`, `submitIngestionRequest`, `listIngestionRequests(scope)`, `reviewIngestionRequest(id, payload)` + shared types (`SecretIngestionEntry`, `SecretIngestionRequest`, `IngestionDecision`). Use `apiClient` only.
- `frontend/src/lib/queryKeys.ts` — add `secretsScope()`, `secretKeys(name)`, `secretIngestionRequests(scope)` (mirror the `zk*` keys, lines 31-33).
- **New** `frontend/src/pages/SecretIngestion.tsx` — the tab (structurally simpler than the ZK tree):
  - Secret **selector** (dropdown of granted secret names grouped by group, from `getSecretScope`).
  - On select → `listSecretKeys` shows existing **keys (values masked)**; flag which staged keys will **overwrite** an existing key.
  - **Key-value entry list** (add/remove rows) + justification + "Submit for approval". Drafts mirrored to `localStorage` like `ZookeeperConfig.tsx`.
  - "My ingestion requests" table (status badges, per-entry approved/applied/rejected breakdown) — reuse `SectionHeader`, `LoadingSpinner`, badge classes.
- `frontend/src/contexts/AuthContext.tsx` — add `hasSecretsAccess?: boolean` (next to `hasZookeeperAccess`, line ~53).
- `frontend/src/components/layout/Sidebar.tsx` — add a nav item gated on `user?.hasSecretsAccess` (icon `KeyRound`), mirroring the ZooKeeper item (lines 126-134).
- `frontend/src/App.tsx` — import `SecretIngestion`; add `<Route path="secrets">` wrapped in `<ProtectedRoute allowIf={(u) => !!u.hasSecretsAccess}>` (mirror lines 67-73).
- `frontend/src/lib/platforms.ts` — add a `secrets` entry to `PLATFORMS` (name "Secret Ingestion", icon `KeyRound`, color `#DD344C`). ACTIVE state is derived from the registry, so registering the adapter flips the card automatically.

## Phase 8 — Frontend: reviewer approvals

- **New** `frontend/src/components/secrets/SecretIngestionApprovals.tsx` (mirror `ZkChangeApprovals.tsx`): per-request card, each entry as a row with a **per-key accept/reject** toggle (`AcceptReject`), Approve-all/Reject-all, optional note, "Apply review (n✓/m✗)". Uses `secretIngestionRequests('review')` query + `reviewIngestionRequest` mutation.
- `frontend/src/pages/PendingApprovals.tsx` — mirror the ZK wiring (lines 7, 14, 47-53, 84-94, 539): add a `canReviewSecrets` flag, a `secretIngestionRequests('review')` count query feeding the "all caught up" logic, and render `<SecretIngestionApprovals />` under `{canReviewSecrets && ...}`.

## Phase 9 — Local seed script

**New** `backend/scripts/create-secrets-group.ts` (mirror `create-zookeeper-group.ts`): idempotent upsert of a demo `secrets` group (e.g. "Payment Secrets") whose `externalGroupId` lists a couple of secret names (e.g. `payment/gateway`, `payment/webhook`). Lets the request→approve→ingest flow be exercised end-to-end in simulation. Run: `cd backend && npx ts-node scripts/create-secrets-group.ts`.

## Phase 10 — Tests

- **New** `backend/src/services/secret-ingestion.service.test.ts` — scope resolution, out-of-scope secret rejection, submit, per-key review with mixed approve/reject, **merge/overwrite + create-if-missing** on apply, value redaction after terminal status. (Mirror `zookeeper-config.test.ts`; Testcontainers/Postgres, sim mode.)
- **New** `backend/src/services/secrets.provisioner.test.ts` — invite seeds a Hermes-only row (no AWS), `validateExternalGroupId`, `reconcileMembers` diff. (Mirror `zookeeper.provisioner.test.ts`.)

## Phase 11 — Verification

1. `cd backend && npx prisma validate --schema=prisma/hermes/schema.prisma`
2. `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`
3. `cd backend && npm run lint` and `cd frontend && npm run lint`
4. `cd backend && npm run test:run` (Docker/Postgres up) — new + existing suites green.
5. Manual sim run (`backend: npm run dev`, `frontend: npm run dev`):
   - `npx ts-node scripts/create-secrets-group.ts` → group appears under the "Secret Ingestion" platform card (ACTIVE).
   - As a regular user: request access → (super_admin) approves the `secrets` account creation + the group access → **Secret Ingestion** nav tab appears (`hasSecretsAccess`).
   - Select a secret → see masked existing keys → stage key-value pairs → submit.
   - As super_admin: Pending Approvals → per-key approve/reject → apply.
   - Confirm the sim store shows approved keys merged (existing keys overwritten, others intact; secret created if new); rejected keys absent; request row values redacted.
6. Optional docs: update `CLAUDE.md` (Provisioning section + audit-action list) — no new `.md` files beyond this plan.

## Files touched (summary)
- **New backend:** `services/secrets-manager.service.ts`, `services/secrets.provisioner.ts`, `services/secret-ingestion.service.ts`, `validations/secret-ingestion.validation.ts`, `controllers/secret-ingestion.controller.ts`, `routes/secret-ingestion.route.ts`, `scripts/create-secrets-group.ts`, 2 test files.
- **Edited backend:** `prisma/hermes/schema.prisma` (+migration), `config/config.ts`, `services/provisioning.registry.ts`, `services/event-listeners.ts`, `services/notification.service.ts`, `utils/email-templates.ts`, `controllers/auth.controller.ts`, `index.ts`, (maybe `scheduler.service.ts` for the sweep).
- **New frontend:** `pages/SecretIngestion.tsx`, `services/api/secretsApi.ts`, `components/secrets/SecretIngestionApprovals.tsx`.
- **Edited frontend:** `lib/queryKeys.ts`, `lib/platforms.ts`, `contexts/AuthContext.tsx`, `components/layout/Sidebar.tsx`, `App.tsx`, `pages/PendingApprovals.tsx`.
