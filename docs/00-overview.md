# Hermes — Overview

## What Hermes is

Hermes is an internal access-management portal. It replaces ad-hoc, Slack-message-based
access requests with a self-service workflow: a user requests access to a "group" (a
logical bundle of permissions on some external platform), an admin reviews it, and on
approval Hermes provisions the actual access on that platform automatically. Access can
be time-boxed (auto-expires) or permanent, and every state change is audit-logged.

Platforms currently integrated:

- **Redash** (prod + QA instances) — BI/dashboard tool. Groups map to Redash groups.
- **AWS IAM Identity Center** — SSO account + group membership provisioning.
- **ZooKeeper** — write access to a znode tree, enforced at the application layer
  (the ensemble itself is world-open and network-isolated — see
  [03-domains/provisioning.md](03-domains/provisioning.md)).
- **AWS Secrets Manager** — approval-gated ingestion of key/value pairs into secrets.

New platforms plug into a shared adapter interface (`PlatformAdapter`) and a registry —
see [03-domains/provisioning.md](03-domains/provisioning.md) for how to add one.

## Who uses it

- **Regular users** — request access to groups, request a platform account, request
  ZooKeeper config changes or secret ingestion, see their own request history and active
  grants.
- **Group admins** — approve/reject access requests and manage membership for the
  group(s) they administer.
- **Platform admins** — everything a group admin can do, across every group on a given
  platform (e.g. all Redash groups), plus group CRUD and account-creation approval for
  that platform.
- **Super admins** — everything, across every platform, plus audit log access, manual
  platform sync/reconciliation, and Redash/ZooKeeper maintenance tooling.

See [02-auth-rbac.md](02-auth-rbac.md) for exactly how this three-tier model is
represented and enforced.

## Repo relationship (read this before touching admin-panel)

Hermes lives in **two places**:

| Location | Role |
|---|---|
| `Hermes 2/` (this repo, `github.com/bachatt-app/hermes`) | **Source of truth for feature code.** Standalone sandbox — single process, single DB, no multi-replica concerns. Build and test features here first. |
| `admin-panel/backend/src/hermes` + `admin-panel/frontend/src/hermes` (`github.com/bachatt-app/admin-panel`) | **Production target.** Hermes is vendored in — copied and mechanically adapted (Prisma import paths, leader-election for multi-replica scheduler/sync, its own mount/bootstrap files). Not hand-authored there. |

The full adaptation layer, sync strategy, and current drift status between the two repos
is documented one level up, in `D:\Bachatt\CLAUDE.md` (workspace root) — read it before
porting any change. In short: build and test in `Hermes 2/`, then port only what a given
admin-panel PR actually needs, keeping the two Prisma-import lines and the
integration-only files (`hermesRouter.ts`, `init.ts`, `leader-election.service.ts`) as the
main points of divergence.

This documentation set (`Hermes 2/docs/`) describes the **standalone Hermes 2 codebase**.
See [06-admin-panel-sync.md](06-admin-panel-sync.md) for a short pointer on what changes
when it's vendored into admin-panel.

## Where to go next

- [01-architecture.md](01-architecture.md) — request lifecycle, event bus, scheduler, high-level data flow.
- [02-auth-rbac.md](02-auth-rbac.md) — the three-tier admin model in detail.
- [03-domains/](03-domains) — one file per functional area (access workflow, provisioning, secrets, user creation, admin management, notifications, audit).
- [04-data-model.md](04-data-model.md) — full Prisma schema reference.
- [05-frontend.md](05-frontend.md) — routes, components, API layer.
- [07-setup.md](07-setup.md) — local dev setup.
- [08-testing.md](08-testing.md) — what's tested, how to run it.
- [09-runbook.md](09-runbook.md) — operational troubleshooting.
- [10-glossary-roadmap.md](10-glossary-roadmap.md) — terminology + open work.
