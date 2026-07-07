# Local setup

## Prerequisites

```bash
cd backend && npm install
cd frontend && npm install
```

`docker-compose.yml` at the repo root provides every backing service. Minimal stack:

```bash
docker compose up -d postgres keycloak
```

Add Redash if you need to test that integration for real (rather than in simulation):

```bash
docker compose up -d redis redash-postgres
docker compose run --rm redash create_db
docker compose up -d redash redash-worker redash-scheduler
```

A second, fully independent Redash stack (`redash-qa*` services, distinct ports) exists
for testing multi-instance behavior. A `zookeeper` + `zoonavigator` (web GUI, `:9001`)
pair exists for testing ZooKeeper live instead of simulated.

| Service | Port | Purpose |
|---|---|---|
| `postgres` | 15433 | Hermes' own DB (`hermes_user`/`hermes_pass`/`hermes`) |
| `keycloak` | 8080 | Local dev-mode Keycloak (H2 in-memory, `admin`/`admin_password`) |
| `zookeeper` | 2181 | Local ZK ensemble (only needed if not simulating) |
| `zoonavigator` | 9001 | ZK web GUI |
| `redash` / `redash-qa` | 5500 / 5501 | Redash (prod / QA), each with its own Postgres, worker, scheduler |
| `redis` / `redis-qa` | 16379 / 16380 | Backing Redash (unused directly by Hermes code) |

## Running

```bash
cd backend && npm run dev    # nodemon + ts-node, PORT env, default 8001
cd frontend && npm run dev   # Vite, default 5173
```

Before first run: `npm run prisma:generate` (needs `--schema=prisma/hermes/schema.prisma`
— already wired into the script), `npm run prisma:migrate`, optionally `npm run
prisma:seed`.

## Simulation mode — the fast path for most local work

Every external integration (Keycloak, Redash ×N, AWS Identity Center, ZooKeeper, Secrets
Manager, Slack, Email) has an independent simulation flag, all **on by default**. This
means you can run the full request/approval/provisioning lifecycle locally with **just
Postgres** — no Keycloak, no Redash, no AWS, no ZK required — using mock auth tokens
(`super_admin | platform_admin | group_admin | user`) and in-memory adapter mocks. This
is almost always the right starting point; only flip a specific `*_SIMULATION` flag off
when you specifically need to verify that integration against the real thing.

## Key environment variables (see `.env.example` for the full list)

| Group | Vars |
|---|---|
| App | `NODE_ENV`, `PORT` |
| DB | `DATABASE_URL_HERMES` |
| Keycloak | `KEYCLOAK_SIMULATION`, `KEYCLOAK_JWKS_URI`, `KEYCLOAK_ISSUER`, `KEYCLOAK_AUDIENCE` (**required in prod**), `KEYCLOAK_ADMIN_*` |
| Platform routing | `DEFAULT_PLATFORM` |
| Redash | `REDASH_BASE_URL`, `REDASH_API_KEY`, `REDASH_SIMULATION`, `REDASH_QA_*` (optional second instance) |
| Slack | `SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN`, `SLACK_SIMULATION` |
| Email | `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SES_REGION`, `EMAIL_SIMULATION`, `SIM_ADMIN_EMAIL` |
| AWS (shared) | `AWS_REGION`, `AWS_ACCESS_KEY_ID`/`SECRET`, `AWS_ENABLED`, `HERMES_AWS_SECRET_NAME` |
| AWS Identity Center | `AWS_SIMULATION`, `AWS_IDENTITY_STORE_ID`, `AWS_IDENTITY_CENTER_REGION`, `AWS_ACCESS_PORTAL_URL` |
| Secrets ingestion | `SECRETS_INGESTION_SIMULATION`, `SECRETS_INGESTION_REGION` |
| ZooKeeper | `ZOOKEEPER_SIMULATION`, `ZOOKEEPER_CONNECT_STRING`, `ZOOKEEPER_ROOT_PATH`, `ZOOKEEPER_ADMIN_AUTH` |
| Frontend/CORS | `FRONTEND_URL`, `ALLOWED_ORIGINS` |
| Security | `ENABLE_RATE_LIMIT`, `SECURITY_HELMET`, `TRUST_PROXY` |

`AWS_SECRET_NAME` is deliberately overridable via `HERMES_AWS_SECRET_NAME` — this exists
because admin-panel shares an environment with 7 other backend DB clients and would
otherwise clobber the shared `AWS_SECRET_NAME` var.

## Secrets loading in production

`config/secrets.ts` fetches a JSON blob from AWS Secrets Manager (name =
`config.aws.secretName`) at boot and injects every key into `process.env` **before** any
service module is imported. This is a fail-closed path: outside dev/simulation, a failure
to load secrets crashes the process rather than falling back to whatever's in `.env`.

## NPM scripts reference

**Backend**: `dev`, `build` (tsc), `start` (run compiled `dist/`), `prisma:generate`,
`prisma:migrate`, `prisma:seed`, `lint`, `format`, `format:check`, `test` (vitest watch),
`test:run` (single run), `aws:enable`/`aws:disable`/`aws:status` (toggle the AWS adapter).

**Frontend**: `dev`, `build` (tsc + vite build), `lint`, `preview`, `test`, `test:run`.
