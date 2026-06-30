import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import { RequestStatus } from '../../generated/hermes';
import { groupSlugSchema } from '../validations/group.validation';
import { isGroupAdminOf } from '../utils/authz';

export class GroupController extends BaseController {
  // GET /api/groups
  async getGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      const [groups, activeAccesses, openRequests] = await Promise.all([
        prisma.group.findMany({
          where: { isActive: true },
          include: {
            admins: true,
            levels: {
              where: { isActive: true },
              orderBy: { rank: 'desc' },
            },
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
          // Level included via the relation so the user's current level renders
          // even when that level has since been deactivated (the public `levels`
          // list below only carries active ones).
          include: { level: { select: { name: true } } },
        }),
        // PENDING = awaiting admin review; WAITING_FOR_SETUP = approved but parked
        // until the requester finishes their platform-account setup. Both mean the
        // user has an open request for the group — neither should read as NO ACCESS.
        prisma.accessRequest.findMany({
          where: {
            requesterId: userId,
            status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
          },
        }),
      ]);

      // accessStatus reflects the user's REAL grant/request state only. Admins get
      // no cosmetic ACTIVE short-circuit: the admin role grants approval rights, not
      // data access — an admin with no grant sees NONE and can request access like
      // anyone else (the `admins` array below is what the UI badges admins from).
      const enrichedGroups = groups.map(g => {
        let accessStatus = 'NONE';

        const myAccess = activeAccesses.find(a => a.groupId === g.id);
        const hasActive = activeAccesses.some(a => a.groupId === g.id);
        const hasWaitingForSetup = openRequests.some(
          r => r.groupId === g.id && r.status === RequestStatus.WAITING_FOR_SETUP,
        );
        const hasPending = openRequests.some(
          r => r.groupId === g.id && r.status === RequestStatus.PENDING,
        );

        if (hasActive) {
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
          // Public level list — intentionally omits each level's externalGroupId
          // (platform config, exposed only via the admin level endpoints).
          levels: g.levels.map(l => ({
            id: l.id,
            name: l.name,
            slug: l.slug,
            description: l.description,
            permission: l.permission,
            rank: l.rank,
          })),
          // The level the current user is actively granted on, if any (resolved
          // via the relation so a deactivated level still shows its name).
          currentLevelId: myAccess?.levelId ?? null,
          currentLevelName: myAccess?.level?.name ?? null,
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
      if (!slugResult.success) {return;}
      const slug = slugResult.data;

      const userId = this.getUserId();
      if (!userId) {return;}

      const group = await prisma.group.findUnique({
        where: { slug },
        include: {
          admins: true,
          levels: {
            where: { isActive: true },
            orderBy: { rank: 'desc' },
          },
          userAccesses: {
            where: { isActive: true },
            orderBy: { grantedAt: 'desc' },
            include: { level: { select: { name: true, slug: true } } },
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
        include: { level: { select: { name: true, slug: true } } },
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

      // accessStatus reflects the user's REAL grant/request state only — no cosmetic
      // admin short-circuit (admin role = approval rights, not data access). An admin
      // with no grant sees NONE and requests access through the normal flow.
      let accessStatus = 'NONE';
      if (activeAccess) {
        accessStatus = 'ACTIVE';
      } else if (openRequest?.status === RequestStatus.WAITING_FOR_SETUP) {
        accessStatus = 'AWAITING_SETUP';
      } else if (openRequest) {
        accessStatus = 'PENDING';
      }

      // The roster shows everyone with active access. An admin appears here only if
      // they hold a REAL grant (requested through the normal flow) — admins are not
      // auto-enrolled. The frontend cross-references `admins` to badge them; their
      // grant is revocable like any member's (revoking it leaves approval rights
      // intact, since those come from the admin role, not the grant).
      //
      // Visibility: the member roster is returned ONLY to users who can manage this
      // group (super admin / platform admin / group admin). Simple users get an empty
      // roster — they can see the public member COUNT but not who's in the group.
      const canManage = await isGroupAdminOf(this.user!, group.id, group.slug);
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
        levels: group.levels.map(l => ({
          id: l.id,
          name: l.name,
          slug: l.slug,
          description: l.description,
          permission: l.permission,
          rank: l.rank,
        })),
        currentLevelId: activeAccess?.levelId ?? null,
        currentLevelName: activeAccess?.level?.name ?? null,
        admins: group.admins.map(adm => ({
          userId: adm.userId,
          userName: adm.userName,
          userEmail: adm.userEmail,
          assignedAt: adm.assignedAt,
        })),
        memberCount: group.userAccesses.length,
        members: canManage
          ? group.userAccesses.map(m => ({
              id: m.id,
              userId: m.userId,
              userName: m.userName,
              userEmail: m.userEmail,
              grantedAt: m.grantedAt,
              expiresAt: m.expiresAt,
              grantedBy: m.grantedBy,
              levelId: m.levelId,
              levelName: m.level?.name ?? null,
            }))
          : [],
      };

      this.sendResponse(responseData, 'Group details retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group details');
    }
  }
}
