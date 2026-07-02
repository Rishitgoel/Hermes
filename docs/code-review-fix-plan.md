# Fix Plan: 15 Code-Review Findings + Test-Pollution Fix

## Context

A max-effort whole-codebase review (`/code-review max`) was just run against Hermes
(`D:\Bachatt\Hermes 2`), covering both the committed codebase and a substantial
**uncommitted "Redash multi-instance" feature** sitting in the working tree (a
second Redash server, "QA", registered alongside prod under platform key
`redash-qa`, sharing family `redash`). The review ran 10 independent finder
agents, verified every candidate with independent agents, then swept for gaps —
producing 15 confirmed/plausible findings, 3 of which are real bugs introduced by
the new multi-instance feature (invite links silently corrupted for the QA
instance, a missing normalization on the admin approvals list, and a hardcoded
default-group-id assumption that breaks on a differently-seeded second instance),
plus several pre-existing bugs, efficiency issues, dead code, and duplication
surfaced along the way.

This plan fixes all 15 findings (plus one test-hygiene issue found during
planning research) in dependency order, so the riskiest/most user-facing bugs
land first and the lowest-risk mechanical cleanups land last. Every step below
was verified against the actual current file contents (via direct reads, not
guessed) — line numbers and code blocks are exact as of the time this plan was
written. **Two findings (13, 14) and one design note (15) are deliberately "no
code change" items**, reviewed and documented rather than silently dropped,
because their real-world risk was verified to be negligible.

No branches/PRs — per `CLAUDE.md`, work happens straight on `main`. Each phase
below is sized to be one sensible commit.

**Status: planning complete, implementation not yet started.**

---

## Phase 1 — CRITICAL: instance-aware Redash invite-link normalization (Findings 1, 2)

**Why together:** Finding 1's fix changes a function signature that every one of
Finding 2's call sites depends on — they must land in the same commit.

**The bug today:** `normalizeRedashInviteLink()` always rewrites an invite link's
host to `config.redash.baseUrl` (prod), even for a link issued by the `redash-qa`
instance. A QA invite link gets silently corrupted to point at prod.

**Design decision:** parameterize the util with an explicit `baseUrl` rather than
moving normalization into `RedashService`. `user-creation.service.ts`'s wrapper
only has a bare Prisma row (with a `platform` string, not a `RedashService`
instance) — it needs registry-based resolution regardless, so doing the same
"caller supplies baseUrl" pattern everywhere is simpler than a hybrid.

### 1.1 `backend/src/utils/redash-url.ts` — accept an explicit `baseUrl` parameter

```typescript
// BEFORE
export function normalizeRedashInviteLink<T extends string | null | undefined>(link: T): T {
  if (!link) return link;
  try {
    if (link.startsWith('/')) {
      const base = config.redash.baseUrl.replace(/\/$/, '');
      return (`${base}${link}`) as T;
    }
    const parsedUrl = new URL(link);
    const configuredUrl = new URL(config.redash.baseUrl);
    parsedUrl.protocol = configuredUrl.protocol;
    parsedUrl.host = configuredUrl.host;
    return parsedUrl.toString() as T;
  } catch (err: any) {
    logger.warn({ inviteLink: link, error: err.message }, 'Failed to normalize Redash invite link; returning original');
    return link;
  }
}
export default normalizeRedashInviteLink;
```

```typescript
// AFTER
export function normalizeRedashInviteLink<T extends string | null | undefined>(
  link: T,
  baseUrl: string = config.redash.baseUrl,
): T {
  if (!link) return link;
  try {
    if (link.startsWith('/')) {
      const base = baseUrl.replace(/\/$/, '');
      return (`${base}${link}`) as T;
    }
    const parsedUrl = new URL(link);
    const configuredUrl = new URL(baseUrl);
    parsedUrl.protocol = configuredUrl.protocol;
    parsedUrl.host = configuredUrl.host;
    return parsedUrl.toString() as T;
  } catch (err: any) {
    logger.warn({ inviteLink: link, error: err.message }, 'Failed to normalize Redash invite link; returning original');
    return link;
  }
}
export default normalizeRedashInviteLink;
```
Also update the doc comment above the function (currently references `REDASH_BASE_URL` unconditionally) to say it normalizes against the given `baseUrl`, defaulting to prod only for legacy callers that don't pass one.

### 1.2 `backend/src/services/redash.service.ts` — pass `this.baseUrl` at all 3 internal call sites

`RedashService` already stores `this.baseUrl` per instance (constructor). Update:
- Line 237 (inside `findOrInviteUser`, pending-user branch): `normalizeRedashInviteLink(rawLink)` → `normalizeRedashInviteLink(rawLink, this.baseUrl)`
- Line 255 (inside `findOrInviteUser`, fresh-invite branch): same change.
- Line 286 (inside `regenerateInviteLink`): `normalizeRedashInviteLink(rawLink) ?? null` → `normalizeRedashInviteLink(rawLink, this.baseUrl) ?? null`

No import changes (already imported at the top of the file).

### 1.3 `backend/src/services/user-creation.service.ts` — resolve per-row platform → instance base URL

The `normalizeInviteLink` helper (lines 19-24) needs to resolve the row's own
`platform` to that instance's base URL. `RedashProvisioner.getLaunchUrl()`
already returns `this.service.getBaseUrl()` — exactly what's needed, and it
already exists on every registered adapter, so no new lookup method is required.

```typescript
// BEFORE
function normalizeInviteLink<T extends { inviteLink?: string | null }>(row: T): T {
  if (row.inviteLink) {
    row.inviteLink = normalizeRedashInviteLink(row.inviteLink);
  }
  return row;
}
```

```typescript
// AFTER
function normalizeInviteLink<T extends { inviteLink?: string | null; platform: string }>(row: T): T {
  if (row.inviteLink) {
    const adapter = provisioningRegistry.tryGet(row.platform);
    const baseUrl = adapter?.getLaunchUrl?.() || config.redash.baseUrl;
    row.inviteLink = normalizeRedashInviteLink(row.inviteLink, baseUrl);
  }
  return row;
}
```
`provisioningRegistry` and `config` are already imported in this file. Every
`UserCreationRequest` row has a `platform` column, so the tightened generic
constraint breaks no existing caller.

