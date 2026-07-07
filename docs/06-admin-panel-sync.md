# Admin-panel vendoring (short pointer)

This documentation set describes the **standalone Hermes 2 codebase**. Hermes is also
vendored into `admin-panel/backend/src/hermes` and `admin-panel/frontend/src/hermes` as
the production deployment target. Full detail on the sync strategy, the adaptation
layer, and current drift status lives one level up, at `D:\Bachatt\CLAUDE.md` — read that
before porting anything. The short version:

- **Feature code** (controllers, services, validations, routes, pages, components, lib)
  is authored here and ported over, with two mechanical rewrites: the Prisma import
  (`@prisma/client` → `../../../generated/hermes`) and nothing else — it should stay
  logically identical.
- **Integration-only code** exists *only* in admin-panel and is never ported back:
  `hermesRouter.ts` and `init.ts` (mount points — admin-panel runs Hermes as a sub-app,
  not a standalone `app.listen()` process), and
  `leader-election.service.ts` — a Redis lock around the scheduler and initial sync,
  needed because admin-panel runs **multiple replicas** in production and this repo's
  scheduler (see [01-architecture.md](01-architecture.md#scheduler-background-jobs)) has
  no such coordination built in.
- **Never commit** one-shot CLI scripts or test files when porting into admin-panel —
  they're intentionally excluded from that repo's history (no test runner is wired into
  its CI, and scripts are meant to be run manually).
- Keep admin-panel PRs scoped to what the feature landing in that PR actually needs —
  don't resync everything just because it drifted.
