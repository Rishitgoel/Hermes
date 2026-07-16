import { Router, Request, Response, NextFunction } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { AdminManagementController } from '../controllers/admin-management.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.post(
  '/sync',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminController(req, res, next);
    controller.triggerSync(req, res, next).catch(next);
  },
);

router.post(
  '/reconcile',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminController(req, res, next);
    controller.triggerReconcile(req, res, next).catch(next);
  },
);

// Redash maintenance: backfill existing Redash accounts + memberships into Hermes
// (super admin only). Rarely used; surfaced in a collapsed disclosure in the UI.
router.post(
  '/import-redash-memberships',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminController(req, res, next);
    controller.importRedashMemberships(req, res, next).catch(next);
  },
);

// Redash full resync: two-way reconciliation (add + remove + fix-stuck-requests)
// against live Redash state (super admin only). Manually triggered, not a cron job.
router.post(
  '/resync-redash-memberships',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminController(req, res, next);
    controller.resyncRedashMemberships(req, res, next).catch(next);
  },
);

// ZooKeeper maintenance: migrate existing ZooKeeper ACLs to world-open (super admin only).
router.post(
  '/migrate-zookeeper-acls',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminController(req, res, next);
    controller.migrateZookeeperAcls(req, res, next).catch(next);
  },
);

// ── Admin Management (three-tier: super → platform → group) ─────────────────
// All routes are authenticated; fine-grained tier checks live in the controller
// (the tiers don't map cleanly onto a single blanket role, so requireRole can't
// express them — e.g. a platform admin manages a group without the group-admin
// role).
const adminMgmt =
  (method: keyof AdminManagementController) =>
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminManagementController(req, res, next);
    (
      controller[method] as (
        req: Request,
        res: Response,
        next: NextFunction,
      ) => Promise<void>
    )(req, res, next).catch(next);
  };

// Lookups
router.get(
  '/platforms',
  authenticateToken,
  adminMgmt('listManageablePlatforms'),
);
router.get('/aws-secrets', authenticateToken, adminMgmt('listAwsSecrets'));
router.get('/users', authenticateToken, adminMgmt('searchUsers'));
router.get('/groups', authenticateToken, adminMgmt('listManageableGroups'));

// User access (cross-platform view + bulk revoke) — super or platform admin
// (enforced in controller via getManageablePlatforms scoping).
router.get('/user-access', authenticateToken, adminMgmt('listUserAccess'));
router.post('/user-access/revoke', authenticateToken, adminMgmt('revokeUserAccess'));

// Platform accounts (offboarding: disable/delete the account itself, not just
// group membership) — same tool, same scoping.
router.get('/user-platform-accounts', authenticateToken, adminMgmt('listUserPlatformAccounts'));
router.post('/user-access/disable-accounts', authenticateToken, adminMgmt('disableUserAccounts'));

// Platform admins (super admin only — enforced in controller)
router.get(
  '/platform-admins',
  authenticateToken,
  adminMgmt('listPlatformAdmins'),
);
router.post(
  '/platform-admins',
  authenticateToken,
  adminMgmt('assignPlatformAdmin'),
);
router.delete(
  '/platform-admins/:id',
  authenticateToken,
  adminMgmt('removePlatformAdmin'),
);

// Group admins (super or platform admin of the group's platform)
router.get('/group-admins', authenticateToken, adminMgmt('listGroupAdmins'));
router.post('/group-admins', authenticateToken, adminMgmt('assignGroupAdmin'));
router.delete(
  '/group-admins/:id',
  authenticateToken,
  adminMgmt('removeGroupAdmin'),
);

// Group CRUD (super or platform admin of the group's platform — enforced in controller)
router.post('/groups', authenticateToken, adminMgmt('createGroup'));
router.put('/groups/:groupId', authenticateToken, adminMgmt('updateGroup'));
router.delete('/groups/:groupId', authenticateToken, adminMgmt('deleteGroup'));

// Maintenance: idempotently create the "All Secrets" group (super-admin only, enforced in
// controller). The no-terminal path for standing up the wildcard-all secrets group in prod.
router.post('/maintenance/ensure-secrets-group', authenticateToken, adminMgmt('ensureAllSecretsGroup'));

// Members
router.get(
  '/groups/:groupId/members',
  authenticateToken,
  adminMgmt('listGroupMembers'),
);
router.post(
  '/groups/:groupId/members',
  authenticateToken,
  adminMgmt('addGroupMember'),
);
// Recovery path for addGroupMember's USER_NOT_APPROVED error — creates the
// platform account on the user's behalf, then adds them to the group. Not a
// standalone entry point; the frontend only calls this after addGroupMember fails.
router.post(
  '/groups/:groupId/onboard',
  authenticateToken,
  adminMgmt('onboardUserToGroup'),
);
router.put(
  '/groups/:groupId/members/:userAccessId/level',
  authenticateToken,
  adminMgmt('setGroupMemberLevel'),
);
router.delete(
  '/groups/:groupId/members/:userAccessId',
  authenticateToken,
  adminMgmt('removeGroupMember'),
);

// Group levels / subgroups (super or platform admin of the group's platform — enforced in controller)
router.get(
  '/groups/:groupId/levels',
  authenticateToken,
  adminMgmt('listGroupLevels'),
);
router.post(
  '/groups/:groupId/levels',
  authenticateToken,
  adminMgmt('createGroupLevel'),
);
router.put(
  '/groups/:groupId/levels/:levelId',
  authenticateToken,
  adminMgmt('updateGroupLevel'),
);
router.delete(
  '/groups/:groupId/levels/:levelId',
  authenticateToken,
  adminMgmt('deleteGroupLevel'),
);

export default router;
