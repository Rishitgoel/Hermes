import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import provisioningRegistry from '../services/provisioning.registry';
import keycloakAdminService from '../services/keycloak-admin.service';
import accessWorkflowService from '../services/access-workflow.service';
import {
  isSuperAdmin,
  isPlatformAdminOf,
  isGroupAdminOf,
  isAnyAdmin,
  getManageablePlatforms,
} from '../utils/authz';
import { AuthorizationError, NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import { assignPlatformAdminSchema, assignGroupAdminSchema } from '../validations/admin.validation';
import { UserCreationStatus } from '@prisma/client';
import logger from '../utils/logger';

const PLATFORM_ADMIN_MARKER = 'hermes_platform_admin';
const GROUP_ADMIN_MARKER = 'hermes_group_admin';

const platformAdminRole = (platform: string) => `hermes_platform_admin_${platform.toLowerCase()}`;
// Platform-qualified so the role is self-documenting and consistent with the
// platform-admin role (e.g. hermes_group_admin_redash_growth). Slug keeps its
// hyphens; platform keys are single tokens, so <platform>_<slug> parses cleanly.
const groupAdminRole = (platform: string, slug: string) =>
  `hermes_group_admin_${platform.toLowerCase()}_${slug.toLowerCase()}`;

/**
 * Admin Management surface (the three-tier model: super → platform → group).
 *
 * Keycloak is the source of truth for who-holds-what role; these handlers push
 * assignments there via keycloakAdminService (no-op in simulation) and keep the
 * GroupAdmin / PlatformAdmin DB tables as a mirror for listings, notifications
 * and authorization. Every handler authorizes through the authz helpers rather
 * than route-level requireRole, because the tiers don't map cleanly to a single
 * blanket role (a platform admin manages a group without the group-admin role).
 */
export class AdminManagementController extends BaseController {
  /** Look up a user's display name/email from the "users Hermes has seen" set. */
  private async resolveUserProfile(userId: string): Promise<{ userName: string; userEmail: string }> {
    const row = await prisma.userCreationRequest.findUnique({
      where: { userId },
      select: { userName: true, userEmail: true },
    });
    if (!row) {
      throw new NotFoundError(
        'User not found in Hermes. They must sign in to Hermes at least once before they can be assigned an admin role.',
      );
    }
    return { userName: row.userName, userEmail: row.userEmail };
  }

  // GET /api/admin/platforms — platform keys the caller may administer.
  async listManageablePlatforms(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const platforms = await getManageablePlatforms(this.user!);
      // Gate like the sibling lookups (/users, /groups, /group-admins): a non-admin
      // with no manageable platforms gets 403, not a 200 with an empty array.
      if (platforms.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }
      this.sendResponse(platforms, 'Manageable platforms retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve manageable platforms');
    }
  }

  // GET /api/admin/users?search= — candidate users to promote (seen by Hermes).
  async searchUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;

      // Only admins who can assign roles (super or platform admin) may search.
      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You are not authorized to search users');
      }

      const search = String(req.query.search ?? '').trim();
      const rows = await prisma.userCreationRequest.findMany({
        where: search
          ? {
              OR: [
                { userName: { contains: search, mode: 'insensitive' } },
                { userEmail: { contains: search, mode: 'insensitive' } },
              ],
            }
          : undefined,
        select: { userId: true, userName: true, userEmail: true, status: true },
        orderBy: { userName: 'asc' },
        take: 20,
      });

      this.sendResponse(rows, 'Users retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to search users');
    }
  }

  // ── Platform admins (super admin only) ───────────────────────────────────

  // GET /api/admin/platform-admins?platform=
  async listPlatformAdmins(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can view platform admins');
      }

      const platform = req.query.platform ? String(req.query.platform).toLowerCase() : undefined;
      const rows = await prisma.platformAdmin.findMany({
        where: platform ? { platform } : undefined,
        orderBy: [{ platform: 'asc' }, { userName: 'asc' }],
      });

      this.sendResponse(rows, 'Platform admins retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve platform admins');
    }
  }

  // POST /api/admin/platform-admins  { userId, platform }
  async assignPlatformAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can assign platform admins');
      }

      const validated = this.validateWithZod(assignPlatformAdminSchema, this.req.body);
      if (!validated.success) return;

      const userId = validated.data.userId;
      const platform = validated.data.platform.toLowerCase();

      if (!provisioningRegistry.has(platform)) {
        throw new ValidationError(`Unknown platform "${platform}" — no provisioner is registered for it.`);
      }

      const profile = await this.resolveUserProfile(userId);
      const role = platformAdminRole(platform);

      // Keycloak (source of truth): ensure the composite role exists, then assign.
      await keycloakAdminService.ensureCompositeRole(role, PLATFORM_ADMIN_MARKER, `Hermes platform admin for ${platform}`);
      await keycloakAdminService.assignRealmRole(userId, role);

      const row = await prisma.platformAdmin.upsert({
        where: { userId_platform: { userId, platform } },
        update: { userName: profile.userName, userEmail: profile.userEmail, assignedBy: this.user!.username },
        create: {
          userId,
          platform,
          userName: profile.userName,
          userEmail: profile.userEmail,
          assignedBy: this.user!.username,
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'PLATFORM_ADMIN_ASSIGNED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          targetUserId: userId,
          targetUserName: profile.userName,
          details: { platform, role },
        },
      });

      this.sendResponse(row, 'Platform admin assigned successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to assign platform admin');
    }
  }

  // DELETE /api/admin/platform-admins/:id
  async removePlatformAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can remove platform admins');
      }

      const id = String(req.params.id);
      const row = await prisma.platformAdmin.findUnique({ where: { id } });
      if (!row) throw new NotFoundError('Platform admin assignment not found');

      await keycloakAdminService.removeRealmRole(row.userId, platformAdminRole(row.platform));
      await prisma.platformAdmin.delete({ where: { id } });

      // Deleting the mirror row revokes authorization immediately (authz is
      // mirror-authoritative). logoutUser is defense-in-depth: it ends the user's
      // Keycloak sessions so the dropped role also leaves their *future* tokens — it
      // does NOT invalidate an already-issued access token. Best-effort — never blocks removal.
      await keycloakAdminService.logoutUser(row.userId);

      await prisma.auditEntry.create({
        data: {
          action: 'PLATFORM_ADMIN_REVOKED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          targetUserId: row.userId,
          targetUserName: row.userName,
          details: { platform: row.platform, role: platformAdminRole(row.platform) },
        },
      });

      this.sendResponse({ id }, 'Platform admin removed successfully');
    } catch (error) {
      this.handleError(error, 'Failed to remove platform admin');
    }
  }

  // ── Manageable groups (for the UI tree) ──────────────────────────────────

  // GET /api/admin/groups?platform=
  async listManageableGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const where: { platform?: string | { in: string[] } } = {};
      if (!isSuperAdmin(this.user!)) {
        where.platform = { in: manageable };
      }
      if (req.query.platform) {
        const p = String(req.query.platform).toLowerCase();
        if (!isSuperAdmin(this.user!) && !manageable.includes(p)) {
          throw new AuthorizationError('You do not administer this platform');
        }
        where.platform = p;
      }

      const groups = await prisma.group.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          admins: { select: { userId: true } },
          userAccesses: { where: { isActive: true }, select: { userId: true } },
        },
      });

      this.sendResponse(
        groups.map((g) => {
          // Single-status model: an admin holds an auto-enrolled access grant, but
          // is counted as an admin, not a member. Exclude admins from memberCount so
          // the same person is never tallied in both columns.
          const adminIds = new Set(g.admins.map((a) => a.userId));
          const memberCount = g.userAccesses.filter((u) => !adminIds.has(u.userId)).length;
          return {
            id: g.id,
            name: g.name,
            slug: g.slug,
            platform: g.platform,
            color: g.color,
            icon: g.icon,
            memberCount,
            adminCount: g.admins.length,
          };
        }),
        'Manageable groups retrieved successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve manageable groups');
    }
  }

  // ── Group admins (super, or platform admin of that group's platform) ──────

  // GET /api/admin/group-admins?platform=&groupId=
  async listGroupAdmins(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const groupWhere: { platform?: string | { in: string[] }; id?: string } = {};
      if (!isSuperAdmin(this.user!)) {
        groupWhere.platform = { in: manageable };
      }
      if (req.query.platform) {
        const p = String(req.query.platform).toLowerCase();
        if (!isSuperAdmin(this.user!) && !manageable.includes(p)) {
          throw new AuthorizationError('You do not administer this platform');
        }
        groupWhere.platform = p;
      }
      if (req.query.groupId) {
        groupWhere.id = String(req.query.groupId);
      }

      const groups = await prisma.group.findMany({ where: groupWhere, select: { id: true } });
      const groupIds = groups.map((g) => g.id);

      const rows = await prisma.groupAdmin.findMany({
        where: { groupId: { in: groupIds } },
        include: { group: { select: { name: true, slug: true, platform: true, color: true } } },
        orderBy: { userName: 'asc' },
      });

      this.sendResponse(rows, 'Group admins retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group admins');
    }
  }

  // POST /api/admin/group-admins  { userId, groupId }
  async assignGroupAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;

      // Coarse precheck before the group lookup so a non-admin can't probe group
      // existence via the 404-vs-403 difference. The fine-grained check is below.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError("You cannot manage this group's admins");
      }

      const validated = this.validateWithZod(assignGroupAdminSchema, this.req.body);
      if (!validated.success) return;

      const { userId, groupId } = validated.data;
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) throw new NotFoundError('Group not found');

      // Super admin or platform admin of this group's platform. (Assigning a user
      // who also holds super_admin is allowed and harmless — no extra guard.)
      if (!(await isPlatformAdminOf(this.user!, group.platform))) {
        throw new AuthorizationError("You cannot manage admins for this group's platform");
      }

      // Reject groups whose platform has no registered provisioner (mirrors the
      // check in assignPlatformAdmin) — otherwise we'd mint an admin we can't
      // provision for, and the auto-enroll below would silently fail.
      if (!provisioningRegistry.has(group.platform)) {
        throw new ValidationError(`Unknown platform "${group.platform}" — no provisioner is registered for it.`);
      }

      const profile = await this.resolveUserProfile(userId);
      const role = groupAdminRole(group.platform, group.slug);

      await keycloakAdminService.ensureCompositeRole(role, GROUP_ADMIN_MARKER, `Hermes group admin for ${group.platform}/${group.slug}`);
      await keycloakAdminService.assignRealmRole(userId, role);

      const row = await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId, userId } },
        update: { userName: profile.userName, userEmail: profile.userEmail, assignedBy: this.user!.username },
        create: {
          groupId,
          userId,
          userName: profile.userName,
          userEmail: profile.userEmail,
          assignedBy: this.user!.username,
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_ADMIN_ASSIGNED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          targetUserId: userId,
          targetUserName: profile.userName,
          groupId,
          details: { slug: group.slug, platform: group.platform, role },
        },
      });

      // Synergy: if their platform account is finalized, make them a real member
      // now (same enrollment used on /auth/me). Fire-and-forget — don't block the
      // assignment response on provisioning. NOTE: this is an intentional standing
      // grant — group admins get PERMANENT membership without an AccessRequest
      // (recorded only as the ACCESS_GRANTED audit row below), bypassing the normal
      // request → approval → duration flow.
      const userCreation = await prisma.userCreationRequest.findUnique({ where: { userId } });
      if (userCreation?.status === UserCreationStatus.COMPLETED) {
        accessWorkflowService
          .ensureGroupAdminEnrollment({ id: userId, username: profile.userName, email: profile.userEmail }, [group.slug])
          .catch((err: any) =>
            logger.error({ err: err.message, userId, groupId }, 'Auto-enroll after group-admin assignment failed'),
          );
      }

      this.sendResponse(row, 'Group admin assigned successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to assign group admin');
    }
  }

  // DELETE /api/admin/group-admins/:id
  async removeGroupAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;

      // Coarse precheck before the row lookup (avoids a 404-vs-403 existence oracle).
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You cannot manage group admins');
      }

      const id = String(req.params.id);
      const row = await prisma.groupAdmin.findUnique({ where: { id }, include: { group: true } });
      if (!row) throw new NotFoundError('Group admin assignment not found');

      if (!(await isPlatformAdminOf(this.user!, row.group.platform))) {
        throw new AuthorizationError("You cannot manage admins for this group's platform");
      }

      await keycloakAdminService.removeRealmRole(row.userId, groupAdminRole(row.group.platform, row.group.slug));
      await prisma.groupAdmin.delete({ where: { id } });

      // Mirror deletion revokes authorization immediately (authz is
      // mirror-authoritative); logoutUser is defense-in-depth (see
      // removePlatformAdmin). Best-effort.
      await keycloakAdminService.logoutUser(row.userId);

      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_ADMIN_REVOKED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          targetUserId: row.userId,
          targetUserName: row.userName,
          groupId: row.groupId,
          details: { slug: row.group.slug, platform: row.group.platform, role: groupAdminRole(row.group.platform, row.group.slug) },
        },
      });

      // Membership is intentionally retained — removing admin rights does not
      // revoke their group access (revoke manually if needed).
      this.sendResponse({ id }, 'Group admin removed (group membership retained)');
    } catch (error) {
      this.handleError(error, 'Failed to remove group admin');
    }
  }

  // ── Members ──────────────────────────────────────────────────────────────

  // GET /api/admin/groups/:groupId/members
  async listGroupMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence
      // oracle); same message as the fine-grained check so they're indistinguishable.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const groupId = String(req.params.groupId);
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) throw new NotFoundError('Group not found');

      if (!(await isGroupAdminOf(this.user!, groupId, group.slug))) {
        throw new AuthorizationError('You do not administer this group');
      }

      // Single-status model: a group admin always holds an (auto-enrolled) active
      // grant for data access, but is surfaced only under "Group Admins" — never
      // also as a plain member. Exclude current admins from the members list so the
      // same person never appears in both sections.
      const [members, admins] = await Promise.all([
        prisma.userAccess.findMany({
          where: { groupId, isActive: true },
          orderBy: { grantedAt: 'desc' },
        }),
        prisma.groupAdmin.findMany({ where: { groupId }, select: { userId: true } }),
      ]);
      const adminUserIds = new Set(admins.map((a) => a.userId));
      const nonAdminMembers = members.filter((m) => !adminUserIds.has(m.userId));

      this.sendResponse(nonAdminMembers, 'Group members retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group members');
    }
  }

  // DELETE /api/admin/groups/:groupId/members/:userAccessId
  async removeGroupMember(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence
      // oracle); same message as the fine-grained check so they're indistinguishable.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const groupId = String(req.params.groupId);
      const userAccessId = String(req.params.userAccessId);

      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) throw new NotFoundError('Group not found');

      if (!(await isGroupAdminOf(this.user!, groupId, group.slug))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const access = await prisma.userAccess.findUnique({ where: { id: userAccessId } });
      if (!access || access.groupId !== groupId) {
        throw new NotFoundError('Member not found in this group');
      }

      // Single-status model: a current admin isn't a removable "member" — their
      // access is held automatically by the admin role. Removing it directly would
      // also be undone by the group-admin auto-enrollment on the next session load.
      // Require demoting them first (which leaves them a plain member).
      const adminRow = await prisma.groupAdmin.findUnique({
        where: { groupId_userId: { groupId, userId: access.userId } },
      });
      if (adminRow) {
        throw new ConflictError(
          'This user is a group admin — remove their admin role first. They will become a regular member, and can then be removed.',
        );
      }

      await accessWorkflowService.revokeAccess(
        userAccessId,
        { id: userId, username: this.user!.username },
        'Removed by admin via Admin Management',
      );

      this.sendResponse({ id: userAccessId }, 'Member removed from group');
    } catch (error) {
      this.handleError(error, 'Failed to remove group member');
    }
  }
}

export default AdminManagementController;
