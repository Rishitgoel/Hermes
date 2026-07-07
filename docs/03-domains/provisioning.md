# Domain: Provisioning adapters

**Key files:** `services/provisioner.interface.ts`, `services/provisioning.registry.ts`,
`services/adapter-helpers.ts`, and per-platform pairs of `<platform>.service.ts` (raw API
client) + `<platform>.provisioner.ts` (adapter implementing `PlatformAdapter`).

This is the layer that turns an approved `AccessRequest` into real access on an external
system. **No workflow code ever calls a platform SDK directly** — everything goes
through the `PlatformAdapter` interface via the registry, which is what makes adding a
fifth platform a matter of writing one adapter class, not touching the request lifecycle.

## The adapter interface & registry

`PlatformAdapter` (`provisioner.interface.ts`) defines the contract every platform
implements:

- **Lifecycle**: `provision`, `deprovision`, `checkUserStatus`, `inviteUser`.
- **Optional `regenerateInvite`** — only for platforms with a regenerable one-time link
  (Redash). AWS omits it.
- **Sync**: `syncUsers`, `syncGroups` (populate the read-through cache),
  `syncSingleUser` (fast path for a "I finished setup" button).
- **Group lifecycle**: `createExternalGroup`, `deleteExternalGroup`.
- **`reconcileMembers`** — optional; only multi-target platforms (ZooKeeper) implement
  it, for when an admin edits a group's backing path list and every active member's
  effective access needs recomputing.
- **`validateExternalGroupId`** — parse/validate before persisting (catches malformed
  config before it silently breaks every future provision call).
- **`isSimulation()`**, **`isEnabled()`** (only AWS can be toggled off via
  `config.aws.isEnabled`), **`isReservedExternalGroup()`** (hide system/admin groups from
  being requestable).
- **`disableUser`** + **`disableUserIsReversible`** — offboarding. Redash is a reversible
  soft-disable; AWS is a permanent delete.
- **`getLaunchUrl`**, **`getOnboardingMessage`** — platform-specific "you're in, here's
  how to log in" copy shown after a grant completes.

Key request/response shapes:

- **`ProvisionContext`**: `email`, `name`, `userId` (needed for platforms with
  blank-email JWTs — ZooKeeper, Secrets Manager), `externalGroupId`, `metadata`.
