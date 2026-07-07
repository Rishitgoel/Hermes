# Testing

Both backend and frontend use **Vitest** (`npm test` for watch, `npm run test:run` for a
single pass). Backend tests use `@testcontainers/postgresql` for a real, disposable
Postgres rather than mocking Prisma.

## Backend test inventory

| File | Covers |
|---|---|
| `utils/authz.test.ts` | Three-tier authorization checks, scoping, per-request cache |
| `services/sync.service.test.ts` | `reconcileHermesGroups` — archival, grace windows, reserved groups |
| `test/aws-toggle.test.ts` | `AWS_ENABLED` toggle — adapter registration/deregistration |
| `services/zookeeper.service.test.ts` | Live-client NO_AUTH handling, retries, timeouts |
| `services/zookeeper.provisioner.test.ts` | ZK adapter in simulation (invite, ACL digest, membership, caching) |
| `services/zookeeper-config.test.ts` | Change-request submit/approve/apply/notify |
| `services/redash.provisioner.test.ts` | User sync, recreated-user email-collision fix, upsert |
| `services/redash.service.test.ts` | Redash API client — sync, invite, error handling |
| `services/redash-resync.service.test.ts` | Full resync — reimport, conflict handling |
| `test/redash-multi-instance.test.ts` | Prod/QA as distinct platform keys, display-name conventions |
| `services/access-workflow.test.ts` | Full request lifecycle (create/approve/reject/provision/deprovision, partial failures) |
| `services/secret-ingestion.service.test.ts` | Ingestion request/review/approval in simulation |
| `services/secrets.provisioner.test.ts` | Secrets adapter — invite, key ingestion, simulation |
| `services/concurrency-fixes.test.ts` | Phase-3 atomicity — concurrent default-membership grants, `P2002` swallowing, idempotency |

## Frontend test inventory

| File | Covers |
|---|---|
| `contexts/AuthContext.test.tsx` | Keycloak login, token refresh, simulation role switching |
| `test/pages.test.tsx` | Smoke tests — pages mount without crashing |

## Coverage shape

Comprehensive at the **service/adapter layer** (workflow, provisioning, sync,
concurrency) — this is where the real invariants live (one-active-grant enforcement,
idempotent platform calls, level-swap atomicity), so it's appropriately the most tested
layer. Moderate on controllers/routes (exercised indirectly via service test fixtures).
Sparse on UI components — smoke tests only, no interaction testing. If you're changing
provisioning or access-workflow logic, run the relevant test file before and after; if
you're changing a frontend component, there's no test safety net — verify manually in the
browser (see [05-frontend.md](05-frontend.md#verifying-changes-locally)).

## CI

GitHub Actions runs typecheck, lint, and tests on push (see `ROADMAP.md` P2-4).