Now fix the actual Finding-2 gap — add normalization to `listPending()`:

```typescript
// BEFORE (lines 240-251)
async listPending(platforms?: string[]) {
  return prisma.userCreationRequest.findMany({
    where: {
      ...(platforms ? { platform: { in: platforms } } : {}),
      OR: [
        { status: UserCreationStatus.PENDING },
        { status: UserCreationStatus.APPROVED, inviteError: { not: null } },
      ],
    },
    orderBy: { submittedAt: 'asc' },
  });
}
```

```typescript
// AFTER
async listPending(platforms?: string[]) {
  const rows = await prisma.userCreationRequest.findMany({
    where: {
      ...(platforms ? { platform: { in: platforms } } : {}),
      OR: [
        { status: UserCreationStatus.PENDING },
        { status: UserCreationStatus.APPROVED, inviteError: { not: null } },
      ],
    },
    orderBy: { submittedAt: 'asc' },
  });
  return rows.map(normalizeInviteLink);
}
```

No other call site in this file needs a code change (`ensureDraftForUser` lines
51/76/101/112, `submitRequest` lines 165/219, `getMyRequest` line 225,
`getMyRequests` line 231, `reviewRequest`/`_executeInvite` lines 328/426/464,
`resendInvite` line 547) — they already pass rows that carry `.platform`, so the
new per-row resolution applies automatically.

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```
Watch `backend/src/services/access-workflow.test.ts` (constructs a mock invite
link from `config.redash.baseUrl` — confirm it still passes since prod's default
path is unchanged) and any user-creation service tests.

---

## Phase 2 — Pre-existing bug: hardcoded Redash default-group id on invite (Finding 3)

### 2.1 `backend/src/services/redash.provisioner.ts` — stop guessing group membership at invite time

```typescript
// BEFORE (inviteUser, create branch)
create: {
  platform: this.platform,
  externalId,
  name,
  email: email.toLowerCase(),
  isDisabled: false,
  isPending: true,
  externalGroupIds: ['1'], // Redash "default" group
  lastSyncedAt: new Date(),
},
```

```typescript
// AFTER
create: {
  platform: this.platform,
  externalId,
  name,
  email: email.toLowerCase(),
  isDisabled: false,
  isPending: true,
  // No group membership is known yet at invite time — querying Redash's real
  // "default" group id synchronously here would mean an extra API round-trip
  // before the cache is even populated, and the id isn't guaranteed to be the
  // same across instances (prod vs QA may seed differently). Leaving this
  // empty is accurate: a brand-new invited user isn't confirmed to be in any
  // group yet. The next syncUsers() cycle populates the real value from the
  // Redash API's user.groups field — the source of truth.
  externalGroupIds: [],
  lastSyncedAt: new Date(),
},
```

**Verified safe:** no test asserts on `externalGroupIds: ['1']` or an invite's
initial membership; `redash-import.service.ts`'s consumer of `externalGroupIds`
just iterates whatever's present (empty array is a no-op); `recomputeGroupMemberCounts`
tallying an empty array simply means this brand-new user doesn't count toward any
group's member count until the next sync — correct, since they aren't actually a
confirmed member yet.

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```

---

## Phase 3 — Pre-existing bug: missing immutability guard in `updateGroupLevel` (Finding 4)

### 3.1 `backend/src/controllers/admin-management.controller.ts`

`updateGroup` (lines 627-719) already has this guard:
```typescript
const adapter = provisioningRegistry.tryGet(existing.platform);
const externalGroupIdChanged =
  data.externalGroupId !== undefined && data.externalGroupId !== existing.externalGroupId;
if (externalGroupIdChanged && !adapter?.reconcileMembers) {
  throw new ValidationError(
    `The external group mapping is immutable for the "${existing.platform}" platform.`,
  );
}
```

`updateGroupLevel` (lines 1492-1603) is missing the equivalent. Its current
validation block:
```typescript
// BEFORE
if (
  data.externalGroupId !== undefined &&
  data.externalGroupId !== existing.externalGroupId
) {
  const validateAdapter = provisioningRegistry.has(group.platform)
    ? provisioningRegistry.get(group.platform)
    : null;
  if (data.externalGroupId)
    {validateAdapter?.validateExternalGroupId?.(data.externalGroupId);}
}
```

```typescript
// AFTER — add the immutability guard first, then keep format validation
const adapter = provisioningRegistry.tryGet(group.platform);
const externalGroupIdChangedForGuard =
  data.externalGroupId !== undefined && data.externalGroupId !== existing.externalGroupId;
if (externalGroupIdChangedForGuard && !adapter?.reconcileMembers) {
  throw new ValidationError(
    `The external group mapping is immutable for the "${group.platform}" platform.`,
  );
}

if (
  data.externalGroupId !== undefined &&
  data.externalGroupId !== existing.externalGroupId
) {
  if (data.externalGroupId)
    {adapter?.validateExternalGroupId?.(data.externalGroupId);}
}
```

Notes:
- New local named `externalGroupIdChangedForGuard` (not `externalGroupIdChanged`)
  to avoid colliding with the existing `const externalGroupIdChanged = ...`
  declared later in the function (used post-update for the audit entry and the
  `reconcileExternalGroupChange` branch) — both evaluate the identical condition,
  this is a pure naming disambiguation with zero behavior difference.
- `provisioningRegistry.has(...) ? provisioningRegistry.get(...) : null` is
  replaced by `provisioningRegistry.tryGet(...)` — behaviorally identical, matches
  `updateGroup`'s own style.