- **`ProvisionResult`**: `externalUserId` plus optional `inviteLink` (→ request goes to
  `AWAITING_SETUP`) or `alreadyExists: true` (→ completes immediately). Neither present
  also means immediate completion (ZooKeeper's case).
- **`DeprovisionContext`**: includes `retainExternalGroupId` — see
  [access-workflow.md](access-workflow.md#level-changes--renewals-_swapgrant_) for why
  this matters on level swaps/revokes for multi-target platforms.

**`ProvisioningRegistry`** (`provisioning.registry.ts`): a case-insensitive `Map` from
platform key → adapter instance. Constructed at startup by iterating
`config.redashInstances` (each configured instance — prod, optionally QA — gets its own
`RedashService`/`RedashProvisioner` pair, keyed separately, e.g. `redash` and
`redash-qa`) plus one registration each for AWS, ZooKeeper, Secrets. Unconfigured
instances (no `baseUrl`) are simply skipped. `get()` throws on an unknown platform,
`tryGet()` returns null, `has()`/`listPlatforms()`/`healthCheckAll()` round it out.

**Adding a new platform**: write `newplatform.service.ts` (raw API client, mirroring
`aws-identity-center.service.ts` or `redash.service.ts`) and
`newplatform.provisioner.ts` (implements `PlatformAdapter`), then register it in the
registry's constructor. No other file needs to change.

---

## AWS Identity Center

`services/aws-identity-center.service.ts` + `services/aws.provisioner.ts`.

- **Provision**: creates an Identity Store user (`CreateUserCommand`, GUID `UserId`,
  email as unique username) if one doesn't exist, then adds them to the target group
  (`CreateGroupMembershipCommand`, idempotent — a "already a member" conflict is
  swallowed). **Immediate** — no invite link; AWS itself emails SSO sign-in instructions.
- **Deprovision**: `DeleteGroupMembershipCommand`.
- **Offboarding** (`disableUser`): `DeleteUserCommand` — **permanent, irreversible**
  (`disableUserIsReversible` is omitted/false). This is different from Redash's
  soft-disable — be careful with force-offboarding flows here.
- **Toggle**: `isEnabled()` reads `config.aws.isEnabled`; can be flipped via
  `npm run aws:enable` / `aws:disable` / `aws:status`.
- **Reserved group**: `API-TESTING` is hidden (`isReservedExternalGroup`) — it holds the
  service account's own admin permissions.
- **Eventual consistency**: `CreateUser`/`CreateGroup` can briefly 404 on a subsequent
  read; retried with exponential backoff (~0.3s → 2.4s, several attempts). Membership
  removal uses `ListGroupMembershipsForMember` rather than `GetGroupMembershipId`
  specifically to avoid a stale-404 on a recent add.
- **Cache pruning** has a 10-minute grace window and explicitly skips rows marked
  `isPending: true` so a freshly-invited user isn't erased before they surface in
  `ListUsers`.

## Redash (prod + QA)

`services/redash.service.ts` (raw HTTP client, one instance per Redash deployment) +
`services/redash.provisioner.ts` (adapter wrapper).

- **Provision**: `findOrInviteUser(email, name)` — searches by email, invites
  (`POST /api/users`) on miss, returns a one-time invite link if newly invited, or
  "already exists" if not. Then `addUserToGroup` (idempotent — a 400 "already a member"
  is treated as success).
- **Deprovision**: `removeUserFromGroup` — a 404 is treated as success (idempotent).
- **Offboarding**: `disableUser` → Redash `is_disabled=true`, **reversible**
  (`disableUserIsReversible = true`).
- **`regenerateInvite`**: re-issues a fresh one-time link (guards against a stale
  `REDASH_BASE_URL` baked into an old link).
- **Per-user mutex** (`withUserLock()` in `redash.service.ts`): all membership mutations
  for one Redash user are serialized in-process, because Redash's group membership is a
  read-modify-write on an array field — concurrent adds/removes on the same user would
  otherwise clobber each other. (This lock is in-process only; it does not protect
  against two separate backend processes racing — relevant if Hermes 2's code is ever
  run multi-replica, which it currently isn't.)
- **User recreation handling**: if a Redash user is deleted and recreated (same email,
  new numeric id), `reconcileRecreatedUsers()` retargets the stale cache row before
  upserting, to avoid a `(platform, email)` unique constraint collision.
- Two distinct one-shot/maintenance services build on top of this:
  - **`redash-import.service.ts`** — one-way backfill: walks Redash's existing
    membership (via the cache), resolves each email to a Keycloak user, and creates
    `COMPLETED` `UserCreationRequest` + permanent `UserAccess` rows so pre-existing Redash
    users don't have to re-request access Hermes now manages. Handles level conflicts by
    keeping the higher-ranked one. Idempotent.
  - **`redash-resync.service.ts`** — bidirectional resync for when someone edits Redash
    membership directly (bypassing Hermes). Four passes: **A** (add, delegates to
    import), **B** (classify each active grant as REFRESH/SWAP/REMOVE by diffing against
    live Redash state — REMOVE is the only destructive one and is capped at
    max(5, 20% of active grants) unless `force: true`; **disabled Redash accounts are
    deliberately left alone**, since disable is reversible), **C** (un-stick requests
    whose user now has an active grant), **D** (report-only: flag `UserCreationRequest`s
    whose user already exists on Redash — never auto-resolved). Guarded by a per-platform
    concurrency lock, an empty-cache abort, and a health-check gate.

## ZooKeeper

`services/zookeeper.service.ts` (low-level ZK client) +
`services/zookeeper.provisioner.ts` (adapter) +
`services/zookeeper-config.service.ts` (the approval workflow for config *changes*,
distinct from provisioning access) + `services/zookeeper-migration.service.ts`
(one-shot ACL-fixing tool).

**The load-bearing invariant**: managed znodes are **world-open**
(`world:anyone:cdrwa`) and **no per-user credentials are ever minted**. Access is
enforced entirely at the Hermes application layer — the Postgres cache of who holds
which paths *is* the access-control record, checked on every read/write Hermes proxies.
This works because the ZK ensemble is network-isolated and Hermes is the only gateway to
it. There is deliberately no per-znode ACL rewriting on grant/revoke; doing so would
require a user/path permission matrix ZK isn't designed for. See the memory note
`hermes-zk-world-open-model` for the standing rationale.

- **`externalGroupId`** for a ZK group is a newline-separated list of znode paths,
  optionally suffixed `#perms` (e.g. `/hermes/credit-card#cdrw`).
- **Provision**: resolves a stable `aclId` (email, or `__zk_uid:<userId>` when the JWT
  has no email — see below), caches each granted path plus all of its live descendants
  (`descendantPaths()`) so tree traversal works without per-node ACL rewrites.
- **Deprovision**: recomputes the user's full effective path set from *all* their
  remaining active grants and atomically replaces the cached list — this is what makes
  a level swap on one group correctly preserve paths granted by another group.
- **Blank-email collision handling**: live Keycloak JWTs can have no email claim. Two
  such users would otherwise collide on `(platform='zookeeper', email='')`; the fix is
  keying the cache row on `__zk_uid:<userId>` instead, and grant resolution always
  prefers the userId-keyed row when present.
- **Per-path mutex**: `setACL` calls for the same path are serialized in-process for the
  same clobbering reason as Redash's per-user lock.
- **`zookeeper-config.service.ts`** is a separate approval workflow layer: users submit
  draft znode changes (SET/CREATE/DELETE/CLEAR) scoped to paths their grants cover;
  the owning group's admin reviews per-change; apply is synchronous on approval (states:
  `PENDING → APPLYING → APPLIED / PARTIALLY_APPLIED / APPLY_FAILED / REJECTED`, no
  resting `APPROVED` state). A lost-update guard compares `oldValue` to the live value
  before committing a SET. A periodic sweep flips requests stuck in `APPLYING` (crash
  mid-apply) to `APPLY_FAILED` so they're retryable.
- **`zookeeper-migration.service.ts`**: one-shot tool to (re)apply world-open ACL across
  the whole managed subtree — used after any manual out-of-band edit.

## AWS Secrets Manager

`services/secrets.provisioner.ts` + `services/secrets-manager.service.ts` +
`services/secret-ingestion.service.ts` (the approval workflow — see
[secret-ingestion.md](secret-ingestion.md) for the full write-up).

- Same "no user directory, cache is the access record" shape as ZooKeeper, and the same
  `__secrets_uid:<userId>` blank-email fallback.
- **`externalGroupId`** is a newline-separated list of secret names *or* wildcard
  patterns (`*`, `prefix*`). Wildcards are **resolved live** against `ListSecrets` every
  time (no caching), so a newly created matching secret shows up immediately — the
  provisioner's own cache only ever stores concrete, resolved names.
- **`deprovision`** prefers `retainExternalGroupId` when provided (avoids a redundant DB
  round-trip on every revoke/expire) and falls back to a full recompute otherwise.
- **`deleteExternalGroup` is a deliberate no-op** — Hermes will never delete a real AWS
  secret just because a Hermes group backing it is deleted.
- Secret names are **case-sensitive on AWS**; `resolveSecretForUser()` canonicalizes to
  the live casing before use, so submitting the wrong case doesn't silently create a
  sibling secret.
- This is the **newest, least mature** integration of the four: no multi-instance
  support, no `syncUsers`/`syncGroups` (there's no external directory to sync), no
  caching of wildcard matches.

## Cross-cutting gotchas

- **Idempotency is handled per-platform, not generically** — AWS/Redash/ZK/Secrets each
  swallow their own "already exists" / "already a member" conditions; there's no shared
  idempotency layer.
- **Provisioning failures never roll back a Hermes-side commit** — see
  [access-workflow.md](access-workflow.md) for why.
- **All four adapters implement `checkUserStatus` as a cache-only read** — none of them
  hit the live platform API for this call. A stale cache means a stale answer; the fix is
  a manual resync, not a code change.
