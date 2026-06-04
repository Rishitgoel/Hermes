import { Router, Request, Response, NextFunction } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { AdminManagementController } from '../controllers/admin-management.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.post('/sync', authenticateToken, requireRole(['hermes_super_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new AdminController(req, res, next);
  controller.triggerSync(req, res, next).catch(next);
});

router.post('/reconcile', authenticateToken, requireRole(['hermes_super_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new AdminController(req, res, next);
  controller.triggerReconcile(req, res, next).catch(next);
});

// ── Admin Management (three-tier: super → platform → group) ─────────────────
// All routes are authenticated; fine-grained tier checks live in the controller
// (the tiers don't map cleanly onto a single blanket role, so requireRole can't
// express them — e.g. a platform admin manages a group without the group-admin
// role).
const adminMgmt = (method: keyof AdminManagementController) =>
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new AdminManagementController(req, res, next);
    (controller[method] as (req: Request, res: Response, next: NextFunction) => Promise<void>)(req, res, next).catch(next);
  };

// Lookups
router.get('/platforms', authenticateToken, adminMgmt('listManageablePlatforms'));
router.get('/users', authenticateToken, adminMgmt('searchUsers'));
router.get('/groups', authenticateToken, adminMgmt('listManageableGroups'));

// Platform admins (super admin only — enforced in controller)
router.get('/platform-admins', authenticateToken, adminMgmt('listPlatformAdmins'));
router.post('/platform-admins', authenticateToken, adminMgmt('assignPlatformAdmin'));
router.delete('/platform-admins/:id', authenticateToken, adminMgmt('removePlatformAdmin'));

// Group admins (super or platform admin of the group's platform)
router.get('/group-admins', authenticateToken, adminMgmt('listGroupAdmins'));
router.post('/group-admins', authenticateToken, adminMgmt('assignGroupAdmin'));
router.delete('/group-admins/:id', authenticateToken, adminMgmt('removeGroupAdmin'));

// Members
router.get('/groups/:groupId/members', authenticateToken, adminMgmt('listGroupMembers'));
router.delete('/groups/:groupId/members/:userAccessId', authenticateToken, adminMgmt('removeGroupMember'));

// Group levels / subgroups (super or platform admin of the group's platform — enforced in controller)
router.get('/groups/:groupId/levels', authenticateToken, adminMgmt('listGroupLevels'));
router.post('/groups/:groupId/levels', authenticateToken, adminMgmt('createGroupLevel'));
router.put('/groups/:groupId/levels/:levelId', authenticateToken, adminMgmt('updateGroupLevel'));
router.delete('/groups/:groupId/levels/:levelId', authenticateToken, adminMgmt('deleteGroupLevel'));

export default router;
