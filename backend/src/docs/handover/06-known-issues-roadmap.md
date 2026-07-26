# Known issues, limits & roadmap

Honest list of the sharp edges, the deliberate-tradeoff limits, and the open work — so the
next maintainer isn't surprised by them.

---

## Deliberate limits (working as designed — don't "fix" without understanding why)

- **Best-effort platform side.** A committed Hermes state change is never rolled back if the
  platform call fails afterward. This is intentional (see
  [01-core-access-flow.md](01-core-access-flow.md)) — the failure surfaces as an error field
  + audit entry for manual cleanup, not a rollback.
- **Notifications are fire-and-forget.** Email/Slack failures are logged and dropped; there
  is no retry queue. The in-app notification + audit log are the durable record.
- **`checkUserStatus` is a cache-only read for every platform** — it never hits the live
  platform API. A stale answer means "resync," not "code bug."
- **ZooKeeper is world-open by design.** No per-user credentials; the Hermes DB *is* the
  access record, and enforcement is at the app layer because the ensemble is network-
  isolated. Don't try to add per-znode ACLs — that's not the model.
- **AWS offboarding is irreversible** (delete), Redash's is reversible (soft-disable). Resync
  intentionally leaves disabled Redash accounts alone.

---

## Real gaps & things to watch

- **Secret ingestion is the least mature integration** — no multi-instance, no background
  sync, and its approval workflow is a *separate implementation* from the structurally-
  identical ZooKeeper change-request workflow. If you fix a bug in one, check the other.
- **In-process locks don't cross replicas.** The per-user (Redash) and per-path (ZooKeeper)
  mutexes that stop concurrent membership writes from clobbering each other are
  **in-process only**. In admin-panel's multi-replica prod, the *leader lock* protects the
  scheduler's shared-state work, but two replicas each handling an API-driven approval for
  the same Redash user at the same instant are not serialized against each other. Rare, but
  it's the one concurrency hole the leader election does *not* close — worth knowing before
  you debug a "membership got clobbered" report.
- **`PROVISION_FAILED` has no retry path in the UI** — recovery is a fresh request or a
  direct admin grant. If this becomes common, that's a signal a group's external target is
  misconfigured.
- **Frontend has some large pages** worth splitting when you next touch them (the groups /
  pending-approvals / group-detail / admin-management pages are the big ones). Not urgent,
  but the biggest quality-of-life win for anyone extending them.

---

## Roadmap (architecture-for-scale, none urgent)

These are flow-level improvements, summarized from the sandbox's `ROADMAP.md` — **check that
file directly for current status**, it's actively maintained and this will go stale.

| Item | Why it matters |
|---|---|
| **Event bus → durable queue (Redis/BullMQ) + idempotency keys** | Closes the silently-dropped-notification gap and would let side-effects retry. The natural time to do this is when adding a platform or hardening multi-replica behavior. |
| **OpenAPI spec generated from the existing validation schemas** | Removes the manual duplication of request/response types between backend and frontend. |
| **Distributed tracing across backend → DB → platform APIs** | Approve is already a multi-hop call graph (platform + Keycloak + Slack + email); tracing would make cross-hop latency/failures debuggable. |
| **Split the large frontend pages** | Pure maintainability. |

---

## Drift between the two repos (check before trusting any snapshot)

Because feature code is authored in the sandbox and vendored here, the two can drift. **The
current state of that drift is not something a doc can pin down** — it changes every time
either repo gets a commit. Before assuming either side is current:

```bash
# in each repo
git fetch && git log main..origin/main --oneline
```

and diff a specific shared file with line-ending/format noise ignored:

```bash
git diff --ignore-cr-at-eol
```

The workspace-root `CLAUDE.md` keeps a running "drift status" note, but treat any date in it
as a snapshot, not a guarantee — re-verify with `git log` on both sides.

> TODO(rishit): anything half-finished or intentionally deferred that isn't captured above —
> in-flight branches, a feature waiting on an external dependency, a known-flaky area, or a
> "we decided not to do X because Y" that would otherwise get re-litigated.
