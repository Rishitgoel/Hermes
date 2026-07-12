import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import provisioningRegistry from '../services/provisioning.registry';
import type { ReconcileMembersResult } from '../services/provisioner.interface';
import keycloakAdminService from '../services/keycloak-admin.service';
import accessWorkflowService from '../services/access-workflow.service';
import userCreationService from '../services/user-creation.service';
import {
  isSuperAdmin,
  isPlatformAdminOf,
  isGroupAdminOf,
  isAnyAdmin,
  getManageablePlatforms,
} from '../utils/authz';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../utils/errors';
import {
  assignPlatformAdminSchema,
  assignGroupAdminSchema,
  setMemberLevelSchema,
  addGroupMemberSchema,
  revokeUserAccessSchema,
  disableUserAccountsSchema,
} from '../validations/admin.validation';
import {
  createGroupLevelSchema,
  updateGroupLevelSchema,
} from '../validations/group-level.validation';
import {
  createGroupSchema,
  updateGroupSchema,
} from '../validations/group.validation';
import logger from '../utils/logger';
import { getSecretsManagerService } from '../services/secrets-manager.service';
import { assertSecretsPlatform, isSecretsFamilyPlatform } from '../services/secret-ingestion.service';
import { RequestStatus, UserCreationStatus } from '../../generated/hermes';


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

// UserCreationStatus values under which the user has (or is finishing getting) a
// live account on the platform — i.e. an externalUserId that account-level
// offboarding (disableUser) can act on. DRAFT/PENDING/REJECTED never reached one.
const ACCOUNT_HOLDING_STATUSES: UserCreationStatus[] = [
  UserCreationStatus.APPROVED,
  UserCreationStatus.AWAITING_SETUP,
  UserCreationStatus.COMPLETED,
];

