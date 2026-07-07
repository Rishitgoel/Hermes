# Operational runbook

Practical "something's wrong, what do I check" guide. Cross-references the domain docs
for the underlying mechanics.

## A request is stuck on `PROVISION_FAILED`

This status is **terminal by design** — there's no retry button. Check
`AccessRequest.provisionError` for the underlying platform error, fix the root cause
(usually a misconfigured `externalGroupId` on the group/level, or the platform being
briefly unreachable), then either have the admin create a fresh request or use
`adminAddMember()` to grant directly. See
[access-workflow.md](03-domains/access-workflow.md#provisioning-_provision-internal).

## A grant won't auto-expire / keeps showing `lastExpiryError`

Check `UserAccess.expiryAttempts` and `lastExpiryError`. The scheduler retries hourly up
to `MAX_EXPIRY_ATTEMPTS = 3`; after that it force-deactivates and audits
`ACCESS_EXPIRY_FAILED` — meaning the Hermes-side grant is gone but the platform-side
access may still exist and needs **manual cleanup on the platform itself**. Search the
audit log for `ACCESS_EXPIRY_FAILED` to find these. See
[access-workflow.md](03-domains/access-workflow.md#expiry-scheduled-hourly-in-prod).

## A `ZookeeperChangeRequest` or `SecretIngestionRequest` is stuck on `APPLYING`

Normally self-heals — a scheduled sweep (every 10 min) flips anything stuck in
`APPLYING` for too long to `APPLY_FAILED`, which is retryable via another review call. If
it's been stuck longer than that, the scheduler itself may not be running — check
process logs for the sweep job, and confirm the scheduler actually started (see
[bootstrap sequence](01-architecture.md#bootstrap-sequence-backendsrcappts)).

## Admin role changes aren't taking effect for a user

Two independent lag sources:
1. **Keycloak → DB mirror lag**: reconciliation runs every 30 min; force it immediately
   with `POST /api/admin/reconcile` (or `?dryRun=true` first to see what would change).
2. **JWT staleness**: even after the mirror is correct, a user's *already-issued* token
   still carries their old roles until they refresh/re-login. `logoutUser()` (called
   automatically on admin removal) forces a re-login but doesn't invalidate the current
   token early. See [02-auth-rbac.md](02-auth-rbac.md).

Remember authorization checks read the **mirror tables**, not Keycloak directly — if the
mirror is right but behavior is still wrong, the bug is elsewhere.

## A platform group was renamed/deleted/recreated outside Hermes and now looks wrong

This is exactly what `syncService.reconcileHermesGroups()` handles automatically (runs
every 15 min, or trigger manually via `POST /api/admin/sync?platform=`). Give it one
sync cycle before investigating further — check whether the group/level got healed,
converted, auto-created, or archived, and look for a fresh audit entry from
`performerName: "Platform Sync"` explaining which. If nothing happened, check whether the
change is within the 10-minute grace period (new/changed things aren't archived
immediately) or whether the platform sync itself is failing (empty-cache abort — check
logs for that platform's sync error). See
[admin-management.md](03-domains/admin-management.md#platform-sync-syncservicets).

## Redash membership looks out of sync with Hermes

Two tools, different purposes:
- **Import** (`POST /api/admin/import-redash-memberships`) — one-way backfill for users
  who have Redash access Hermes never granted (e.g. pre-existing before Hermes managed
  this platform).
- **Resync** (`POST /api/admin/resync-redash-memberships`) — bidirectional correction
  after someone edited Redash membership directly. Has a safety cap on removals (max 20%
  of active grants per run) — if you need to remove more than that in one pass, you'll
  need `force: true`. **Disabled Redash accounts are deliberately left alone** by resync
  — that's the reversible-offboarding model working as intended, not a bug. Read the
  returned report (`RedashResyncModal` in the UI) before assuming something's broken —
  it tells you exactly what it added/swapped/removed. See
  [provisioning.md](03-domains/provisioning.md#redash-prod--qa).

## Notifications aren't arriving (email/Slack)

Check whether the relevant simulation flag is on (`EMAIL_SIMULATION`,
`SLACK_SIMULATION`, `SLACK_DM_SIMULATION`) — if so, calls are logged, not sent, which is
correct for local/dev but wrong in prod if unintentional. Both channels **fail silently
by design** (logged, swallowed) so a Slack/SES outage never blocks an approval — so
"the request went through fine but no Slack ping" usually means a channel-level
misconfiguration, not a backend bug. The in-app notification (check `GET
/api/notifications`) is the ground truth for "did this fire at all." See
[notifications.md](03-domains/notifications.md).

## Multi-replica deployment concerns (relevant to admin-panel, not this repo)

Hermes 2's scheduler has **no leader election** — every job runs in-process, unguarded.
That's correct here because Hermes 2 is always a single process. If you're looking at
this repo's code while debugging a multi-replica issue in **admin-panel**, that's the
wrong place to look — admin-panel wraps the equivalent jobs in a Redis leader lock
(`leader-election.service.ts`, admin-panel-only). See
[06-admin-panel-sync.md](06-admin-panel-sync.md).

## General first move for "something's in a weird state"

1. Check the audit log (`GET /api/audit`, super admin) for the relevant `groupId` /
   `accessRequestId` / `performerId` — every state transition writes one, and it's
   ordered `createdAt DESC`.
2. Check the relevant `*Error` field on the record itself (`provisionError`,
   `lastExpiryError`, `applyError`, `inviteError`) before assuming code is broken — a lot
   of "stuck" states are actually a surfaced platform error waiting for a retry or manual
   fix.
3. Confirm which simulation flags are on — a surprising number of "why didn't X happen"
   questions are answered by "that integration is simulated right now."
