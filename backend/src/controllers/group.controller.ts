import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import { RequestStatus } from '@prisma/client';
import { checkIsGroupAdmin } from '../middleware/auth.middleware';
import { groupSlugSchema } from '../validations/group.validation';
import { getManageablePlatforms } from '../utils/authz';

export class GroupController extends BaseController {
  // GET /api/groups
  async getGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const [groups, activeAccesses, openRequests] = await Promise.all([
        prisma.group.findMany({
          where: { isActive: true },
          include: {
            admins: true,
            _count: {
              select: {
                userAccesses: { where: { isActive: true } },
              },
            },
          },
          orderBy: { name: 'asc' },
        }),
        prisma.userAccess.findMany({
          where: { userId, isActive: true },
        }),
        // PENDING = awaiting admin review; WAITING_FOR_SETUP = approved but parked
        // until the requester finishes their platform-account setup. Both mean the
        // user has an open request for the group — neither should read as NO ACCESS.
        prisma.accessRequest.findMany({
          where: {
            requesterId: userId,
            status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
          },
        })
      ]);

      const isSuperAdmin = this.user?.roles.includes('hermes_super_admin') || false;
      // Platforms this user administers (lower-cased). Super admins implicitly
      // manage every registered platform; platform admins their own; everyone else
      // gets []. A platform admin reads as ACTIVE on every group of their platform —
      // the same cosmetic short-circuit super admins already get. (Real Redash
      // membership for platform admins is provisioned lazily in /auth/me.)
      const managedPlatforms = this.user ? await getManageablePlatforms(this.user) : [];

      const enrichedGroups = groups.map(g => {
        let accessStatus = 'NONE';
        
        const hasActive = activeAccesses.some(a => a.groupId === g.id);
        const hasWaitingForSetup = openRequests.some(
          r => r.groupId === g.id && r.status === RequestStatus.WAITING_FOR_SETUP,
        );
        const hasPending = openRequests.some(
          r => r.groupId === g.id && r.status === RequestStatus.PENDING,
        );
        const isKeycloakAdmin = this.user?.roles ? checkIsGroupAdmin(this.user.roles, g.slug, g.platform) : false;
        const isPlatformAdminOfGroup = managedPlatforms.includes(g.platform.toLowerCase());
        const isAdminOfGroup = isPlatformAdminOfGroup || g.admins.some(adm => adm.userId === userId) || isKeycloakAdmin;

        if (isSuperAdmin || isAdminOfGroup) {
          accessStatus = 'ACTIVE';
        } else if (hasActive) {
          accessStatus = 'ACTIVE';
        } else if (hasWaitingForSetup) {
          accessStatus = 'AWAITING_SETUP';
        } else if (hasPending) {
          accessStatus = 'PENDING';
        }

        return {
          id: g.id,
          name: g.name,
          slug: g.slug,
          description: g.description,
          icon: g.icon,
          color: g.color,
          platform: g.platform,
          externalGroupId: g.externalGroupId,
          tables: g.tables,
          memberCount: g._count.userAccesses,
          accessStatus,
          admins: g.admins.map(adm => ({
            userId: adm.userId,
            userName: adm.userName,
            userEmail: adm.userEmail,
          })),
        };
      });

      this.sendResponse(enrichedGroups, 'Groups retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve groups');
    }
  }

  // GET /api/groups/:slug
  async getGroupDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const slugResult = this.validateWithZod(groupSlugSchema, this.req.params.slug, 'Invalid group slug');
      if (!slugResult.success) return;
      const slug = slugResult.data;

      const userId = this.getUserId();
      if (!userId) return;

      const group = await prisma.group.findUnique({
        where: { slug },
        include: {
          admins: true,
          userAccesses: {
            where: { isActive: true },
            orderBy: { grantedAt: 'desc' },
          },
        },
      });

      if (!group) {
        this.sendErrorResponse('Group not found', 404);
        return;
      }

      // Check current user's status
      const activeAccess = await prisma.userAccess.findFirst({
        where: { userId, groupId: group.id, isActive: true },
      });
      // PENDING = awaiting admin review; WAITING_FOR_SETUP = approved but parked until
      // the requester finishes platform-account setup. Both are "open" for this group.
      const openRequest = await prisma.accessRequest.findFirst({
        where: {
          requesterId: userId,
          groupId: group.id,
          status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
        },
      });

      const isSuperAdmin = this.user?.roles.includes('hermes_super_admin') || false;
      const managedPlatforms = this.user ? await getManageablePlatforms(this.user) : [];
      const isKeycloakAdmin = this.user?.roles ? checkIsGroupAdmin(this.user.roles, group.slug, group.platform) : false;
      const isPlatformAdminOfGroup = managedPlatforms.includes(group.platform.toLowerCase());
      const isAdminOfGroup = isPlatformAdminOfGroup || group.admins.some(adm => adm.userId === userId) || isKeycloakAdmin;
      let accessStatus = 'NONE';
      if (isSuperAdmin || isAdminOfGroup) {
        accessStatus = 'ACTIVE';
      } else if (activeAccess) {
        accessStatus = 'ACTIVE';
      } else if (openRequest?.status === RequestStatus.WAITING_FOR_SETUP) {
        accessStatus = 'AWAITING_SETUP';
      } else if (openRequest) {
        accessStatus = 'PENDING';
      }

      // The roster shows everyone with active access — including admins, who hold an
      // auto-enrolled grant. The frontend cross-references `admins` to badge them and
      // suppress the Revoke action (an admin's access can't be revoked directly; they
      // must be demoted first). This differs from the Admin Management page, whose
      // "Members" bucket deliberately excludes admins (they live in their own section).
      //
      // Visibility: the roster is returned to every authenticated user, so it always
      // matches the public member count shown on the group list. Mutating actions
      // (Revoke) stay gated on the frontend by `canManage` (super-admin / group admin),
      // so non-admins can see who's in a group but can't change its membership.
      const responseData = {
        id: group.id,
        name: group.name,
        slug: group.slug,
        description: group.description,
        icon: group.icon,
        color: group.color,
        platform: group.platform,
        externalGroupId: group.externalGroupId,
        tables: group.tables,
        accessStatus,
        admins: group.admins.map(adm => ({
          userId: adm.userId,
          userName: adm.userName,
          userEmail: adm.userEmail,
          assignedAt: adm.assignedAt,
        })),
        memberCount: group.userAccesses.length,
        members: group.userAccesses.map(m => ({
          id: m.id,
          userId: m.userId,
          userName: m.userName,
          userEmail: m.userEmail,
          grantedAt: m.grantedAt,
          expiresAt: m.expiresAt,
          grantedBy: m.grantedBy,
        })),
      };

      this.sendResponse(responseData, 'Group details retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group details');
    }
  }
}
