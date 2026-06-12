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
import { assignPlatformAdminSchema, assignGroupAdminSchema, setMemberLevelSchema, addGroupMemberSchema } from '../validations/admin.validation';
import { createGroupLevelSchema, updateGroupLevelSchema } from '../validations/group-level.validation';
import { createGroupSchema, updateGroupSchema } from '../validations/group.validation';
import logger from '../utils/logger';
import { RequestStatus } from '@prisma/client';

const PLATFORM_ADMIN_MARKER = 'hermes_platform_admin';
const GROUP_ADMIN_MARKER = 'hermes_group_admin';

// Request statuses that are "done" — they can never lead to (or still hold) a live
// grant. A level referenced ONLY by requests in these states is safe to hard-delete;
// the FK from access_requests.level_id is ON DELETE SET NULL, so those historical
// rows simply lose their (now-dangling) level pointer while the audit log keeps the
// full record. Anything NOT in this set (PENDING / APPROVED / PROVISIONING /
// PROVISIONED / WAITING_FOR_SETUP) is in-flight and blocks the delete — we
// deactivate instead so the open request isn't orphaned.
const TERMINAL_REQUEST_STATUSES: RequestStatus[] = [
  RequestStatus.REJECTED,
  RequestStatus.PROVISION_FAILED,
  RequestStatus.EXPIRED,
  RequestStatus.REVOKED,
];

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
    // A user can now have one account-creation row per platform; name/email are
    // identical across them, so any row answers the "have we seen this user" question.
    const row = await prisma.userCreationRequest.findFirst({
      where: { userId },
      select: { userName: true, userEmail: true },
    });
    if (!row) {
      throw new NotFoundError(
        'User not found in Hermes. They must sign in to Hermes at least once before they can be assigned a role or added to a group.',
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
      // Candidates are every user Hermes has seen, on any platform — admin roles are
      // platform/group-scoped when assigned, not when searching. A user holds one
      // UserCreationRequest row per platform they've been provisioned on, so dedupe by
      // userId (distinct); otherwise someone with both a Redash and an AWS account would
      // be listed once per platform.
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
        distinct: ['userId'],
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
          // memberCount = everyone holding a real active grant. Admins are NOT
          // auto-enrolled, so any grant an admin holds is a genuine membership —
          // a person with both the admin role and a grant counts in both columns
          // (approval rights and data access are independent).
          const memberCount = g.userAccesses.length;
          return {
            id: g.id,
            name: g.name,
            slug: g.slug,
            platform: g.platform,
            description: g.description,
            color: g.color,
            icon: g.icon,
            tables: g.tables,
            externalGroupId: g.externalGroupId,
            isActive: g.isActive,
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

  // ── Group CRUD (super, or platform admin of the group's platform) ─────────
  // Managing a group's existence + its backing platform group is platform config,
  // so it mirrors level CRUD's tier: super admin or platform admin of the platform.

  /** Shared gate for editing/deleting an existing group: coarse precheck → load → platform-tier check. */
  private async authorizeGroupManagement(groupId: string) {
    if (!(await isAnyAdmin(this.user!))) {
      throw new AuthorizationError('You cannot manage this group');
    }
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');
    if (!(await isPlatformAdminOf(this.user!, group.platform))) {
      throw new AuthorizationError("You cannot manage groups for this group's platform");
    }
    return group;
  }

  // POST /api/admin/groups
  async createGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      // Coarse precheck before reading the body (avoids leaking via validation errors).
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You cannot create groups');
      }

      const validated = this.validateWithZod(createGroupSchema, this.req.body);
      if (!validated.success) return;
      const data = validated.data;
      const platform = data.platform; // lowercased by the schema

      if (!provisioningRegistry.has(platform)) {
        throw new ValidationError(`Unknown platform "${platform}" — no provisioner is registered for it.`);
      }
      // Must be super, or platform admin of THIS platform.
      if (!(await isPlatformAdminOf(this.user!, platform))) {
        throw new AuthorizationError('You cannot create groups for this platform');
      }

      // Resolve the backing platform group, same as createGroupLevel:
      //  - if the admin pasted an externalGroupId, link it as-is;
      //  - otherwise auto-create one via the adapter (named after the group) and
      //    roll it back if the Hermes insert then fails.
      const adapter = provisioningRegistry.get(platform);
      let externalGroupId = data.externalGroupId ?? null;
      let autoCreatedExternalGroupId: string | null = null;
      if (!externalGroupId && adapter.createExternalGroup) {
        const created = await adapter.createExternalGroup(data.name);
        externalGroupId = created.externalGroupId;
        autoCreatedExternalGroupId = created.externalGroupId;
      }

      let group;
      try {
        group = await prisma.group.create({
          data: {
            name: data.name,
            slug: data.slug,
            description: data.description,
            platform,
            icon: data.icon ?? null,
            color: data.color ?? null,
            tables: data.tables ?? [],
            externalGroupId,
          },
        });
      } catch (err: any) {
        if (autoCreatedExternalGroupId && adapter.deleteExternalGroup) {
          try {
            await adapter.deleteExternalGroup(autoCreatedExternalGroupId);
          } catch (cleanupErr: any) {
            logger.warn(
              { externalGroupId: autoCreatedExternalGroupId, error: cleanupErr.message },
              'Failed to roll back auto-created platform group after group insert failure',
            );
          }
        }
        if (err?.code === 'P2002') {
          throw new ConflictError('A group with this name or slug already exists.');
        }
        throw err;
      }

      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_CREATED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId: group.id,
          details: {
            name: group.name,
            slug: group.slug,
            platform,
            externalGroupId: group.externalGroupId,
            autoCreated: !!autoCreatedExternalGroupId,
          },
        },
      });

      this.sendResponse(group, 'Group created successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to create group');
    }
  }

  // PUT /api/admin/groups/:groupId — edit presentational fields + archive/restore.
  async updateGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const groupId = String(req.params.groupId);
      await this.authorizeGroupManagement(groupId);

      const validated = this.validateWithZod(updateGroupSchema, this.req.body);
      if (!validated.success) return;
      const data = validated.data;

      let group;
      try {
        group = await prisma.group.update({
          where: { id: groupId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.icon !== undefined ? { icon: data.icon } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.tables !== undefined ? { tables: data.tables } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new ConflictError('A group with this name already exists.');
        }
        throw err;
      }

      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_UPDATED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: { slug: group.slug, platform: group.platform, changed: Object.keys(data) },
        },
      });

      this.sendResponse(group, 'Group updated successfully');
    } catch (error) {
      this.handleError(error, 'Failed to update group');
    }
  }

  // DELETE /api/admin/groups/:groupId
  // Hard-deletes a group only when it's pristine — never referenced by any access
  // request or user access (those FKs are ON DELETE Restrict, so even a historical
  // row blocks the delete). Levels and group-admins ON DELETE Cascade away. Anything
  // with history archives instead (isActive:false): it leaves the request flow
  // (getGroups filters isActive) while existing members keep access until expiry/revoke.
  async deleteGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const groupId = String(req.params.groupId);
      const group = await this.authorizeGroupManagement(groupId);

      let [requestCount, accessCount] = await Promise.all([
        prisma.accessRequest.count({ where: { groupId } }),
        prisma.userAccess.count({ where: { groupId } }),
      ]);

      // The counts can go stale between the check and the delete (a request
      // created in that window hits the FK Restrict as P2003) — treat that the
      // same as "has history" and fall through to the archive path below.
      let raced = false;
      if (requestCount === 0 && accessCount === 0) {
        try {
          await prisma.group.delete({ where: { id: groupId } });
        } catch (err: any) {
          if (err?.code !== 'P2003') throw err;
          raced = true;
          [requestCount, accessCount] = await Promise.all([
            prisma.accessRequest.count({ where: { groupId } }),
            prisma.userAccess.count({ where: { groupId } }),
          ]);
          logger.info(
            { groupId, requestCount, accessCount },
            'Group delete raced with a new reference — archiving instead',
          );
        }
      }

      if (requestCount === 0 && accessCount === 0 && !raced) {
        // Best-effort removal of the backing platform group — no one is affected
        // (the group had no members or requests). Don't fail the delete on cleanup error.
        if (group.externalGroupId) {
          const adapter = provisioningRegistry.has(group.platform)
            ? provisioningRegistry.get(group.platform)
            : null;
          if (adapter?.deleteExternalGroup) {
            try {
              await adapter.deleteExternalGroup(group.externalGroupId);
            } catch (cleanupErr: any) {
              logger.warn(
                { externalGroupId: group.externalGroupId, error: cleanupErr.message },
                'Group deleted but failed to remove its backing platform group',
              );
            }
          }
        }

        await prisma.auditEntry.create({
          data: {
            action: 'GROUP_DELETED',
            performerId: this.user!.id,
            performerName: this.user!.username,
            groupId,
            details: { name: group.name, slug: group.slug, platform: group.platform, externalGroupId: group.externalGroupId },
          },
        });
        this.sendResponse({ id: groupId, deleted: true }, 'Group deleted');
        return;
      }

      // Has history → archive instead of delete.
      const archived = await prisma.group.update({ where: { id: groupId }, data: { isActive: false } });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_ARCHIVED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: { name: archived.name, slug: archived.slug, platform: archived.platform, requestCount, accessCount },
        },
      });
      this.sendResponse(
        { id: groupId, deleted: false, requestCount, accessCount },
        `Group has history (${accessCount} access record(s), ${requestCount} request(s)), so it was archived instead of deleted — it's hidden from new requests and existing members keep access until expiry/revoke.`,
      );
    } catch (error) {
      this.handleError(error, 'Failed to delete group');
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

      // Group admins get approval rights only — they are NOT auto-enrolled as
      // members of the group they administer. If they need data access they request
      // it through the normal request → approval → duration flow like anyone else.
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

      // Every active grant is a real membership — admins are NOT auto-enrolled, so
      // an admin appears here too when they hold a grant (requested through the
      // normal flow). The `isAdmin` flag lets the UI badge them; their grant is
      // revocable like any member's (approval rights come from the role, not the grant).
      const [members, admins] = await Promise.all([
        prisma.userAccess.findMany({
          where: { groupId, isActive: true },
          orderBy: { grantedAt: 'desc' },
          include: { level: { select: { name: true, permission: true } } },
        }),
        prisma.groupAdmin.findMany({ where: { groupId }, select: { userId: true } }),
      ]);
      const adminUserIds = new Set(admins.map((a) => a.userId));

      this.sendResponse(
        members.map((m) => ({
          id: m.id,
          userId: m.userId,
          userName: m.userName,
          userEmail: m.userEmail,
          groupId: m.groupId,
          externalUserId: m.externalUserId,
          isActive: m.isActive,
          grantedAt: m.grantedAt,
          expiresAt: m.expiresAt,
          grantedBy: m.grantedBy,
          // The level the member is currently on (null = level-less/legacy grant).
          levelId: m.levelId,
          levelName: m.level?.name ?? null,
          levelPermission: m.level?.permission ?? null,
          // True if this member also holds the group-admin role (badge in the UI).
          isAdmin: adminUserIds.has(m.userId),
        })),
        'Group members retrieved successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group members');
    }
  }

  // POST /api/admin/groups/:groupId/members  { userId, levelId?, duration }
  // Admin override: add a user to the group directly — equivalent to an
  // already-approved request, so it carries the same tier as the other member
  // actions (group admin of this group, or platform/super above it). The workflow
  // service applies the normal request validations + the per-platform account gate.
  async addGroupMember(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

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

      const validated = this.validateWithZod(addGroupMemberSchema, this.req.body);
      if (!validated.success) return;

      const profile = await this.resolveUserProfile(validated.data.userId);
      const result = await accessWorkflowService.adminAddMember(
        { id: userId, username: this.user!.username },
        { id: validated.data.userId, name: profile.userName, email: profile.userEmail },
        groupId,
        validated.data.levelId ?? null,
        validated.data.duration,
      );

      this.sendResponse(
        result,
        result.kind === 'provisioned'
          ? 'Member added to group'
          : 'Member queued — they will be added automatically once their platform account setup completes',
        201,
      );
    } catch (error) {
      this.handleError(error, 'Failed to add group member');
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

      // Group admins are no longer auto-enrolled, so any grant a current admin holds
      // came from a normal request — it's a real, removable membership. (Removing it
      // leaves their approval rights intact; those come from the admin role, not the
      // grant.)
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

  // PUT /api/admin/groups/:groupId/members/:userAccessId/level  { levelId }
  // Admin override: set the level a member holds. Same authorization as the other
  // member actions (group admin of this group, or platform/super above it). The
  // swap (and platform re-provisioning) happens in the workflow service.
  async setGroupMemberLevel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence oracle).
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

      const validated = this.validateWithZod(setMemberLevelSchema, this.req.body);
      if (!validated.success) return;

      const access = await prisma.userAccess.findUnique({ where: { id: userAccessId } });
      if (!access || access.groupId !== groupId) {
        throw new NotFoundError('Member not found in this group');
      }

      const updated = await accessWorkflowService.adminSetMemberLevel(
        { id: userId, username: this.user!.username },
        userAccessId,
        validated.data.levelId,
      );

      this.sendResponse(updated, 'Member level updated');
    } catch (error) {
      this.handleError(error, 'Failed to update member level');
    }
  }

  // ── Group levels (subgroups) ───────────────────────────────────────────────
  // Levels carry the per-level externalGroupId that maps to a platform group, so
  // managing them is platform configuration: super admin or platform admin of the
  // group's platform. (Group admins approve requests for any level, but don't wire
  // up the external mapping.) isPlatformAdminOf returns true for super admins too.

  /** Shared gate for level CRUD: coarse precheck → load group → platform-tier check. */
  private async authorizeLevelManagement(groupId: string) {
    if (!(await isAnyAdmin(this.user!))) {
      throw new AuthorizationError("You cannot manage this group's levels");
    }
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');
    if (!(await isPlatformAdminOf(this.user!, group.platform))) {
      throw new AuthorizationError("You cannot manage levels for this group's platform");
    }
    return group;
  }

  // GET /api/admin/groups/:groupId/levels — all levels (incl. inactive) + member counts.
  async listGroupLevels(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const groupId = String(req.params.groupId);
      await this.authorizeLevelManagement(groupId);

      const levels = await prisma.groupLevel.findMany({
        where: { groupId },
        orderBy: [{ rank: 'desc' }, { name: 'asc' }],
        include: {
          _count: { select: { userAccesses: { where: { isActive: true } } } },
        },
      });

      this.sendResponse(
        levels.map((l) => ({
          id: l.id,
          name: l.name,
          slug: l.slug,
          description: l.description,
          permission: l.permission,
          externalGroupId: l.externalGroupId,
          rank: l.rank,
          isActive: l.isActive,
          memberCount: l._count.userAccesses,
        })),
        'Group levels retrieved successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group levels');
    }
  }

  // POST /api/admin/groups/:groupId/levels
  async createGroupLevel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const groupId = String(req.params.groupId);
      const group = await this.authorizeLevelManagement(groupId);

      const validated = this.validateWithZod(createGroupLevelSchema, this.req.body);
      if (!validated.success) return;
      const data = validated.data;

      // Resolve the backing platform group:
      //  - if the admin pasted an externalGroupId, use it as-is (link an existing group);
      //  - otherwise, if the platform adapter can create groups, provision one
      //    automatically (named "<Group> — <Level>") and use its id. The admin
      //    then sets that group's data-source permissions on the platform itself.
      let externalGroupId = data.externalGroupId ?? null;
      let autoCreatedExternalGroupId: string | null = null;
      const adapter = provisioningRegistry.has(group.platform)
        ? provisioningRegistry.get(group.platform)
        : null;
      if (!externalGroupId && adapter?.createExternalGroup) {
        const created = await adapter.createExternalGroup(`${group.name} — ${data.name}`);
        externalGroupId = created.externalGroupId;
        autoCreatedExternalGroupId = created.externalGroupId;
      }

      let level;
      try {
        level = await prisma.groupLevel.create({
          data: {
            groupId,
            name: data.name,
            slug: data.slug,
            description: data.description ?? null,
            permission: data.permission ?? null,
            externalGroupId,
            rank: data.rank ?? 0,
            isActive: data.isActive ?? true,
          },
        });
      } catch (err: any) {
        // Roll back an auto-created platform group so a failed insert doesn't orphan it.
        if (autoCreatedExternalGroupId && adapter?.deleteExternalGroup) {
          try {
            await adapter.deleteExternalGroup(autoCreatedExternalGroupId);
          } catch (cleanupErr: any) {
            logger.warn(
              { externalGroupId: autoCreatedExternalGroupId, error: cleanupErr.message },
              'Failed to roll back auto-created platform group after level insert failure',
            );
          }
        }
        if (err?.code === 'P2002') {
          throw new ConflictError('A level with this slug already exists in this group.');
        }
        throw err;
      }

      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_LEVEL_CREATED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: {
            levelId: level.id,
            slug: level.slug,
            name: level.name,
            platform: group.platform,
            externalGroupId: level.externalGroupId,
            autoCreated: !!autoCreatedExternalGroupId,
          },
        },
      });

      this.sendResponse(level, 'Level created successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to create level');
    }
  }

  // PUT /api/admin/groups/:groupId/levels/:levelId
  async updateGroupLevel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const groupId = String(req.params.groupId);
      const levelId = String(req.params.levelId);
      const group = await this.authorizeLevelManagement(groupId);

      const existing = await prisma.groupLevel.findUnique({ where: { id: levelId } });
      if (!existing || existing.groupId !== groupId) {
        throw new NotFoundError('Level not found in this group');
      }

      const validated = this.validateWithZod(updateGroupLevelSchema, this.req.body);
      if (!validated.success) return;
      const data = validated.data;

      let level;
      try {
        level = await prisma.groupLevel.update({
          where: { id: levelId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.slug !== undefined ? { slug: data.slug } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.permission !== undefined ? { permission: data.permission } : {}),
            ...(data.externalGroupId !== undefined ? { externalGroupId: data.externalGroupId } : {}),
            ...(data.rank !== undefined ? { rank: data.rank } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new ConflictError('A level with this slug already exists in this group.');
        }
        throw err;
      }

      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_LEVEL_UPDATED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: {
            levelId: level.id,
            slug: level.slug,
            platform: group.platform,
            changed: Object.keys(data),
            externalGroupIdChanged: data.externalGroupId !== undefined && data.externalGroupId !== existing.externalGroupId,
          },
        },
      });

      this.sendResponse(level, 'Level updated successfully');
    } catch (error) {
      this.handleError(error, 'Failed to update level');
    }
  }

  // DELETE /api/admin/groups/:groupId/levels/:levelId
  // Hard-deletes a level that no longer has any live attachment — no active members
  // and no in-flight requests. Past terminal requests (rejected/expired/revoked) do
  // NOT block the delete: their level_id is nulled by the FK and the history lives on
  // in the audit log. Falls back to deactivation only when there's still an active
  // member or an open request that would otherwise be orphaned.
  async deleteGroupLevel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.getUserId()) return;
      const groupId = String(req.params.groupId);
      const levelId = String(req.params.levelId);
      const group = await this.authorizeLevelManagement(groupId);

      const existing = await prisma.groupLevel.findUnique({
        where: { id: levelId },
        include: {
          _count: {
            select: {
              userAccesses: { where: { isActive: true } },
              accessRequests: { where: { status: { notIn: TERMINAL_REQUEST_STATUSES } } },
            },
          },
        },
      });
      if (!existing || existing.groupId !== groupId) {
        throw new NotFoundError('Level not found in this group');
      }

      const activeMembers = existing._count.userAccesses;
      const openRequests = existing._count.accessRequests;

      // Hard delete only if nothing live is attached: no active members AND no
      // in-flight requests. Terminal historical requests are fine to detach (SetNull).
      if (activeMembers === 0 && openRequests === 0) {
        await prisma.groupLevel.delete({ where: { id: levelId } });

        // Best-effort removal of the backing platform group. The level has no active
        // members or open requests, so no one is affected. Don't fail the delete if
        // the platform cleanup errors — the Hermes row is already gone.
        if (existing.externalGroupId) {
          const adapter = provisioningRegistry.has(group.platform)
            ? provisioningRegistry.get(group.platform)
            : null;
          if (adapter?.deleteExternalGroup) {
            try {
              await adapter.deleteExternalGroup(existing.externalGroupId);
            } catch (cleanupErr: any) {
              logger.warn(
                { externalGroupId: existing.externalGroupId, error: cleanupErr.message },
                'Level deleted but failed to remove its backing platform group',
              );
            }
          }
        }

        await prisma.auditEntry.create({
          data: {
            action: 'GROUP_LEVEL_DELETED',
            performerId: this.user!.id,
            performerName: this.user!.username,
            groupId,
            details: { levelId, slug: existing.slug, name: existing.name, platform: group.platform, externalGroupId: existing.externalGroupId },
          },
        });
        this.sendResponse({ id: levelId, deleted: true }, 'Level deleted');
        return;
      }

      // Otherwise deactivate — something live is still attached (active members or an
      // in-flight request). Members keep access until expiry/revoke; no new requests
      // can select it (createRequest only offers active levels).
      const level = await prisma.groupLevel.update({
        where: { id: levelId },
        data: { isActive: false },
      });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_LEVEL_DEACTIVATED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: { levelId, slug: existing.slug, name: existing.name, platform: group.platform, activeMembers, openRequests },
        },
      });
      this.sendResponse(
        { id: levelId, deleted: false, activeMembers, openRequests },
        activeMembers > 0
          ? `Level has ${activeMembers} active member(s); it was deactivated (not deleted) so they keep access until expiry/revoke.`
          : `Level has ${openRequests} in-flight request(s); it was deactivated (not deleted) so they aren't orphaned. Resolve those requests, then remove it.`,
      );
    } catch (error) {
      this.handleError(error, 'Failed to delete level');
    }
  }
}

export default AdminManagementController;
