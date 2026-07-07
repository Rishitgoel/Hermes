# Domain: Secret ingestion

**Key files:** `services/secret-ingestion.service.ts`,
`controllers/secret-ingestion.controller.ts`, `services/secrets.provisioner.ts` (the
underlying platform adapter — see [provisioning.md](provisioning.md#aws-secrets-manager)).
Data model: `SecretIngestionRequest`.

## Problem this solves

AWS Secrets Manager has no concept of Hermes-aware, per-user access control — a secret
is only protected by IAM role, and the Hermes service credential can read/write all of
them. Secret ingestion is Hermes' approval-gated bridge: a user proposes key/value pairs
to write into a specific secret, a group admin reviews each entry individually, and only
approved entries actually get merged into AWS.

This is structurally the same pattern as [ZooKeeper config changes](provisioning.md#zookeeper)
(draft → per-item review → synchronous apply on approval) — if you understand one, you
understand the other.

## Authorization: resolving what a user can touch

- `resolveUserScopePatterns()` — every `(group, pattern)` the user holds via active
  grants.
- `resolveUserSecretTargets()` — expands exact names as-is, and expands
  wildcard/prefix patterns by matching them **live** against AWS `ListSecrets` (not
  cached — see [provisioning.md](provisioning.md#aws-secrets-manager)).
- `resolveSecretForUser(name)` — for a secret name the user references, resolves the
  owning group and canonicalizes casing against the live AWS list (secret names are
  case-sensitive; submitting the wrong case would otherwise create a sibling secret
  instead of matching the intended one). If multiple groups' grants cover the same
  secret, an exact-name grant wins over a wildcard match, with group id as the
  tie-breaker for determinism.

## Flow

1. **Submit** (`POST /api/secrets/requests`): user picks a secret + key/value entries.
   Service checks the secret is in-scope via `resolveSecretForUser()`, canonicalizes the
   name, stores entries as `PENDING` (plaintext, since nothing has been approved yet).
2. **Review** (`PUT /api/secrets/requests/:id/review`, group/platform/super admin):
   claims the request (`PENDING`/`APPLY_FAILED` → `APPLYING`, race-safe), then per-entry
   APPROVED/REJECTED decisions. Approved entries are merged into the live secret via
   `putSecretKeyValues()` (creates the secret if it doesn't exist and the caller
   requested that). A failure on one entry doesn't abort the others — it's recorded and
   the request lands on `PARTIALLY_APPLIED` or `APPLY_FAILED` rather than crashing the
   whole review.
3. **Terminal states**: `APPLIED` / `REJECTED` / `PARTIALLY_APPLIED` (all terminal) or
   `APPLY_FAILED` (retryable — a later review call can retry).
4. **Value redaction**: entry values are wiped from Postgres **only** once the request
   reaches a genuinely terminal status. `APPLY_FAILED` deliberately keeps values around
   so a retry doesn't require the user to re-type everything.
5. **Stuck-request recovery**: a scheduled sweep (`sweepStuckApplying()`, every 10 min)
   catches requests stranded in `APPLYING` by a crash between "claimed" and "terminal
   status written."

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/secrets/scope` | User's authorized groups + resolved secret names |
| GET | `/api/secrets/keys?name=` | List key names for a secret (authz-checked, values masked) |
| POST | `/api/secrets/requests` | Submit entries |
| GET | `/api/secrets/requests?scope=mine\|review` | List personal or pending-review requests |
| PUT | `/api/secrets/requests/:id/review` | Per-entry approve/reject + apply |

## Gotchas

- Wildcard expansion is recomputed on every call — correct but means a large AWS account
  with many secrets pays a `ListSecrets` call on every scope check (see
  [provisioning.md](provisioning.md#aws-secrets-manager) for the caching that *does*
  exist, at the raw-service level, with a 30s TTL).
- This is the least mature of the four platform integrations — no multi-instance
  support, no background sync, and the approval workflow here is specific to secrets
  (not shared with the ZooKeeper change-request code, even though the shape is
  identical). If you're extending one, check whether the fix belongs in both.