- `ValidationError` is already imported in this controller.

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```

---

## Phase 4 — Efficiency: parallelize independent per-platform loops (Finding 5)

**Decision on `syncSinglePlatform`:** leave sequential. Its own comment ("Groups
first, then users — member counts depend on both") is a real data dependency:
`syncUsers()` ends by calling `recomputeGroupMemberCounts()`, which reads
`platformExternalGroup` rows that `syncGroups()` populates. Parallelizing risks
reading a stale/incomplete group cache. **Do not change this one.**

### 4.1 `backend/src/services/sync.service.ts` — parallelize `syncAllPlatforms()`

```typescript
// BEFORE (lines 36-59)
async syncAllPlatforms(): Promise<{ usersSynced: number; groupsSynced: number }> {
  logger.info('🔄 SyncService: Starting sync across all platforms...');
  let usersSynced = 0;
  let groupsSynced = 0;

  for (const platform of provisioningRegistry.listPlatforms()) {
    if (platform === 'aws' && !config.aws.isEnabled) {
      logger.info('🔄 SyncService: Skipping AWS sync because it is disabled.');
      continue;
    }
    try {
      const result = await this.syncSinglePlatform(platform);
      usersSynced += result.usersSynced;
      groupsSynced += result.groupsSynced;
    } catch (err: any) {
      logger.error({ platform, error: err.message }, '🔄 SyncService: Platform sync failed');
    }
  }

  this.lastSyncedAt = new Date();
  logger.info(`🔄 SyncService: Sync complete — ${usersSynced} users, ${groupsSynced} groups.`);
  return { usersSynced, groupsSynced };
}
```

```typescript
// AFTER
/** Refresh the cache for every registered platform. Each platform's sync runs
 *  concurrently — platforms are independent (different cache rows, different
 *  adapters). Per-platform failures are isolated via Promise.allSettled so one
 *  bad platform can't block or fail the rest. */
async syncAllPlatforms(): Promise<{ usersSynced: number; groupsSynced: number }> {
  logger.info('🔄 SyncService: Starting sync across all platforms...');

  const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
    if (platform === 'aws' && !config.aws.isEnabled) {
      logger.info('🔄 SyncService: Skipping AWS sync because it is disabled.');
      return false;
    }
    return true;
  });

  const results = await Promise.allSettled(
    platforms.map((platform) => this.syncSinglePlatform(platform)),
  );

  let usersSynced = 0;
  let groupsSynced = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      usersSynced += result.value.usersSynced;
      groupsSynced += result.value.groupsSynced;
    } else {
      logger.error(
        { platform: platforms[i], error: result.reason?.message ?? String(result.reason) },
        '🔄 SyncService: Platform sync failed',
      );
    }
  });

  this.lastSyncedAt = new Date();
  logger.info(`🔄 SyncService: Sync complete — ${usersSynced} users, ${groupsSynced} groups.`);
  return { usersSynced, groupsSynced };
}
```
Note: the `platform === 'aws'` check inside `.filter()` here is intentionally
left as-is for this phase — it gets replaced by the generic adapter hook in
**Phase 5**, so Phase 5's diff against this block stays clean.

### 4.2 `backend/src/services/admin-reconciliation.service.ts` — parallelize `reconcilePlatformAdmins()`

Verified: `zero()` (line 16: `const zero = (): ReconcileCounts => ({ added: 0, removed: 0, checked: 0 });`)
is a factory function, not a shared mutable object — safe to call fresh inside a
parallel map callback.

```typescript
// BEFORE (lines 86-129)
private async reconcilePlatformAdmins(dryRun: boolean): Promise<ReconcileCounts> {
  const counts = zero();
  const tag = dryRun ? '[dry-run] would' : '';

  for (const platform of provisioningRegistry.listPlatforms()) {
    if (platform === 'aws' && !config.aws.isEnabled) {
      logger.debug('🔁 Reconcile: Skipping platform-admin reconciliation for AWS because it is disabled.');
      continue;
    }
    try {
      const kcIds = new Set(await keycloakAdminService.getUsersInRole(platformAdminRole(platform)));
      const mirror = await prisma.platformAdmin.findMany({ where: { platform } });
      const mirrorIds = new Set(mirror.map((m) => m.userId));
      counts.checked += 1;

      for (const userId of kcIds) {
        if (mirrorIds.has(userId)) continue;
        if (!dryRun) {
          const p = await this.resolveProfile(userId);
          await prisma.platformAdmin.upsert({
            where: { userId_platform: { userId, platform } },
            update: { userName: p.userName, userEmail: p.userEmail },
            create: { userId, platform, userName: p.userName, userEmail: p.userEmail, assignedBy: 'reconcile' },
          });
        }
        counts.added += 1;
        logger.warn(`🔁 Reconcile: ${tag} add missing platform_admin mirror (${userId} / ${platform}).`);
      }

      for (const m of mirror) {
        if (kcIds.has(m.userId)) continue;
        if (!dryRun) await prisma.platformAdmin.delete({ where: { id: m.id } });
        counts.removed += 1;
        logger.warn(`🔁 Reconcile: ${tag} remove stale platform_admin mirror (${m.userId} / ${platform}).`);
      }
    } catch (err: any) {
      logger.error(`🔁 Reconcile: platform-admin reconcile failed for "${platform}": ${err.message}`);
    }
  }

  return counts;
}
```

```typescript
// AFTER
private async reconcilePlatformAdmins(dryRun: boolean): Promise<ReconcileCounts> {
  const counts = zero();
  const tag = dryRun ? '[dry-run] would' : '';

  const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
    if (platform === 'aws' && !config.aws.isEnabled) {
      logger.debug('🔁 Reconcile: Skipping platform-admin reconciliation for AWS because it is disabled.');
      return false;
    }
    return true;
  });

  // Each platform's reconciliation touches only its own PlatformAdmin rows and
  // its own Keycloak role — independent work, run concurrently. allSettled keeps
  // one platform's failure from blocking the others' counts.
  const results = await Promise.allSettled(
    platforms.map(async (platform): Promise<ReconcileCounts> => {
      const kcIds = new Set(await keycloakAdminService.getUsersInRole(platformAdminRole(platform)));
      const mirror = await prisma.platformAdmin.findMany({ where: { platform } });
      const mirrorIds = new Set(mirror.map((m) => m.userId));
      const platformCounts = zero();
      platformCounts.checked += 1;

      for (const userId of kcIds) {
        if (mirrorIds.has(userId)) continue;
        if (!dryRun) {
          const p = await this.resolveProfile(userId);
          await prisma.platformAdmin.upsert({
            where: { userId_platform: { userId, platform } },
            update: { userName: p.userName, userEmail: p.userEmail },
            create: { userId, platform, userName: p.userName, userEmail: p.userEmail, assignedBy: 'reconcile' },
          });
        }
        platformCounts.added += 1;
        logger.warn(`🔁 Reconcile: ${tag} add missing platform_admin mirror (${userId} / ${platform}).`);
      }

      for (const m of mirror) {
        if (kcIds.has(m.userId)) continue;
        if (!dryRun) await prisma.platformAdmin.delete({ where: { id: m.id } });
        platformCounts.removed += 1;
        logger.warn(`🔁 Reconcile: ${tag} remove stale platform_admin mirror (${m.userId} / ${platform}).`);
      }

      return platformCounts;
    }),
  );

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      counts.checked += result.value.checked;
      counts.added += result.value.added;
      counts.removed += result.value.removed;
    } else {
      logger.error(`🔁 Reconcile: platform-admin reconcile failed for "${platforms[i]}": ${result.reason?.message ?? result.reason}`);
    }
  });

  return counts;
}
```
Same `platform === 'aws'` note as 4.1 — replaced generically in Phase 5.

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```
Check `sync.service.test.ts` and any admin-reconciliation test for assertions
that depend on call *order* (mock call sequence) rather than final aggregate
totals — `Promise.allSettled` runs concurrently, not left-to-right. If any such
test exists, adjust it to assert on final state instead.

