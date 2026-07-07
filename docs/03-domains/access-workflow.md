# Domain: Access requests & workflow

**Key files:** `services/access-workflow.service.ts`, `controllers/access-request.controller.ts`,
`services/event-bus.ts`, `services/event-listeners.ts`, `services/default-membership.service.ts`.
Data model: `AccessRequest`, `UserAccess` (see [04-data-model.md](../04-data-model.md)).

This is the core of Hermes. Read [01-architecture.md](../01-architecture.md) first for
the high-level state diagram — this doc goes deeper on each transition.

## Creating a request

**Single** (`POST /api/access-requests`): validates the group exists, the level (if the
group requires one) is active and has a fully-configured `externalGroupId`, the user
doesn't already hold active access, and the user doesn't already have an open request for
that group. Persists as `PENDING`, audits `REQUEST_CREATED`, emits `request.created`
(notifies admins).

**Bulk** (`POST /api/access-requests/bulk`, max 50 items): one DB transaction —
all-or-nothing on a conflict (e.g. a concurrent duplicate submit rolls back the whole
batch), but partial application-level success/failure is reported back as `{ created[],
failed[] }`. Emits **one** consolidated `requests.bulk.created` event so an admin gets a
single Slack ping instead of N.

**Renewal** (`POST /api/access-requests/renew`): only valid if the user already holds
active access to the group; carries their current level forward. Goes through the normal
admin-approval flow — there is no self-service renewal. On approval it's handled by the
same "swap" machinery as a level change (see below), audited as `ACCESS_RENEWED` instead
of `ACCESS_LEVEL_CHANGED`.

There is **no cancel/withdraw endpoint** for a still-pending request — a user who changes
their mind has to wait for an admin to reject it.

## Reviewing a request

`PUT /api/access-requests/:id/review` — admin must pass `isGroupAdminOf()` for the
request's group.

- **Reject**: mark `REJECTED`, audit, emit `request.rejected`. Terminal.
- **Approve**: check the requester's `UserCreationRequest` status for that platform:
  - `DRAFT` / `PENDING` / `REJECTED` → throw `UserNotApprovedError` (their platform
    account has to be approved first — this is a hard stop, not a queue).
  - `APPROVED` / `AWAITING_SETUP` → mark `WAITING_FOR_SETUP`, don't provision yet.
  - `COMPLETED` → mark `PROVISIONING`, call the internal `_provision()`.

Bulk review (`PUT /api/access-requests/bulk/review`, max 100 items) is **sequential, not
parallel**, with per-item auth + error handling, so each requester gets their own
notification and one bad item doesn't block the rest.

## Provisioning (`_provision()`, internal)

1. Resolve the group's (or level's) `externalGroupId`.
2. Call `provisioner.provision({ email, name, userId, externalGroupId, metadata })`.
3. Check for an existing active grant on the same group:
   - same `accessRequestId` → short-circuit to `PROVISIONED` (handles a concurrent
     double-click by an admin).
   - different `accessRequestId` (a level change or renewal) → `_swapGrant()`.
   - none → create a new `UserAccess` row.
4. Mark the request `PROVISIONED`, audit `ACCESS_GRANTED`, emit `request.approved`.

**`provisionWaitingRequests()`** is what clears `WAITING_FOR_SETUP` — it's triggered by
the `user-creation.completed` event (not polled), finds all waiting requests for that
user+platform, and provisions each with per-request try/catch so one failure doesn't
block the others.

## Level changes & renewals (`_swapGrant()`)

Atomic swap, in one DB transaction:
1. Deactivate the old `UserAccess` row (guarded by an `isActive` + row-count check).
2. Create the new `UserAccess` row.
3. Mark the old `AccessRequest` `REVOKED` with reason "Superseded by level change".
4. Mark the new request `PROVISIONED`.
5. Audit `ACCESS_GRANTED` (or `ACCESS_RENEWED` for a same-level renewal, `ACCESS_LEVEL_CHANGED`
   for an actual level swap).