const platformAdminRole = (platform: string) =>
  `hermes_platform_admin_${platform.toLowerCase()}`;
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
  private async resolveUserProfile(
    userId: string,
  ): Promise<{ userName: string; userEmail: string }> {
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

  /**
   * Derive a globally-unique group slug from `base` (already validated as
   * lowercase-alphanumeric-with-hyphens). The `slug` column is globally unique, so
   * two groups with the same name — even on different platforms — would otherwise
   * collide. If `base` is free we use it; otherwise we append the smallest numeric
   * suffix (`-2`, `-3`, …) that isn't taken. One query fetches every conflicting
   * slug; the create call's P2002 catch covers the rare concurrent-create race.
   */
  private async generateUniqueGroupSlug(base: string): Promise<string> {
    const existing = await prisma.group.findMany({
      where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
      select: { slug: true },
    });
    const taken = new Set(existing.map((g) => g.slug));
    if (!taken.has(base)) {
      return base;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`)) {
      n++;
    }
    return `${base}-${n}`;
  }

  // GET /api/admin/platforms — platform keys the caller may administer.
  async listManageablePlatforms(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const platforms = await getManageablePlatforms(this.user!);
      // Gate like the sibling lookups (/users, /groups, /group-admins): a non-admin
      // with no manageable platforms gets 403, not a 200 with an empty array.
      if (platforms.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }
      this.sendResponse(
        platforms,
        'Manageable platforms retrieved successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve manageable platforms');
    }
  }

  // GET /api/admin/aws-secrets[?platform=secrets-sandbox] — list all AWS secrets in the given
  // Secret Ingestion account (platform/super admin only). Used by group config to build an
  // externalGroupId. Defaults to prod ("secrets"); sandbox lists its own account's secrets.
  async listAwsSecrets(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const platform = this.req.query.platform
        ? assertSecretsPlatform(String(this.req.query.platform))
        : 'secrets';
      if (!(await isPlatformAdminOf(this.user!, platform))) {
        throw new AuthorizationError('You do not have permission to view AWS secrets.');
      }

      const secrets = await getSecretsManagerService(platform).listAllAwsSecrets();
      this.sendResponse(secrets, 'AWS secrets retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve AWS secrets');
    }
  }

  // GET /api/admin/users?search= — candidate users to promote (seen by Hermes).
  async searchUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

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
  async listPlatformAdmins(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError(
          'Only super admins can view platform admins',
        );
      }

      const platform = req.query.platform
        ? String(req.query.platform).toLowerCase()
        : undefined;
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
  async assignPlatformAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError(
          'Only super admins can assign platform admins',
        );
      }

      const validated = this.validateWithZod(
        assignPlatformAdminSchema,
        this.req.body,
      );
      if (!validated.success) {return;}

      const userId = validated.data.userId;
      const platform = validated.data.platform.toLowerCase();

      if (!provisioningRegistry.has(platform)) {
        throw new ValidationError(
          `Unknown platform "${platform}" — no provisioner is registered for it.`,
        );
      }

      const profile = await this.resolveUserProfile(userId);
      const role = platformAdminRole(platform);

      // Keycloak (source of truth): ensure the composite role exists, then assign.
      await keycloakAdminService.ensureCompositeRole(
        role,
        PLATFORM_ADMIN_MARKER,
        `Hermes platform admin for ${platform}`,
      );
      await keycloakAdminService.assignRealmRole(userId, role);

      const row = await prisma.platformAdmin.upsert({
        where: { userId_platform: { userId, platform } },
        update: {
          userName: profile.userName,
          userEmail: profile.userEmail,
          assignedBy: this.user!.username,
        },
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
  async removePlatformAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError(
          'Only super admins can remove platform admins',
        );
      }

      const id = String(req.params.id);
      const row = await prisma.platformAdmin.findUnique({ where: { id } });
      if (!row) {throw new NotFoundError('Platform admin assignment not found');}

      await keycloakAdminService.removeRealmRole(
        row.userId,
        platformAdminRole(row.platform),
      );
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
          details: {
            platform: row.platform,
            role: platformAdminRole(row.platform),
          },
        },
      });

      this.sendResponse({ id }, 'Platform admin removed successfully');
    } catch (error) {
      this.handleError(error, 'Failed to remove platform admin');
    }
  }

  // ── Manageable groups (for the UI tree) ──────────────────────────────────

  // GET /api/admin/groups?platform=
  async listManageableGroups(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

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
        groups.map(g => {
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
            openEnrollment: g.openEnrollment,
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
    if (!group) {throw new NotFoundError('Group not found');}
    if (!(await isPlatformAdminOf(this.user!, group.platform))) {
      throw new AuthorizationError(
        'You cannot manage groups for this group\'s platform',
      );
    }
    return group;
  }

  // POST /api/admin/groups
  async createGroup(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      // Coarse precheck before reading the body (avoids leaking via validation errors).
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You cannot create groups');
      }

      const validated = this.validateWithZod(createGroupSchema, this.req.body);
      if (!validated.success) {return;}
      const data = validated.data;
      const platform = data.platform; // lowercased by the schema

      if (!provisioningRegistry.has(platform)) {
        throw new ValidationError(
          `Unknown platform "${platform}" — no provisioner is registered for it.`,
        );
      }
      // Must be super, or platform admin of THIS platform.
      if (!(await isPlatformAdminOf(this.user!, platform))) {
        throw new AuthorizationError(
          'You cannot create groups for this platform',
        );
      }
      // openEnrollment only makes sense for secrets-family groups — it's what lets every user
      // implicitly stage ingestion requests with no join step. On any other platform it would
      // show the group as ACTIVE for every user with no real grant or provisioning behind it,
      // and createRequest refuses requests for it, leaving a dead end.
      if (data.openEnrollment && !isSecretsFamilyPlatform(platform)) {
        throw new ValidationError(
          'Open enrollment is only supported for Secret Ingestion groups.',
        );
      }

      // Resolve the backing platform group, same as createGroupLevel:
      //  - if the admin pasted an externalGroupId, link it as-is;
      //  - otherwise auto-create one via the adapter (named after the group) and
      //    roll it back if the Hermes insert then fails.
      const adapter = provisioningRegistry.get(platform);
      // Validate a pasted id against the platform's format before doing any work, so a
      // malformed value (e.g. a ZooKeeper path missing its leading "/") is rejected up
      // front instead of being saved and then breaking every future provision.
      if (data.externalGroupId)
        {adapter.validateExternalGroupId?.(data.externalGroupId);}
      let externalGroupId = data.externalGroupId ?? null;
      let autoCreatedExternalGroupId: string | null = null;
      if (!externalGroupId && adapter.createExternalGroup) {
        const created = await adapter.createExternalGroup(data.name);
        externalGroupId = created.externalGroupId;
        autoCreatedExternalGroupId = created.externalGroupId;
      }

      // Slug is server-authoritative: ignore the client's derived slug and resolve a
      // globally-unique one (auto-suffixed if the base is taken) so creation never
      // fails on a slug collision. A duplicate name on the SAME platform is still a
      // real conflict (the @@unique([platform, name]) constraint) and is reported below.
      const uniqueSlug = await this.generateUniqueGroupSlug(data.slug);

      let group;
      try {
        group = await prisma.group.create({
          data: {
            name: data.name,
            slug: uniqueSlug,
            description: data.description,
            platform,
            icon: data.icon ?? null,
            color: data.color ?? null,
            tables: data.tables ?? [],
            externalGroupId,
            openEnrollment: data.openEnrollment ?? false,
          },
        });
      } catch (err: any) {
        if (autoCreatedExternalGroupId && adapter.deleteExternalGroup) {
          try {
            await adapter.deleteExternalGroup(autoCreatedExternalGroupId);
          } catch (cleanupErr: any) {
            logger.warn(
              {
                externalGroupId: autoCreatedExternalGroupId,
                error: cleanupErr.message,
              },
              'Failed to roll back auto-created platform group after group insert failure',
            );
          }
        }
        if (err?.code === 'P2002') {
          const target = Array.isArray(err?.meta?.target)
            ? err.meta.target.join(',')
            : String(err?.meta?.target ?? '');
          // Slug is auto-uniquified above, so a slug hit here can only be a rare
          // concurrent-create race; name collisions are the real user-facing case.
          if (target.includes('name')) {
            throw new ConflictError(
              'A group with this name already exists on this platform.',
            );
          }
          throw new ConflictError(
            'A group with this slug already exists. Please try again.',
          );
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
            openEnrollment: group.openEnrollment,
          },
        },
      });

      this.sendResponse(group, 'Group created successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to create group');
    }
  }

  /**
   * POST /api/admin/maintenance/ensure-secrets-group — super-admin only.
   *
   * Idempotently creates the "All Secrets" group: platform `secrets`, externalGroupId `*`
   * (the wildcard-all scope, resolved live against AWS). Members of this group can stage
   * ingestion requests for every secret, including ones added to AWS later. This is the
   * no-terminal maintenance path for prod — safe to click repeatedly; returns the existing
   * group if one with the wildcard-all scope is already present.
   */
  async ensureAllSecretsGroup(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can run this maintenance action.');
      }
      // Which Secret Ingestion instance to stand the all-secrets group up on (prod vs sandbox),
      // from the request body; defaults to prod. Validated against the configured secrets family.
      const SECRETS_PLATFORM = this.req.body?.platform
        ? assertSecretsPlatform(this.req.body.platform)
        : 'secrets';
      const ALL_SCOPE = '*';
      if (!provisioningRegistry.has(SECRETS_PLATFORM)) {
        throw new ValidationError(
          'The Secret Ingestion platform is not enabled on this deployment.',
        );
      }

      // Idempotent on the SCOPE, not the name — if a wildcard-all secrets group already
      // exists (whatever it's called), return it instead of creating a duplicate.
      const existing = await prisma.group.findFirst({
        where: { platform: SECRETS_PLATFORM, externalGroupId: ALL_SCOPE },
      });
      if (existing) {
        // Idempotent on SCOPE only (externalGroupId === '*', already matched above) — never
        // silently flip openEnrollment back on here. An admin may have deliberately turned it
        // off via the group settings toggle to lock down account-wide secret visibility;
        // re-running this maintenance action must not undo that choice with no confirmation.
        // If open enrollment is currently off, surface that in the response so the caller
        // knows to re-enable it explicitly (via the group settings toggle) if that's wanted.
        this.sendResponse(
          { group: existing, created: false, openEnrollment: existing.openEnrollment },
          existing.openEnrollment
            ? 'All-Secrets group already exists'
            : 'All-Secrets group already exists (open enrollment is currently off — enable it from the group settings if that was unintentional)',
        );
        return;
      }

      const uniqueSlug = await this.generateUniqueGroupSlug('all-secrets');
      let group;
      try {
        group = await prisma.group.create({
          data: {
            name: 'All Secrets',
            slug: uniqueSlug,
            description:
              'Grants access to every AWS secret (resolved live). Members can stage Secret Ingestion requests for any secret, including ones added later.',
            platform: SECRETS_PLATFORM,
            icon: 'KeyRound',
            color: '#DD344C',
            tables: [],
            externalGroupId: ALL_SCOPE,
            // Open to everyone — the whole point of the all-secrets group is that
            // any user can stage a Secret Ingestion request while admins approve.
            openEnrollment: true,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          // Concurrent create race → re-fetch the wildcard-all group and return it.
          const race = await prisma.group.findFirst({
            where: { platform: SECRETS_PLATFORM, externalGroupId: ALL_SCOPE },
          });
          if (race) {
            this.sendResponse(
              { group: race, created: false },
              'All-Secrets group already exists',
            );
            return;
          }
          // Otherwise a group NAMED "All Secrets" exists but its scope has
          // drifted away from '*' (e.g. an admin edited it down via the group
          // settings UI) — restore the wildcard scope instead of failing, so
          // this stays a reliable no-terminal recovery path rather than a dead
          // end once the scope has ever drifted.
          const drifted = await prisma.group.findUnique({
            where: { platform_name: { platform: SECRETS_PLATFORM, name: 'All Secrets' } },
          });
          if (!drifted) {
            throw new ConflictError(
              'A group named "All Secrets" already exists on the Secret Ingestion platform, but it could not be found to restore its scope.',
            );
          }
          // Restore the SCOPE only — leave openEnrollment as the admin last set it. This
          // branch fixes a drifted externalGroupId, it must not also silently re-enable open
          // enrollment if an admin deliberately turned it off.
          const restored = await prisma.group.update({
            where: { id: drifted.id },
            data: { externalGroupId: ALL_SCOPE, isActive: true },
          });
          await prisma.auditEntry.create({
            data: {
              action: 'GROUP_UPDATED',
              performerId: this.user!.id,
              performerName: this.user!.username,
              groupId: restored.id,
              details: {
                name: restored.name,
                slug: restored.slug,
                platform: SECRETS_PLATFORM,
                previousExternalGroupId: drifted.externalGroupId,
                externalGroupId: ALL_SCOPE,
                maintenance: 'ensure-all-secrets-group-restore',
              },
            },
          });
          this.sendResponse(
            { group: restored, created: false, restored: true },
            'All-Secrets group scope was restored to wildcard-all',
          );
          return;
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
            platform: SECRETS_PLATFORM,
            externalGroupId: group.externalGroupId,
            maintenance: 'ensure-all-secrets-group',
          },
        },
      });

      this.sendResponse({ group, created: true }, 'All-Secrets group created', 201);
    } catch (error) {
      this.handleError(error, 'Failed to set up the All-Secrets group');
    }
  }

  /**
   * For each of `emails`, collect the external ids of their OTHER active grants on
   * `platform` (any group except `excludeGroupId`). Handed to `reconcileMembers` as
   * each member's `retainExternalGroupIds` so a multi-target adapter (ZooKeeper) never
   * strips a path the member still legitimately holds through a different group/level.
   * One query for the whole member set; returns email → external-id list.
   */
  private async collectMemberRetainExternalIds(
    emails: string[],
    platform: string,
    excludeGroupId: string,
  ): Promise<Map<string, string[]>> {
    return accessWorkflowService.collectRetainedExternalGroupIds({
      keys: emails,
      platform,
      keyType: 'email',
      excludeGroupId,
    });
  }

  /**
   * Shared by updateGroup / updateGroupLevel: after a group's or level's `externalGroupId`
   * changes, reconcile its existing members (`memberWhere`) onto the new mapping via the
   * platform adapter, then write the GROUP_PATHS_RECONCILED audit row. Returns the
   * reconciliation summary, or null when the adapter can't reconcile (single-target
   * platforms leave members in place). Best-effort: the new config is already persisted as
   * the source of truth, so per-member failures come back inside the summary, not thrown.
   */
  private async reconcileExternalGroupChange(opts: {
    groupId: string;
    platform: string;
    memberWhere: { groupId: string; levelId: string | null };
    oldExternalGroupId: string | null;
    newExternalGroupId: string | null;
    auditExtra?: Record<string, unknown>;
  }): Promise<ReconcileMembersResult | null> {
    const adapter = provisioningRegistry.tryGet(opts.platform);

    let reconciliation: ReconcileMembersResult | null = null;
    if (adapter?.reconcileMembers) {
      const members = await prisma.userAccess.findMany({
        where: {
          ...opts.memberWhere,
          isActive: true,
          externalUserId: { not: null },
        },
        select: { userEmail: true, userName: true, externalUserId: true },
      });
      const retainByEmail = await this.collectMemberRetainExternalIds(
        members.map(m => m.userEmail),
        opts.platform,
        opts.groupId,
      );
      reconciliation = await adapter.reconcileMembers({
        oldExternalGroupId: opts.oldExternalGroupId,
        newExternalGroupId: opts.newExternalGroupId,
        members: members.map(m => ({
          email: m.userEmail,
          name: m.userName,
          externalUserId: m.externalUserId!,
          retainExternalGroupIds: retainByEmail.get(m.userEmail) ?? [],
        })),
      });
    }

    await prisma.auditEntry.create({
      data: {
        action: 'GROUP_PATHS_RECONCILED',
        performerId: this.user!.id,
        performerName: this.user!.username,
        groupId: opts.groupId,
        details: {
          platform: opts.platform,
          oldExternalGroupId: opts.oldExternalGroupId,
          newExternalGroupId: opts.newExternalGroupId,
          ...(opts.auditExtra ?? {}),
          ...(reconciliation ?? {}),
        },
      },
    });

    return reconciliation;
  }

  // PUT /api/admin/groups/:groupId — edit presentational fields + archive/restore.
  async updateGroup(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const groupId = String(req.params.groupId);
      const existing = await this.authorizeGroupManagement(groupId);

      const validated = this.validateWithZod(updateGroupSchema, this.req.body);
      if (!validated.success) {return;}
      const data = validated.data;

      // externalGroupId is editable ONLY for adapters that can reconcile existing
      // members onto the new mapping (ZooKeeper's multi-path list). For a single-group
      // platform (Redash/AWS) it stays immutable — swapping it would orphan members.
      const adapter = provisioningRegistry.tryGet(existing.platform);
      const externalGroupIdChanged =
        data.externalGroupId !== undefined &&
        data.externalGroupId !== existing.externalGroupId;
      if (externalGroupIdChanged && !adapter?.reconcileMembers) {
        throw new ValidationError(
          `The external group mapping is immutable for the "${existing.platform}" platform.`,
        );
      }
      // Validate the new id against the platform's format before persisting, so a
      // malformed value can't be saved (and then break reconciliation + every provision).
      if (externalGroupIdChanged && data.externalGroupId) {
        adapter?.validateExternalGroupId?.(data.externalGroupId);
      }
      // openEnrollment only makes sense for secrets-family groups (see createGroup for why) —
      // reject turning it on for any other platform's group.
      if (data.openEnrollment && !isSecretsFamilyPlatform(existing.platform)) {
        throw new ValidationError(
          'Open enrollment is only supported for Secret Ingestion groups.',
        );
      }

      let group;
      try {
        group = await prisma.group.update({
          where: { id: groupId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined
              ? { description: data.description }
              : {}),
            ...(data.icon !== undefined ? { icon: data.icon } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.tables !== undefined ? { tables: data.tables } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            ...(data.openEnrollment !== undefined
              ? { openEnrollment: data.openEnrollment }
              : {}),
            ...(externalGroupIdChanged
              ? { externalGroupId: data.externalGroupId }
              : {}),
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
          details: {
            slug: group.slug,
            platform: group.platform,
            changed: Object.keys(data),
          },
        },
      });

      // If the external mapping changed, reconcile existing LEVEL-LESS members onto it
      // (members holding a level are bound to that level's own externalGroupId, not the
      // group's) + record GROUP_PATHS_RECONCILED — both via the shared helper.
      let reconciliation: ReconcileMembersResult | null = null;
      if (externalGroupIdChanged) {
        reconciliation = await this.reconcileExternalGroupChange({
          groupId,
          platform: group.platform,
          memberWhere: { groupId, levelId: null },
          oldExternalGroupId: existing.externalGroupId,
          newExternalGroupId: group.externalGroupId,
        });
      }

      this.sendResponse(
        { ...group, reconciliation },
        'Group updated successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to update group');
    }
  }

  // DELETE /api/admin/groups/:groupId
  // Hard-deletes a group only when it's pristine — never referenced by any access
  // request, user access (those FKs are ON DELETE Restrict, so even a historical
  // row blocks the delete), or secret ingestion request (ON DELETE SetNull, so it's
  // checked explicitly below instead). Levels and group-admins ON DELETE Cascade
  // away. Anything with history archives instead (isActive:false): it leaves the
  // request flow (getGroups filters isActive) while existing members keep access
  // until expiry/revoke.
  async deleteGroup(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const groupId = String(req.params.groupId);
      const group = await this.authorizeGroupManagement(groupId);
      const force =
        req.query.force === 'true' ||
        (req.body as { force?: boolean })?.force === true;

      // Force delete: permanently remove the group AND its historical access/request
      // rows, even when it has history — but ONLY when nobody currently holds active
      // access, so we never strand a live platform grant with no Hermes record. Audit
      // entries survive (groupId there is a plain column, not an FK). GroupLevel and
      // GroupAdmin are removed by the group's onDelete: Cascade.
      if (force) {
        // Run active count check inside the transaction to prevent races where a user access row
        // is created between checking the count and performing the deletes.
        await prisma.$transaction(async tx => {
          const activeCount = await tx.userAccess.count({
            where: { groupId, isActive: true },
          });
          if (activeCount > 0) {
            throw new ConflictError(
              `Group has ${activeCount} active member(s). Revoke their access (or wait for it to expire) before deleting permanently.`,
            );
          }
          const inFlightIngestionCount = await tx.secretIngestionRequest.count({
            where: { groupId, status: { in: ['PENDING', 'APPLYING'] } },
          });
          if (inFlightIngestionCount > 0) {
            throw new ConflictError(
              `Group has ${inFlightIngestionCount} in-progress secret ingestion request(s). Resolve them (approve/reject) before deleting permanently.`,
            );
          }
          // Order matters: clear rows that FK-reference the group/levels (Restrict)
          // before deleting the group, which then cascades its levels and admins.
          // secretIngestionRequest's FK is SetNull, not Restrict, so it wouldn't
          // block group.delete on its own — clear it explicitly so a "permanently
          // remove...historical rows" force-delete doesn't leave orphaned rows.
          await tx.userAccess.deleteMany({ where: { groupId } });
          await tx.accessRequest.deleteMany({ where: { groupId } });
          await tx.secretIngestionRequest.deleteMany({ where: { groupId } });
          await tx.group.delete({ where: { id: groupId } });
        });

        // Best-effort removal of the backing platform group — no active member is
        // affected. Don't fail the delete on a cleanup error.
        if (group.externalGroupId) {
          const adapter = provisioningRegistry.tryGet(group.platform);
          if (adapter?.deleteExternalGroup) {
            try {
              await adapter.deleteExternalGroup(group.externalGroupId);
            } catch (cleanupErr: any) {
              logger.warn(
                {
                  externalGroupId: group.externalGroupId,
                  error: cleanupErr.message,
                },
                'Group force-deleted but failed to remove its backing platform group',
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
            details: {
              name: group.name,
              slug: group.slug,
              platform: group.platform,
              externalGroupId: group.externalGroupId,
              forced: true,
            },
          },
        });
        this.sendResponse(
          { id: groupId, deleted: true },
          'Group permanently deleted, including its history.',
        );
        return;
      }

      let [requestCount, accessCount, ingestionCount] = await Promise.all([
        prisma.accessRequest.count({ where: { groupId } }),
        prisma.userAccess.count({ where: { groupId } }),
        prisma.secretIngestionRequest.count({ where: { groupId } }),
      ]);

      // The counts can go stale between the check and the delete (a request
      // created in that window hits the FK Restrict as P2003) — treat that the
      // same as "has history" and fall through to the archive path below.
      // Note: secretIngestionRequest's FK is SetNull rather than Restrict, so a
      // request created in that exact same race window would NOT raise P2003 —
      // the ingestionCount check above closes the common case (existing history
      // blocks the delete) but can't fully close that narrow race.
      let raced = false;
      if (requestCount === 0 && accessCount === 0 && ingestionCount === 0) {
        try {
          await prisma.group.delete({ where: { id: groupId } });
        } catch (err: any) {
          if (err?.code !== 'P2003') {throw err;}
          raced = true;
          [requestCount, accessCount, ingestionCount] = await Promise.all([
            prisma.accessRequest.count({ where: { groupId } }),
            prisma.userAccess.count({ where: { groupId } }),
            prisma.secretIngestionRequest.count({ where: { groupId } }),
          ]);
          logger.info(
            { groupId, requestCount, accessCount, ingestionCount },
            'Group delete raced with a new reference — archiving instead',
          );
        }
      }

      if (requestCount === 0 && accessCount === 0 && ingestionCount === 0 && !raced) {
        // Best-effort removal of the backing platform group — no one is affected
        // (the group had no members or requests). Don't fail the delete on cleanup error.
        if (group.externalGroupId) {
          const adapter = provisioningRegistry.tryGet(group.platform);
          if (adapter?.deleteExternalGroup) {
            try {
              await adapter.deleteExternalGroup(group.externalGroupId);
            } catch (cleanupErr: any) {
              logger.warn(
                {
                  externalGroupId: group.externalGroupId,
                  error: cleanupErr.message,
                },
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
            details: {
              name: group.name,
              slug: group.slug,
              platform: group.platform,
              externalGroupId: group.externalGroupId,
            },
          },
        });
        this.sendResponse({ id: groupId, deleted: true }, 'Group deleted');
        return;
      }

      // Has history → archive instead of delete.
      const archived = await prisma.group.update({
        where: { id: groupId },
        data: { isActive: false },
      });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_ARCHIVED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: {
            name: archived.name,
            slug: archived.slug,
            platform: archived.platform,
            requestCount,
            accessCount,
          },
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
  async listGroupAdmins(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const groupWhere: { platform?: string | { in: string[] }; id?: string } =
        {};
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

      const groups = await prisma.group.findMany({
        where: groupWhere,
        select: { id: true },
      });
      const groupIds = groups.map(g => g.id);

      const rows = await prisma.groupAdmin.findMany({
        where: { groupId: { in: groupIds } },
        include: {
          group: {
            select: { name: true, slug: true, platform: true, color: true },
          },
        },
        orderBy: { userName: 'asc' },
      });

      this.sendResponse(rows, 'Group admins retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group admins');
    }
  }

  // POST /api/admin/group-admins  { userId, groupId }
  async assignGroupAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

      // Coarse precheck before the group lookup so a non-admin can't probe group
      // existence via the 404-vs-403 difference. The fine-grained check is below.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You cannot manage this group\'s admins');
      }

      const validated = this.validateWithZod(
        assignGroupAdminSchema,
        this.req.body,
      );
      if (!validated.success) {return;}

      const { userId, groupId } = validated.data;
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {throw new NotFoundError('Group not found');}

      // Super admin or platform admin of this group's platform. (Assigning a user
      // who also holds super_admin is allowed and harmless — no extra guard.)
      if (!(await isPlatformAdminOf(this.user!, group.platform))) {
        throw new AuthorizationError(
          'You cannot manage admins for this group\'s platform',
        );
      }

      // Reject groups whose platform has no registered provisioner (mirrors the
      // check in assignPlatformAdmin) — otherwise we'd mint an admin we can't
      // provision for, and the auto-enroll below would silently fail.
      if (!provisioningRegistry.has(group.platform)) {
        throw new ValidationError(
          `Unknown platform "${group.platform}" — no provisioner is registered for it.`,
        );
      }

      const profile = await this.resolveUserProfile(userId);
      const role = groupAdminRole(group.platform, group.slug);

      await keycloakAdminService.ensureCompositeRole(
        role,
        GROUP_ADMIN_MARKER,
        `Hermes group admin for ${group.platform}/${group.slug}`,
      );
      await keycloakAdminService.assignRealmRole(userId, role);

      const row = await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId, userId } },
        update: {
          userName: profile.userName,
          userEmail: profile.userEmail,
          assignedBy: this.user!.username,
        },
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
  async removeGroupAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

      // Coarse precheck before the row lookup (avoids a 404-vs-403 existence oracle).
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You cannot manage group admins');
      }

      const id = String(req.params.id);
      const row = await prisma.groupAdmin.findUnique({
        where: { id },
        include: { group: true },
      });
      if (!row) {throw new NotFoundError('Group admin assignment not found');}

      if (!(await isPlatformAdminOf(this.user!, row.group.platform))) {
        throw new AuthorizationError(
          'You cannot manage admins for this group\'s platform',
        );
      }

      await keycloakAdminService.removeRealmRole(
        row.userId,
        groupAdminRole(row.group.platform, row.group.slug),
      );
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
          details: {
            slug: row.group.slug,
            platform: row.group.platform,
            role: groupAdminRole(row.group.platform, row.group.slug),
          },
        },
      });

      // Membership is intentionally retained — removing admin rights does not
      // revoke their group access (revoke manually if needed).
      this.sendResponse(
        { id },
        'Group admin removed (group membership retained)',
      );
    } catch (error) {
      this.handleError(error, 'Failed to remove group admin');
    }
  }

  // ── Members ──────────────────────────────────────────────────────────────

  // GET /api/admin/groups/:groupId/members
  async listGroupMembers(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence
      // oracle); same message as the fine-grained check so they're indistinguishable.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const groupId = String(req.params.groupId);
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {throw new NotFoundError('Group not found');}

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
        prisma.groupAdmin.findMany({
          where: { groupId },
          select: { userId: true },
        }),
      ]);
      const adminUserIds = new Set(admins.map(a => a.userId));

      this.sendResponse(
        members.map(m => ({
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
  async addGroupMember(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence
      // oracle); same message as the fine-grained check so they're indistinguishable.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const groupId = String(req.params.groupId);
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {throw new NotFoundError('Group not found');}

      if (!(await isGroupAdminOf(this.user!, groupId, group.slug))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const validated = this.validateWithZod(
        addGroupMemberSchema,
        this.req.body,
      );
      if (!validated.success) {return;}

      const profile = await this.resolveUserProfile(validated.data.userId);
      const result = await accessWorkflowService.adminAddMember(
        { id: userId, username: this.user!.username },
        {
          id: validated.data.userId,
          name: profile.userName,
          email: profile.userEmail,
        },
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

  // POST /api/admin/groups/:groupId/onboard  { userId, levelId?, duration }
  // Recovery path for addGroupMember's account gate: when a group admin tries to
  // add a user who has no account yet on the group's platform, adminAddMember
  // throws USER_NOT_APPROVED. This endpoint is what the frontend calls next, after
  // showing that error inline — it is NOT a separate always-visible entry point.
  // Creates the platform account on the user's behalf (skipping the self-service
  // submit/approve cycle) and then runs the exact same adminAddMember the plain
  // add-member action uses. Gated at platform-admin tier (stricter than
  // addGroupMember's group-admin tier) since it mints a platform account, not just
  // a group grant.
  async onboardUserToGroup(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence
      // oracle); same message as the fine-grained check so they're indistinguishable.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not have permission to create accounts for this platform');
      }

      const groupId = String(req.params.groupId);
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {throw new NotFoundError('Group not found');}

      // Platform-admin tier, not group-admin — a group admin can add members but
      // cannot mint a new platform account on someone's behalf.
      if (!(await isPlatformAdminOf(this.user!, group.platform))) {
        throw new AuthorizationError(
          'Only a platform admin can create accounts for this platform',
        );
      }

      const validated = this.validateWithZod(
        addGroupMemberSchema,
        this.req.body,
      );
      if (!validated.success) {return;}

      const profile = await this.resolveUserProfile(validated.data.userId);
      const performer = { id: userId, username: this.user!.username };
      const target = {
        id: validated.data.userId,
        username: profile.userName,
        email: profile.userEmail,
      };

      const account = await userCreationService.adminCreateForPlatform(
        performer,
        target,
        group.platform,
      );

      const membership = await accessWorkflowService.adminAddMember(
        performer,
        { id: target.id, name: target.username, email: target.email },
        groupId,
        validated.data.levelId ?? null,
        validated.data.duration,
      );

      this.sendResponse(
        { account, membership },
        membership.kind === 'provisioned'
          ? `Account created and ${profile.userName} was added to the group`
          : `Account created — ${profile.userName} will be added to the group automatically once their platform setup completes`,
        201,
      );
    } catch (error) {
      this.handleError(error, 'Failed to create account and add member');
    }
  }

  // DELETE /api/admin/groups/:groupId/members/:userAccessId
  async removeGroupMember(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence
      // oracle); same message as the fine-grained check so they're indistinguishable.
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const groupId = String(req.params.groupId);
      const userAccessId = String(req.params.userAccessId);

      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {throw new NotFoundError('Group not found');}

      if (!(await isGroupAdminOf(this.user!, groupId, group.slug))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const access = await prisma.userAccess.findUnique({
        where: { id: userAccessId },
      });
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

  // ── User access (cross-platform view + bulk revoke) ───────────────────────
  // Lets an admin audit or revoke everything a single user holds — across every
  // group/platform they administer — from one place, instead of hunting through
  // each group's member list. Scope is the same as everywhere else in this
  // controller: super admins see/revoke every platform, a platform admin only
  // their own platform(s). There is no group-admin entry point here (they'd only
  // ever see a slice of one user's access, which isn't the point of this tool).

  // GET /api/admin/user-access?userId=
  async listUserAccess(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const userId = String(req.query.userId ?? '').trim();
      if (!userId) {throw new ValidationError('userId is required');}

      const where: {
        userId: string;
        isActive: boolean;
        group?: { platform: { in: string[] } };
      } = { userId, isActive: true };
      if (!isSuperAdmin(this.user!)) {
        where.group = { platform: { in: manageable } };
      }

      const accesses = await prisma.userAccess.findMany({
        where,
        include: {
          group: {
            select: { id: true, name: true, slug: true, platform: true, color: true, icon: true },
          },
          level: { select: { id: true, name: true, permission: true } },
        },
        orderBy: { grantedAt: 'desc' },
      });

      this.sendResponse(
        accesses.map(a => ({
          id: a.id,
          groupId: a.groupId,
          groupName: a.group.name,
          groupSlug: a.group.slug,
          groupColor: a.group.color,
          groupIcon: a.group.icon,
          platform: a.group.platform,
          levelId: a.levelId,
          levelName: a.level?.name ?? null,
          levelPermission: a.level?.permission ?? null,
          externalUserId: a.externalUserId,
          grantedAt: a.grantedAt,
          expiresAt: a.expiresAt,
          grantedBy: a.grantedBy,
        })),
        'User access retrieved successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve user access');
    }
  }

  // POST /api/admin/user-access/revoke  { userId, userAccessIds?, reason? }
  // userAccessIds omitted ⇒ revoke every active grant the caller can see for this
  // user (still scoped by platform for a platform admin); provided ⇒ revoke just
  // that subset. Grants outside the caller's manageable platforms, or belonging to
  // a different user, are silently excluded rather than trusted from the client.
  async revokeUserAccess(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const performerId = this.getUserId();
      if (!performerId) {return;}

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const validated = this.validateWithZod(
        revokeUserAccessSchema,
        this.req.body,
      );
      if (!validated.success) {return;}
      const { userId, userAccessIds, reason } = validated.data;

      const where: {
        userId: string;
        isActive: boolean;
        group?: { platform: { in: string[] } };
        id?: { in: string[] };
      } = { userId, isActive: true };
      if (!isSuperAdmin(this.user!)) {
        where.group = { platform: { in: manageable } };
      }
      // A provided array (even empty) is an explicit subset — an empty selection must
      // match nothing, NOT fall through to "revoke everything". Only an OMITTED
      // (undefined) userAccessIds means "revoke every grant the caller can see".
      if (Array.isArray(userAccessIds)) {
        where.id = { in: userAccessIds };
      }

      const targets = await prisma.userAccess.findMany({
        where,
        select: { id: true, userName: true, group: { select: { name: true } } },
      });

      if (targets.length === 0) {
        throw new NotFoundError(
          'No matching active access found to revoke',
        );
      }

      const revoker = { id: performerId, username: this.user!.username };
      const revoked: string[] = [];
      const failed: { id: string; groupName: string; error: string }[] = [];

      // Sequential, not Promise.allSettled: revokeAccess's ZooKeeper "retain other
      // paths" logic (deprovisionWithRetain) reads the user's still-active grants
      // at call time, so revoking this user's grants concurrently would race that
      // snapshot and could strip a path that a later-completing revoke still needed.
      for (const target of targets) {
        try {
          await accessWorkflowService.revokeAccess(target.id, revoker, reason);
          revoked.push(target.id);
        } catch (err: any) {
          logger.error(
            { userAccessId: target.id, error: err.message },
            'Bulk user-access revoke: failed to revoke one grant',
          );
          failed.push({
            id: target.id,
            groupName: target.group.name,
            error: err.message || 'Unknown error',
          });
        }
      }

      await prisma.auditEntry.create({
        data: {
          action: 'ACCESS_BULK_REVOKED',
          performerId,
          performerName: this.user!.username,
          targetUserId: userId,
          targetUserName: targets[0]?.userName,
          details: {
            reason,
            requested: targets.length,
            revokedCount: revoked.length,
            failedCount: failed.length,
            userAccessIds: targets.map(t => t.id),
          },
        },
      });

      this.sendResponse(
        { revoked, failed },
        `${revoked.length} access grant(s) revoked${failed.length ? `, ${failed.length} failed` : ''}`,
      );
    } catch (error) {
      this.handleError(error, 'Failed to revoke user access');
    }
  }

  // GET /api/admin/user-platform-accounts?userId= — every platform account this
  // user holds (in scope), for the offboarding section of the "User access" tool.
  async listUserPlatformAccounts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const userId = String(req.query.userId ?? '').trim();
      if (!userId) {throw new ValidationError('userId is required');}

      const requests = await prisma.userCreationRequest.findMany({
        where: {
          userId,
          ...(isSuperAdmin(this.user!) ? {} : { platform: { in: manageable } }),
          status: { in: ACCOUNT_HOLDING_STATUSES },
        },
        orderBy: { platform: 'asc' },
      });

      // Best-effort "already disabled" flag from the cache (Redash's own is_disabled,
      // refreshed by sync). An AWS row here always reads false — a disabled AWS
      // account has no cache row at all (deleteUser removes it), so it wouldn't
      // reach ACCOUNT_HOLDING_STATUSES in the first place after the next sync prunes it.
      const withExternalId = requests.filter(r => r.externalUserId);
      const disabledSet = new Set<string>();
      if (withExternalId.length > 0) {
        const cacheRows = await prisma.platformExternalUser.findMany({
          where: { OR: withExternalId.map(r => ({ platform: r.platform, externalId: r.externalUserId! })) },
          select: { platform: true, externalId: true, isDisabled: true },
        });
        for (const c of cacheRows) {
          if (c.isDisabled) {disabledSet.add(`${c.platform}:${c.externalId}`);}
        }
      }

      // How many active UserAccess grants this user still holds per platform —
      // surfaced so the UI can warn before disabling ("also revokes N grants" for
      // an irreversible delete, "N grant(s) will remain untouched" for a reversible
      // disable). Disabling/deleting the ACCOUNT never implicitly touches these.
      const grantCounts = new Map<string, number>();
      if (requests.length > 0) {
        const grants = await prisma.userAccess.findMany({
          where: {
            userId,
            isActive: true,
            group: { platform: { in: requests.map(r => r.platform) } },
          },
          select: { group: { select: { platform: true } } },
        });
        for (const g of grants) {
          grantCounts.set(g.group.platform, (grantCounts.get(g.group.platform) ?? 0) + 1);
        }
      }

      this.sendResponse(
        requests.map(r => {
          const adapter = provisioningRegistry.tryGet(r.platform);
          return {
            platform: r.platform,
            status: r.status,
            externalUserId: r.externalUserId,
            supportsDisable: !!adapter?.disableUser,
            disableIsReversible: !!adapter?.disableUserIsReversible,
            isDisabled: r.externalUserId ? disabledSet.has(`${r.platform}:${r.externalUserId}`) : false,
            activeGrantCount: grantCounts.get(r.platform) ?? 0,
          };
        }),
        'User platform accounts retrieved successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve user platform accounts');
    }
  }

  // POST /api/admin/user-access/disable-accounts  { userId, platforms?, reason? }
  // Offboarding: disable/delete a user's ACCOUNT on some/all platforms that support
  // it (not group membership — that's revokeUserAccess). platforms omitted =
  // every eligible account the caller can see for this user; provided = that
  // subset. Semantics differ per adapter (see disableUserIsReversible) — the
  // caller is trusted to have already shown the admin which is which.
  async disableUserAccounts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const performerId = this.getUserId();
      if (!performerId) {return;}

      const manageable = await getManageablePlatforms(this.user!);
      if (manageable.length === 0) {
        throw new AuthorizationError('You do not administer any platforms');
      }

      const validated = this.validateWithZod(
        disableUserAccountsSchema,
        this.req.body,
      );
      if (!validated.success) {return;}
      const { userId, platforms, reason } = validated.data;

      const profile = await this.resolveUserProfile(userId);

      // Single effective platform filter. Two rules combined so neither is lost to
      // an object-spread key collision:
      //  - Scope: a non-super admin is always confined to their manageable platforms.
      //  - Selection: a provided `platforms` array (even empty) is an explicit subset;
      //    an empty selection must match nothing, and a requested platform outside the
      //    caller's scope is dropped (never trusted from the client). Omitted = every
      //    account the caller can see.
      const scope = isSuperAdmin(this.user!) ? null : manageable;
      let platformFilter: { in: string[] } | undefined;
      if (Array.isArray(platforms)) {
        platformFilter = { in: scope ? platforms.filter((p) => scope.includes(p)) : platforms };
      } else if (scope) {
        platformFilter = { in: scope };
      }

      const requests = await prisma.userCreationRequest.findMany({
        where: {
          userId,
          ...(platformFilter ? { platform: platformFilter } : {}),
          status: { in: ACCOUNT_HOLDING_STATUSES },
          externalUserId: { not: null },
        },
      });

      if (requests.length === 0) {
        throw new NotFoundError(
          'No matching platform account found to disable',
        );
      }

      const revoker = { id: performerId, username: this.user!.username };
      const disabled: { platform: string; reversible: boolean; grantsRevoked: string[] }[] = [];
      const failed: { platform: string; error: string }[] = [];
      const unsupported: string[] = [];

      for (const row of requests) {
        const adapter = provisioningRegistry.tryGet(row.platform);
        if (!adapter?.disableUser) {
          unsupported.push(row.platform);
          continue;
        }
        const reversible = !!adapter.disableUserIsReversible;
        try {
          await adapter.disableUser(row.externalUserId!);

          // A PERMANENTLY deleted account (AWS) can never again validly back an
          // active UserAccess grant — the external id it points to no longer
          // exists. Leaving the grant active would (a) keep showing this person
          // as a current member everywhere, and (b) block re-onboarding them
          // later via the "you already have active access" guard in
          // access-workflow.service.ts, since that check only looks at
          // isActive, not whether the platform account behind it still exists.
          // So an irreversible disable auto-revokes; a reversible one (Redash)
          // deliberately does NOT — group membership survives a re-enable there,
          // so forcing a revoke would just be extra, unrequested destruction.
          const grantsRevoked: string[] = [];
          if (!reversible) {
            const grants = await prisma.userAccess.findMany({
              where: { userId, isActive: true, group: { platform: row.platform } },
              select: { id: true },
            });
            for (const g of grants) {
              try {
                await accessWorkflowService.revokeAccess(
                  g.id,
                  revoker,
                  reason ?? `Account permanently deleted on ${row.platform}`,
                );
                grantsRevoked.push(g.id);
              } catch (err: any) {
                logger.error(
                  { userAccessId: g.id, platform: row.platform, error: err.message },
                  'Offboard: failed to auto-revoke a grant after its platform account was permanently deleted',
                );
              }
            }
          }

          disabled.push({ platform: row.platform, reversible, grantsRevoked });

          // Best-effort audit: the account is already disabled/deleted (and any
          // grants revoked) by this point, so an audit-write failure must NOT flip a
          // completed — and for AWS, irreversible — offboard into a reported "failed"
          // that invites a confusing (no-op-able) retry. Log it and move on.
          try {
            await prisma.auditEntry.create({
              data: {
                action: 'PLATFORM_ACCOUNT_DISABLED',
                performerId,
                performerName: this.user!.username,
                targetUserId: userId,
                targetUserName: profile.userName,
                details: {
                  platform: row.platform,
                  externalUserId: row.externalUserId,
                  reversible,
                  reason,
                  grantsRevoked,
                },
              },
            });
          } catch (auditErr: any) {
            logger.error(
              { platform: row.platform, userId, error: auditErr.message },
              'Offboard: platform account was disabled but writing its PLATFORM_ACCOUNT_DISABLED audit failed',
            );
          }
        } catch (err: any) {
          logger.error(
            { platform: row.platform, userId, error: err.message },
            'Failed to disable one platform account during offboarding',
          );
          failed.push({ platform: row.platform, error: err.message || 'Unknown error' });
        }
      }

      const totalGrantsRevoked = disabled.reduce((n, d) => n + d.grantsRevoked.length, 0);

      await prisma.auditEntry.create({
        data: {
          action: 'ACCOUNTS_BULK_DISABLED',
          performerId,
          performerName: this.user!.username,
          targetUserId: userId,
          targetUserName: profile.userName,
          details: {
            reason,
            requested: requests.length,
            disabledCount: disabled.length,
            failedCount: failed.length,
            autoRevokedGrantCount: totalGrantsRevoked,
            disabled,
            failed,
            unsupported,
          },
        },
      });

      this.sendResponse(
        { disabled, failed, unsupported },
        `${disabled.length} account(s) disabled${totalGrantsRevoked ? ` (auto-revoked ${totalGrantsRevoked} grant(s) on permanently-deleted accounts)` : ''}${failed.length ? `, ${failed.length} failed` : ''}${unsupported.length ? `, ${unsupported.length} unsupported` : ''}`,
      );
    } catch (error) {
      this.handleError(error, 'Failed to disable platform accounts');
    }
  }

  // PUT /api/admin/groups/:groupId/members/:userAccessId/level  { levelId }
  // Admin override: set the level a member holds. Same authorization as the other
  // member actions (group admin of this group, or platform/super above it). The
  // swap (and platform re-provisioning) happens in the workflow service.
  async setGroupMemberLevel(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      // Coarse precheck before the group lookup (avoids a 404-vs-403 existence oracle).
      if (!(await isAnyAdmin(this.user!))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const groupId = String(req.params.groupId);
      const userAccessId = String(req.params.userAccessId);

      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {throw new NotFoundError('Group not found');}

      if (!(await isGroupAdminOf(this.user!, groupId, group.slug))) {
        throw new AuthorizationError('You do not administer this group');
      }

      const validated = this.validateWithZod(
        setMemberLevelSchema,
        this.req.body,
      );
      if (!validated.success) {return;}

      const access = await prisma.userAccess.findUnique({
        where: { id: userAccessId },
      });
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
      throw new AuthorizationError('You cannot manage this group\'s levels');
    }
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) {throw new NotFoundError('Group not found');}
    if (!(await isPlatformAdminOf(this.user!, group.platform))) {
      throw new AuthorizationError(
        'You cannot manage levels for this group\'s platform',
      );
    }
    return group;
  }

  // GET /api/admin/groups/:groupId/levels — all levels (incl. inactive) + member counts.
  async listGroupLevels(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
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
        levels.map(l => ({
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
  async createGroupLevel(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const groupId = String(req.params.groupId);
      const group = await this.authorizeLevelManagement(groupId);

      const validated = this.validateWithZod(
        createGroupLevelSchema,
        this.req.body,
      );
      if (!validated.success) {return;}
      const data = validated.data;

      // Resolve the backing platform group:
      //  - if the admin pasted an externalGroupId, use it as-is (link an existing group);
      //  - otherwise, if the platform adapter can create groups, provision one
      //    automatically (named "<Group> — <Level>") and use its id. The admin
      //    then sets that group's data-source permissions on the platform itself.
      let externalGroupId = data.externalGroupId ?? null;
      let autoCreatedExternalGroupId: string | null = null;
      const adapter = provisioningRegistry.tryGet(group.platform);
      // Reject a malformed pasted id (e.g. a bad ZooKeeper path) before persisting.
      if (data.externalGroupId)
        {adapter?.validateExternalGroupId?.(data.externalGroupId);}
      if (!externalGroupId && adapter?.createExternalGroup) {
        const created = await adapter.createExternalGroup(
          `${group.name} — ${data.name}`,
        );
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
              {
                externalGroupId: autoCreatedExternalGroupId,
                error: cleanupErr.message,
              },
              'Failed to roll back auto-created platform group after level insert failure',
            );
          }
        }
        if (err?.code === 'P2002') {
          throw new ConflictError(
            'A level with this slug already exists in this group.',
          );
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
  async updateGroupLevel(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const groupId = String(req.params.groupId);
      const levelId = String(req.params.levelId);
      const group = await this.authorizeLevelManagement(groupId);

      const existing = await prisma.groupLevel.findUnique({
        where: { id: levelId },
      });
      if (!existing || existing.groupId !== groupId) {
        throw new NotFoundError('Level not found in this group');
      }

      const validated = this.validateWithZod(
        updateGroupLevelSchema,
        this.req.body,
      );
      if (!validated.success) {return;}
      const data = validated.data;

      // Validate a changed externalGroupId against the platform's format BEFORE persisting,
      // so a malformed paste can't be saved and then break reconciliation + every future
      // provision of this level.
      const adapter = provisioningRegistry.tryGet(group.platform);
      const externalGroupIdChangedForGuard =
        data.externalGroupId !== undefined &&
        data.externalGroupId !== existing.externalGroupId;
      if (externalGroupIdChangedForGuard && !adapter?.reconcileMembers) {
        throw new ValidationError(
          `The external group mapping is immutable for the "${group.platform}" platform.`,
        );
      }

      if (
        data.externalGroupId !== undefined &&
        data.externalGroupId !== existing.externalGroupId
      ) {
        if (data.externalGroupId)
          {adapter?.validateExternalGroupId?.(data.externalGroupId);}
      }

      let level;
      try {
        level = await prisma.groupLevel.update({
          where: { id: levelId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.slug !== undefined ? { slug: data.slug } : {}),
            ...(data.description !== undefined
              ? { description: data.description }
              : {}),
            ...(data.permission !== undefined
              ? { permission: data.permission }
              : {}),
            ...(data.externalGroupId !== undefined
              ? { externalGroupId: data.externalGroupId }
              : {}),
            ...(data.rank !== undefined ? { rank: data.rank } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new ConflictError(
            'A level with this slug already exists in this group.',
          );
        }
        throw err;
      }

      const externalGroupIdChanged =
        data.externalGroupId !== undefined &&
        data.externalGroupId !== existing.externalGroupId;

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
            externalGroupIdChanged,
          },
        },
      });

      // Reconcile this level's existing members onto the new mapping (ZooKeeper's
      // multi-path list) + record GROUP_PATHS_RECONCILED via the shared helper. Adapters
      // without the hook (Redash/AWS) leave members in place, matching the existing
      // "editing a level doesn't migrate members" rule.
      let reconciliation: ReconcileMembersResult | null = null;
      if (externalGroupIdChanged) {
        reconciliation = await this.reconcileExternalGroupChange({
          groupId,
          platform: group.platform,
          memberWhere: { groupId, levelId },
          oldExternalGroupId: existing.externalGroupId,
          newExternalGroupId: level.externalGroupId,
          auditExtra: { levelId: level.id },
        });
      }

      this.sendResponse(
        { ...level, reconciliation },
        'Level updated successfully',
      );
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
  async deleteGroupLevel(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!this.getUserId()) {return;}
      const groupId = String(req.params.groupId);
      const levelId = String(req.params.levelId);
      const group = await this.authorizeLevelManagement(groupId);

      const existing = await prisma.groupLevel.findUnique({
        where: { id: levelId },
        include: {
          _count: {
            select: {
              userAccesses: { where: { isActive: true } },
              accessRequests: {
                where: { status: { notIn: TERMINAL_REQUEST_STATUSES } },
              },
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
                {
                  externalGroupId: existing.externalGroupId,
                  error: cleanupErr.message,
                },
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
            details: {
              levelId,
              slug: existing.slug,
              name: existing.name,
              platform: group.platform,
              externalGroupId: existing.externalGroupId,
            },
          },
        });
        this.sendResponse({ id: levelId, deleted: true }, 'Level deleted');
        return;
      }

      // Otherwise deactivate — something live is still attached (active members or an
      // in-flight request). Members keep access until expiry/revoke; no new requests
      // can select it (createRequest only offers active levels).
      await prisma.groupLevel.update({
        where: { id: levelId },
        data: { isActive: false },
      });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_LEVEL_DEACTIVATED',
          performerId: this.user!.id,
          performerName: this.user!.username,
          groupId,
          details: {
            levelId,
            slug: existing.slug,
            name: existing.name,
            platform: group.platform,
            activeMembers,
            openRequests,
          },
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