---

## Phase 5 — Cleanup: generic `isEnabled()` adapter hook replacing hardcoded `platform === 'aws'` (Finding 6)

Depends on Phase 4 (restructures `sync.service.ts`'s loop into `.filter()` form
first, so this phase's diff against it is additive/clean).

### 5.1 `backend/src/services/provisioner.interface.ts` — add the optional hook

Insert right after the existing `isSimulation?(): boolean;` declaration:
```typescript
/**
 * Optional: whether this platform is currently administratively enabled. AWS is
 * the only adapter that can be toggled off (config.aws.isEnabled, driven by
 * AWS_ENABLED via scripts/toggle-aws.ts) without being unregistered — a disabled
 * platform must still resolve via the registry (existing grants/history reference
 * it) but should be hidden from sync, admin-manageable-platform lists, and
 * platform-admin reconciliation. Adapters that omit this are treated as always
 * enabled (undefined ⇒ enabled) — only an adapter with a real on/off switch needs
 * to implement it.
 */
isEnabled?(): boolean;
```

### 5.2 `backend/src/services/aws.provisioner.ts` — implement it

```typescript
// BEFORE
export class AwsProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;
  readonly displayName = 'AWS';

  // ── Provisioning lifecycle ────────────────────────────────────────────────
```

```typescript
// AFTER
export class AwsProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;
  readonly displayName = 'AWS';

  /** Whether the AWS platform is administratively enabled (AWS_ENABLED, toggle-aws.ts). */
  isEnabled(): boolean {
    return config.aws.isEnabled;
  }

  // ── Provisioning lifecycle ────────────────────────────────────────────────
```
(`config` is already imported in this file.)

### 5.3 `backend/src/utils/authz.ts` — replace the hardcoded filter, and drop the now-unused `config` import

Verified: `config.` is used exactly ONCE in this entire file (line 138). After
this fix, the `config` import must be removed.

```typescript
// BEFORE
export async function getManageablePlatforms(user: AuthenticatedUser): Promise<string[]> {
  const platforms = isSuperAdmin(user)
    ? provisioningRegistry.listPlatforms()
    : Array.from(await getSnapshot(user).platformAdminPlatforms);
  return platforms.filter((key) => key !== 'aws' || config.aws.isEnabled);
}
```

```typescript
// AFTER
export async function getManageablePlatforms(user: AuthenticatedUser): Promise<string[]> {
  const platforms = isSuperAdmin(user)
    ? provisioningRegistry.listPlatforms()
    : Array.from(await getSnapshot(user).platformAdminPlatforms);
  // Honor each adapter's own enabled/disabled state (optional isEnabled() hook —
  // today only AWS implements it). Adapters without it (Redash, ZooKeeper) are
  // always treated as enabled.
  return platforms.filter((key) => {
    const adapter = provisioningRegistry.tryGet(key);
    return !(adapter?.isEnabled && !adapter.isEnabled());
  });
}
```
**Also delete** the `import config from '../config/config';` line at the top of
`authz.ts` — confirmed it's the only use in the file.

### 5.4 `backend/src/services/sync.service.ts` — replace the Phase-4.1 placeholder check

```typescript
// BEFORE (from Phase 4.1)
const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
  if (platform === 'aws' && !config.aws.isEnabled) {
    logger.info('🔄 SyncService: Skipping AWS sync because it is disabled.');
    return false;
  }
  return true;
});
```

```typescript
// AFTER
const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
  const adapter = provisioningRegistry.tryGet(platform);
  if (adapter?.isEnabled && !adapter.isEnabled()) {
    logger.info(`🔄 SyncService: Skipping ${platform} sync because it is disabled.`);
    return false;
  }
  return true;
});
```
`config` stays imported in this file — it's also used for `config.platform.default` elsewhere (`syncSingleUser`'s default parameter).

### 5.5 `backend/src/controllers/platform.controller.ts` — replace the filter, drop the now-unused `config` import

Verified: `config.` used exactly ONCE in this file (line 24).

```typescript
// BEFORE
const platforms = provisioningRegistry.listPlatforms()
  .filter((key) => key !== 'aws' || config.aws.isEnabled)
  .map((key) => {
```

```typescript
// AFTER
const platforms = provisioningRegistry.listPlatforms()
  .filter((key) => {
    const adapter = provisioningRegistry.get(key);
    return !(adapter.isEnabled && !adapter.isEnabled());
  })
  .map((key) => {
```
(`get()`, not `tryGet()` — `key` comes directly from `listPlatforms()`, always
registered, matching the existing `.map()` below which also calls `.get(key)`.)
**Also delete** `import config from '../config/config';` from this file.