Then, **after the transaction commits** (best-effort, doesn't roll back on failure):
call `provisioner.deprovision({ externalUserId, externalGroupId: oldLevel,
retainExternalGroupId: otherActiveGrantsOnPlatform })`. `retainExternalGroupId` matters
for multi-target adapters like ZooKeeper — it tells the adapter which paths the user
still legitimately holds via *other* groups, so a level swap on one group doesn't strip
access the user still has through another. Single-target adapters (Redash, AWS) ignore
it.

## Expiry (scheduled, hourly in prod)

Per grant with `expiresAt ≤ now` and `isActive = true`:
1. Deactivate.
2. Deprovision from the platform (best-effort).
3. Success → mark request `EXPIRED`, audit `ACCESS_EXPIRED`.
4. Failure (first attempt) → **revert** the deactivation, bump `expiryAttempts`, record
   `lastExpiryError`, let the next scheduler run retry.
5. After `MAX_EXPIRY_ATTEMPTS = 3` failures → force-deactivate regardless, audit
   `ACCESS_EXPIRY_FAILED`, emit `access.expiry-failed` (alerts admins — the user may still
   have platform-side access that needs manual cleanup).

## Revocation (admin-initiated)

`DELETE /api/user-access/:id` (optional `{ reason, force }`):
1. Deactivate the grant.
2. Deprovision (with `retainExternalGroupId`, same reasoning as level swap).
3. If deprovision fails and `force` is false → **revert**, throw. If `force` is true →
   log a warning and proceed anyway (grant stays deactivated despite the platform error).
4. Mark the originating request `REVOKED` if one exists, audit `ACCESS_REVOKED`, emit
   `access.revoked`.

## Admin-added members (bypassing self-service)

`POST /api/admin/groups/:groupId/members` (group admin+): same active-access/open-request
checks as a normal request, same per-platform account gate (`APPROVED`/`AWAITING_SETUP` →
queued as `WAITING_FOR_SETUP`; `COMPLETED` → provisioned immediately). Returns `{ kind:
'provisioned' | 'queued', request }`.

`PUT /api/admin/groups/:groupId/members/:userAccessId/level` — admin override, no
promote/demote gating, re-provisions immediately via `_swapGrant()`.

## Event bus integration

Every state transition above emits an event (see [01-architecture.md](../01-architecture.md#event-bus)
for the full list and rationale). Two listener families react to these events, wired up
in `event-listeners.ts`:

1. **Notifications** — the large majority; see [notifications.md](notifications.md).
2. **Default group membership** (`default-membership.service.ts`) — on
   `user-creation.completed`, idempotently grants the platform's built-in "default" group
   if one exists and Hermes has a matching group record. Registered as an independent
   listener specifically so its failure never blocks the completion notification.

## Non-obvious invariants (things that will trip you up)

- **Expiry is computed at provision time, not at request-creation time.** A 1-day
  request that sits `PENDING` for 3 days before approval expires 1 day *after* approval.
- **`PROVISION_FAILED` is terminal** — there's no retry button in the UI. An admin has to
  create a fresh request or use `adminAddMember`.
- **A level without an `externalGroupId` blocks the request at creation time**, not at
  provisioning time — this is deliberate, to avoid silently falling back to the base
  group's (broader) permissions.
- **One active grant per (user, group)** is enforced by a partial unique index
  (`UserAccess (userId, groupId) WHERE isActive = true`), not purely by application
  logic — a `P2002` from a concurrent approve is caught and treated as "already granted."
- **Removing a group/platform admin does not revoke their group membership**, and vice
  versa — the two are intentionally independent.
- **Rejecting a `UserCreationRequest` cascades** to reject that user's pending/waiting
  access requests **for that platform only** — rejecting their Redash account doesn't
  touch AWS requests.