### 5.6 `backend/src/services/admin-reconciliation.service.ts` — replace both sites, drop the now-unused `config` import

Verified: `config.` used exactly TWICE in this file (lines 91, 138), both fixed
here — after both, the import is unused and must go too.

**Site 1** (inside `reconcilePlatformAdmins`, the Phase-4.2 placeholder):
```typescript
// BEFORE
const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
  if (platform === 'aws' && !config.aws.isEnabled) {
    logger.debug('🔁 Reconcile: Skipping platform-admin reconciliation for AWS because it is disabled.');
    return false;
  }
  return true;
});
```
```typescript
// AFTER
const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
  const adapter = provisioningRegistry.tryGet(platform);
  if (adapter?.isEnabled && !adapter.isEnabled()) {
    logger.debug(`🔁 Reconcile: Skipping platform-admin reconciliation for ${platform} because it is disabled.`);
    return false;
  }
  return true;
});
```

**Site 2** (inside `reconcileGroupAdmins`, lines 134-142 — a Prisma query filter,
not a loop-skip, so it can't call `adapter.isEnabled()` directly inline; compute
the disabled-platform list once instead):
```typescript
// BEFORE
const groups = await prisma.group.findMany({
  where: {
    OR: [
      { platform: { not: 'aws' } },
      ...(config.aws.isEnabled ? [{ platform: 'aws' }] : []),
    ],
  },
  select: { id: true, slug: true, platform: true },
});
```
```typescript
// AFTER
// Generalizes the old 'aws'-only special case: excludes every currently-disabled
// platform, not just AWS, so a future disable-able platform needs no new branch here.
const disabledPlatforms = provisioningRegistry.listPlatforms().filter((key) => {
  const adapter = provisioningRegistry.tryGet(key);
  return !!(adapter?.isEnabled && !adapter.isEnabled());
});
const groups = await prisma.group.findMany({
  where: {
    platform: { notIn: disabledPlatforms },
  },
  select: { id: true, slug: true, platform: true },
});
```
**Also delete** `import config from '../config/config';` from this file (both
uses removed).

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```
Specifically check `backend/src/test/aws-toggle.test.ts` — the test most likely
to assert on AWS enable/disable behavior; confirm it still passes (the new
generic hook produces identical behavior for AWS, the only adapter implementing it).

---

## Phase 6 — Dead code removal (Finding 7)

Confirmed via full-repo grep: zero callers of `getAdminGroupSlugsFromRoles`,
`checkIsGroupAdmin`, `checkIsPlatformAdmin`, `getPlatformAdminPlatformsFromRoles`
anywhere outside their own definitions. Zero test files reference any of these
4 names either — no companion test deletion needed.

### 6.1 `backend/src/middleware/auth.middleware.ts` — delete lines 206-317 entirely

Delete the whole block: the `NOTE (mirror-authoritative model)` comment, the
parsing-edge comment, and all 4 function definitions (`getAdminGroupSlugsFromRoles`,
`checkIsGroupAdmin`, `getPlatformAdminPlatformsFromRoles`, `checkIsPlatformAdmin`).
The file should end cleanly at line 204 (the `};` closing `requireRole`) with no
trailing dead code. No other export/import in this file depends on anything in
the deleted block (pure tail append, no forward references).

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```
`npx tsc --noEmit` is the fastest confirmation — it would immediately surface a
TS2305 error if anything still imported these names.

---

## Phase 7 — Reuse/dedup: shared helpers for AWS/Redash provisioner duplication (Finding 8)

**Highest regression-risk phase** (touches both live adapters' sync paths) —
land it after the smaller/safer phases so any earlier regression surfaces first.
ZooKeeper's provisioner has neither method (no sync concept) — correctly left untouched.

### 7.1 `backend/src/services/adapter-helpers.ts` (NEW FILE)

```typescript
import prisma from '../config/prisma';
import logger from '../utils/logger';

/** Minimal per-user shape both adapters can map their own user type into. */
export interface SyncedUserForWorkflow {
  externalId: string;
  email: string;
  name: string;
  isPending: boolean;
  /** Omit or false for adapters (AWS) whose user type has no disabled concept. */
  isDisabled?: boolean;
}

/**
 * Notify the user-creation workflow about every active platform user so any
 * APPROVED/AWAITING_SETUP account-creation request can advance to COMPLETED.
 * Shared by RedashProvisioner and AwsProvisioner (identical logic, differing
 * only in how each adapter maps its own user type into SyncedUserForWorkflow).
 * Loaded lazily to avoid a static import cycle (user-creation → sync → registry
 * → adapter); per-user try/catch so one failure can't break the rest of the batch.
 */
export async function notifyUserCreationWorkflow(
  platform: string,
  users: SyncedUserForWorkflow[],
): Promise<void> {
  const tracked = await prisma.userCreationRequest.findMany({
    where: { platform },
    select: { userEmail: true },
  });
  if (tracked.length === 0) return;
  const trackedEmails = new Set(tracked.map((r) => r.userEmail.toLowerCase()));

  const { default: userCreationService } = await import('./user-creation.service');
  for (const u of users) {
    if (u.isDisabled) continue;
    if (!trackedEmails.has(u.email.toLowerCase())) continue;
    try {
      await userCreationService.handlePlatformUserDetected(platform, {
        externalId: u.externalId,
        email: u.email,
        name: u.name,
        isPending: u.isPending,
      });
    } catch (err: any) {
      logger.error(
        { platform, externalId: u.externalId, email: u.email, error: err.message },
        'handlePlatformUserDetected failed for one user; continuing batch',
      );
    }
  }
}

/** Recompute and persist member counts for every cached group of one platform. */
export async function recomputeGroupMemberCounts(platform: string): Promise<void> {
  const [groups, users] = await Promise.all([
    prisma.platformExternalGroup.findMany({ where: { platform }, select: { id: true, externalId: true } }),
    prisma.platformExternalUser.findMany({ where: { platform }, select: { externalGroupIds: true } }),
  ]);
  const counts = new Map<string, number>();
  for (const u of users) {
    for (const gid of u.externalGroupIds) {
      counts.set(gid, (counts.get(gid) ?? 0) + 1);
    }
  }
  const updates = groups.map((group) =>
    prisma.platformExternalGroup.update({
      where: { id: group.id },
      data: { memberCount: counts.get(group.externalId) ?? 0 },
    }),
  );
  if (updates.length) await prisma.$transaction(updates);
}
```

### 7.2 `backend/src/services/redash.provisioner.ts` — call the shared helpers

Add the import: `import { notifyUserCreationWorkflow, recomputeGroupMemberCounts } from './adapter-helpers';`

Delete the private `recomputeGroupMemberCounts` method (lines 322-343) and the
private `notifyUserCreationWorkflow` method (lines 352-383) entirely.

Update the call sites inside `syncUsers()`:
```typescript
// BEFORE
await this.recomputeGroupMemberCounts();
await this.notifyUserCreationWorkflow(redashUsers);
```
```typescript
// AFTER
await recomputeGroupMemberCounts(this.platform);
await notifyUserCreationWorkflow(
  this.platform,
  redashUsers.map((u) => ({
    externalId: u.id.toString(),
    email: u.email,
    name: u.name,
    isPending: u.is_invitation_pending,
    isDisabled: u.is_disabled,
  })),
);
```

Update `syncSingleUser()`'s call site:
```typescript
// BEFORE
if (!user.is_disabled) {
  await this.notifyUserCreationWorkflow([user]);
}
```
```typescript
// AFTER
if (!user.is_disabled) {
  await notifyUserCreationWorkflow(this.platform, [{
    externalId: user.id.toString(),
    email: user.email,
    name: user.name,
    isPending: user.is_invitation_pending,
    isDisabled: user.is_disabled,
  }]);
}
```

### 7.3 `backend/src/services/aws.provisioner.ts` — call the shared helpers

Add the import: `import { notifyUserCreationWorkflow, recomputeGroupMemberCounts } from './adapter-helpers';`

Delete the private `recomputeGroupMemberCounts` method (lines 409-429) and the
private `notifyUserCreationWorkflow` method (lines 307-335) entirely.

Update the call sites inside `syncUsers()` (verified exact lines: 270-271):
```typescript
// BEFORE
await this.recomputeGroupMemberCounts();
await this.notifyUserCreationWorkflow(users);
```
```typescript
// AFTER — `users` here is `IdcUser[]` (confirmed shape: userId/displayName/email/isPending/groupIds, no disabled concept)
await recomputeGroupMemberCounts(PLATFORM);
await notifyUserCreationWorkflow(
  PLATFORM,
  users.map((u) => ({
    externalId: u.userId,
    email: u.email,
    name: u.displayName,
    isPending: u.isPending,
  })),
);
```

Update `syncSingleUser()`'s call site (verified exact line: 296):
```typescript
// BEFORE
await this.notifyUserCreationWorkflow([user]);
return true;
```
```typescript
// AFTER
await notifyUserCreationWorkflow(PLATFORM, [{
  externalId: user.userId,
  email: user.email,
  name: user.displayName,
  isPending: user.isPending,
  // IdcUser has no disabled flag — omit isDisabled so the shared helper's
  // `if (u.isDisabled) continue;` never skips an AWS user.
}]);
return true;
```

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run
```
Run the full suite and specifically confirm any AWS/Redash sync-related test
still passes — this phase touches core sync logic in both adapters.

---

## Phase 8 — Config cleanup: `displayName` field + eliminate magic string (Findings 9, 10)

### 8.1 `backend/src/config/config.ts` — add `displayName` to each `redashInstances` entry

```typescript
// BEFORE (lines 104-132)
get redashInstances() {
  return [
    {
      key: 'redash',
      family: 'redash',
      label: 'Prod',
      baseUrl: config.redash.baseUrl,
      apiKey: config.redash.apiKey,
      isSimulation: config.redash.isSimulation,
    },
    {
      key: 'redash-qa',
      family: 'redash',
      label: 'QA',
      get baseUrl() { return process.env.REDASH_QA_BASE_URL || ''; },
      get apiKey() { return process.env.REDASH_QA_API_KEY || 'dummy-key-for-development'; },
      get isSimulation() {
        return process.env.REDASH_QA_SIMULATION === 'true' || this.apiKey === 'dummy-key-for-development';
      },
    },
  ];
},
```

```typescript
// AFTER
get redashInstances() {
  return [
    {
      key: 'redash',
      family: 'redash',
      label: 'Prod',
      displayName: 'Redash',
      baseUrl: config.redash.baseUrl,
      apiKey: config.redash.apiKey,
      isSimulation: config.redash.isSimulation,
    },
    {
      key: 'redash-qa',
      family: 'redash',
      label: 'QA',
      displayName: 'Redash (QA)',
      get baseUrl() { return process.env.REDASH_QA_BASE_URL || ''; },
      get apiKey() { return process.env.REDASH_QA_API_KEY || 'dummy-key-for-development'; },
      get isSimulation() {
        return process.env.REDASH_QA_SIMULATION === 'true' || this.apiKey === 'dummy-key-for-development';
      },
    },
  ];
},
```

### 8.2 `backend/src/services/redash.provisioner.ts` — consume `displayName` directly, drop the ternary

```typescript
// BEFORE
export function createRedashProvisioner(instance: {
  key: string; family: string; label: string; service: RedashService;
}): RedashProvisioner {
  const displayName = instance.label === 'Prod' ? 'Redash' : `Redash (${instance.label})`;
  return new RedashProvisioner({
    platform: instance.key, displayName, family: instance.family, label: instance.label, service: instance.service,
  });
}
```

```typescript
// AFTER
export function createRedashProvisioner(instance: {
  key: string; family: string; label: string; displayName: string; service: RedashService;
}): RedashProvisioner {
  return new RedashProvisioner({
    platform: instance.key,
    displayName: instance.displayName,
    family: instance.family,
    label: instance.label,
    service: instance.service,
  });
}
```

Update the back-compat default export at the bottom of the same file:
```typescript
// BEFORE
export const redashProvisioner = createRedashProvisioner({
  key: 'redash', family: 'redash', label: 'Prod', service: redashService,
});
```
```typescript
// AFTER
export const redashProvisioner = createRedashProvisioner({
  key: 'redash', family: 'redash', label: 'Prod', displayName: 'Redash', service: redashService,
});
```

Update the doc comment above `createRedashProvisioner` to describe the new
direct-`displayName` design instead of the removed derivation logic.

### 8.3 `backend/src/services/provisioning.registry.ts` — no diff needed

The constructor loop does `createRedashProvisioner({ ...instance, service })`;
since `instance` now includes `displayName` from `config.redashInstances`, this
typechecks without any change here. Just confirm with `npx tsc --noEmit` after 8.1/8.2.

### 8.4 Finding 9 — no structural change to `config.redash`

Documented decision, no code diff: `config.redash` stays as the legitimate
back-compat prod accessor. The only broken external reader (`redash-url.ts`) was
already fixed in Phase 1 (function now takes an explicit `baseUrl`).
`redash.service.ts`'s back-compat `redashService` export legitimately builds the
prod instance's config from `config.redash.*` — that IS what `config.redash`
means. `access-workflow.test.ts` and `backend/scripts/reset-for-live-redash.ts`
(explicitly prod-only per its name) are both correct as-is.

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run -- redash-multi-instance
npm run test:run
```
`redash-multi-instance.test.ts` already asserts `qa.displayName === 'Redash (QA)'`
— confirm the new direct-field approach still produces that exact value.

---

## Phase 9 — Frontend: dedup + three "reviewed, no action" notes (Findings 11, 13, 14, 15)

### 9.1 Finding 11 — dedupe `platformDisplayName` logic (REAL WORK)

**`frontend/src/pages/Dashboard.tsx`**

Add import: `import { platformDisplayName } from '../lib/platforms';`

```typescript
// BEFORE (lines 107-114)
const livePlatforms = platformsQuery.data ?? [];
const platformsByKey = new Map(livePlatforms.map((p) => [p.key, p]));
const accountByPlatform = new Map((accountsQuery.data ?? []).map((a) => [a.platform, a]));

const platformLabel = (key: string) =>
  platformsByKey.get(key)?.displayName ?? key.charAt(0).toUpperCase() + key.slice(1);
```

```typescript
// AFTER — delete ONLY platformsByKey and platformLabel.
// IMPORTANT: `livePlatforms` must be KEPT — verified it's used elsewhere in this
// file (the "My Platform Accounts" section, `livePlatforms.length`/`.map(...)`
// around lines 276-280), not just to build the now-deleted platformsByKey.
const livePlatforms = platformsQuery.data ?? [];
const accountByPlatform = new Map((accountsQuery.data ?? []).map((a) => [a.platform, a]));
```

Replace the 3 `platformLabel(...)` call sites with `platformDisplayName(...)`:
- Line 123: `platformLabel(a[0]).localeCompare(platformLabel(b[0]))` → `platformDisplayName(a[0]).localeCompare(platformDisplayName(b[0]))`
- Line 127: `` `${platformLabel(key)} ${list.length}` `` → `` `${platformDisplayName(key)} ${list.length}` ``
- Line 350: `{platformLabel(platformKey)}` → `{platformDisplayName(platformKey)}`

**`frontend/src/pages/PendingApprovals.tsx`**

Add import: `import { platformDisplayName } from '../lib/platforms';`

```typescript
// BEFORE (lines 64-70)
const { data: livePlatforms = [] } = useQuery<LivePlatform[]>({
  queryKey: queryKeys.platforms(),
  queryFn: fetchPlatforms,
});
const platformsByKey = new Map(livePlatforms.map((p) => [p.key, p]));
const platformLabel = (key: string) =>
  platformsByKey.get(key)?.displayName ?? key.charAt(0).toUpperCase() + key.slice(1);
```

```typescript
// AFTER — the query call itself must stay (it's what populates the live-name
// cache via registerLivePlatforms() inside fetchPlatforms, which
// platformDisplayName() reads from); only platformsByKey/platformLabel go away.
// Confirm `livePlatforms` has no other reader in this file before dropping the
// destructure — if truly unused, this bare-call form avoids an eslint
// unused-variable warning:
useQuery<LivePlatform[]>({
  queryKey: queryKeys.platforms(),
  queryFn: fetchPlatforms,
});
```

Replace the 1 call site: line 417, `{platformLabel(req.group.platform)}` → `{platformDisplayName(req.group.platform)}`.

Keep the `LivePlatform` type import (still used in the `useQuery<LivePlatform[]>` generic).

### 9.2 Finding 13 — AdminManagement.tsx warm-up query flash: **NO ACTION**

Verified: the warm-up query (`useQuery({ queryKey: queryKeys.platforms(), queryFn: fetchPlatforms })`,
uncaptured) isn't gated by the `platformsQuery.isLoading` guard. All 3
`prettyPlatform` consumers are confirmed to render only after that guard, so the
only possible symptom is a brief, self-correcting flash of fallback text before
the warm-up query resolves — once per cold-cache page load. **Decision: leave
as-is.** Gating the whole page's loading spinner on a second network round-trip
just to avoid a one-render-cycle label flash is not a good trade. No code change.

### 9.3 Finding 14 — `liveDisplayNames` module cache: **NO ACTION**

Verified: `liveDisplayNames` is a plain module-level object mutated synchronously
inside `registerLivePlatforms()`, driven by exactly one TanStack Query key
(`queryKeys.platforms()`) across all 8 call sites. JS is single-threaded, so
there's no realistic concurrent-refetch race producing an inconsistent read.
**Decision: leave as-is** — a pragmatic, low-risk solution to threading a live
registry value into deeply-nested components that only receive a bare platform
key. No code change.

### 9.4 Finding 15 — `family`/`label` on `PlatformAdapter`: **NO ACTION**

Verified: both fields are optional and already in place; every adapter that
doesn't set them defaults sensibly (ungrouped card). Low-cost, no adapter
breaks. **Decision: no code change.**

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\frontend"
npx tsc --noEmit
npm run lint
npm run test:run
```
Manually smoke-check Dashboard.tsx and PendingApprovals.tsx still render
platform labels correctly for both a live-registered platform and an
unregistered/future one (fallback capitalization) — `platformDisplayName()`'s
fallback chain (live cache → static PLATFORMS metadata → capitalize) is
equivalent to the deleted inline closures.

---

## Phase 10 — Test hygiene: registry `unregister()` + test cleanup (test-pollution finding)

Last phase — purely additive/isolated, lowest risk, benefits from every
functional phase already being stable.

### 10.1 `backend/src/services/provisioning.registry.ts` — add `unregister()`

Insert immediately after the existing `register()` method:
```typescript
/**
 * Remove a platform's adapter. Primarily for test cleanup: a test that
 * registers a throwaway fake adapter on the shared singleton (register()
 * mutates the real exported registry — there's no per-test instance) must undo
 * it in afterEach, since vi.restoreAllMocks() does not touch a plain Map.set.
 * No-op if the platform was never registered.
 */
unregister(platform: string): void {
  const key = platform.toLowerCase();
  this.registry.delete(key);
  logger.info(`🔌 Provisioning Registry: Unregistered provisioner for platform "${key}"`);
}
```

### 10.2 `backend/src/test/redash-multi-instance.test.ts` — clean up fake registrations

```typescript
// BEFORE
describe('PlatformController family/label mapping', () => {
  function makeReqRes() { /* ... unchanged ... */ }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces an adapter\'s own family/label when set', async () => {
    const fakeAdapter = { platform: 'test-fake-a', displayName: 'Fake A', family: 'fake-family', label: 'Beta', healthCheck: vi.fn() };
    provisioningRegistry.register('test-fake-a', fakeAdapter as any);
    /* ... assertions ... */
  });

  it('defaults family to the platform key and label to null when unset', async () => {
    const fakeAdapter = { platform: 'test-fake-b', displayName: 'Fake B', healthCheck: vi.fn() };
    provisioningRegistry.register('test-fake-b', fakeAdapter as any);
    /* ... assertions ... */
  });
});
```

```typescript
// AFTER — add a shared testKeys list and unregister them in afterEach
describe('PlatformController family/label mapping', () => {
  const testKeys = ['test-fake-a', 'test-fake-b'];

  function makeReqRes() { /* ... unchanged ... */ }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of testKeys) provisioningRegistry.unregister(key);
  });

  it('surfaces an adapter\'s own family/label when set', async () => {
    const fakeAdapter = { platform: 'test-fake-a', displayName: 'Fake A', family: 'fake-family', label: 'Beta', healthCheck: vi.fn() };
    provisioningRegistry.register('test-fake-a', fakeAdapter as any);
    /* ... assertions unchanged ... */
  });

  it('defaults family to the platform key and label to null when unset', async () => {
    const fakeAdapter = { platform: 'test-fake-b', displayName: 'Fake B', healthCheck: vi.fn() };
    provisioningRegistry.register('test-fake-b', fakeAdapter as any);
    /* ... assertions unchanged ... */
  });
});
```

### Verification
```powershell
cd "D:\Bachatt\Hermes 2\backend"
npx tsc --noEmit
npm run lint
npm run test:run -- redash-multi-instance
npm run test:run
```

---

## Phase ordering rationale

| Phase | Findings | Why here |
|---|---|---|
| 1 | 1, 2 | Critical, user-facing data-corruption bug; landed together since 2 depends on 1's signature change |
| 2 | 3 | Pre-existing bug, independent |
| 3 | 4 | Pre-existing bug, independent, small |
| 4 | 5 | Efficiency; done before Phase 5 restructures the same loops further |
| 5 | 6 | Cleanup; depends on Phase 4's `.filter()` restructuring already being in place |
| 6 | 7 | Dead code removal; zero-risk (compiler-verified), done early |
| 7 | 8 | Reuse/dedup; highest regression risk, placed after smaller/safer phases |
| 8 | 9, 10 | Config cleanup; small, benefits from Phase 1 already landing |
| 9 | 11, 13, 14, 15 | Frontend-only, independent of backend phases |
| 10 | test pollution | Most isolated, lowest risk, benefits from everything else being stable |

## Critical files touched (backend)
- `backend/src/utils/redash-url.ts`
- `backend/src/services/user-creation.service.ts`
- `backend/src/services/redash.provisioner.ts`
- `backend/src/services/redash.service.ts`
- `backend/src/services/aws.provisioner.ts`
- `backend/src/services/adapter-helpers.ts` (new)
- `backend/src/services/provisioner.interface.ts`
- `backend/src/services/provisioning.registry.ts`
- `backend/src/config/config.ts`
- `backend/src/controllers/admin-management.controller.ts`
- `backend/src/controllers/platform.controller.ts`
- `backend/src/utils/authz.ts`
- `backend/src/services/sync.service.ts`
- `backend/src/services/admin-reconciliation.service.ts`
- `backend/src/middleware/auth.middleware.ts`
- `backend/src/test/redash-multi-instance.test.ts`

## Critical files touched (frontend)
- `frontend/src/pages/Dashboard.tsx`
- `frontend/src/pages/PendingApprovals.tsx`

## Final full-repo verification (run once after all 10 phases land)
```powershell
cd "D:\Bachatt\Hermes 2\backend"; npx tsc --noEmit; npm run lint; npm run test:run
cd "D:\Bachatt\Hermes 2\frontend"; npx tsc --noEmit; npm run lint; npm run test:run
```

## Next steps

This document is the planning deliverable only — no code has been changed yet.
When ready to implement, work through the phases above in order, committing
straight to `main` after each phase's verification passes (per this repo's
no-branches convention).
