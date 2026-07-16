import prisma from '../config/prisma';
import provisioningRegistry from './provisioning.registry';
import keycloakAdminService from './keycloak-admin.service';
import logger from '../utils/logger';

export interface ReconcileCounts {
  /** Mirror rows added (a Keycloak role mapping had no mirror row). */
  added: number;
  /** Mirror rows removed (a mirror row had no matching Keycloak role mapping). */
  removed: number;
  /** Number of roles compared. */
  checked: number;
}

const zero = (): ReconcileCounts => ({ added: 0, removed: 0, checked: 0 });

const platformAdminRole = (platform: string) =>
  `hermes_platform_admin_${platform.toLowerCase()}`;
const groupAdminRole = (platform: string, slug: string) =>
  `hermes_group_admin_${platform.toLowerCase()}_${slug.toLowerCase()}`;

/**
 * Brings the DB admin mirrors (platform_admins / group_admins) back in line with
 * Keycloak — the source of truth for roles. Repairs drift left by a partial
 * failure (a Keycloak write that landed but whose mirror write didn't, or vice
 * versa) or by a role edited directly in Keycloak.
 *
 * Safety properties:
 *  - **Keycloak → DB only.** Never writes to Keycloak.
 *  - **Skipped entirely when Keycloak isn't live** (simulation / missing creds),
 *    so it can never wipe seeded local mirror rows.
 *  - **Deletes only after a successful Keycloak read.** getUsersInRole only
 *    returns [] on a real 404 (role absent); any transient API error throws and
 *    is caught per-role, so a network blip skips that role rather than emptying
 *    its mirror.
 */
export class AdminReconciliationService {
  /**
   * @param opts.dryRun  when true, only report the drift counts — no DB writes.
   *                     Useful to inspect what reconciliation would change before
   *                     letting it (or the scheduler) actually repair.
   */
  async reconcileAll(
    opts: { dryRun?: boolean } = {},
  ): Promise<{
    dryRun: boolean;
    platformAdmins: ReconcileCounts;
    groupAdmins: ReconcileCounts;
  }> {
    const dryRun = !!opts.dryRun;

    if (!keycloakAdminService.isLive) {
      logger.debug('🔁 Admin reconciliation skipped — Keycloak not live.');
      return { dryRun, platformAdmins: zero(), groupAdmins: zero() };
    }

    // Bail out once on an outage rather than failing every per-role lookup (and
    // — critically — never delete a mirror row when we can't read Keycloak).
    if (!(await keycloakAdminService.canConnect())) {
      logger.warn(
        '🔁 Admin reconciliation skipped — Keycloak Admin API unreachable.',
      );
      return { dryRun, platformAdmins: zero(), groupAdmins: zero() };
    }

    const platformAdmins = await this.reconcilePlatformAdmins(dryRun);
    const groupAdmins = await this.reconcileGroupAdmins(dryRun);

    const drift =
      platformAdmins.added +
      platformAdmins.removed +
      groupAdmins.added +
      groupAdmins.removed;
    const tag = dryRun ? '[dry-run] ' : '';
    const line =
      `🔁 ${tag}Admin reconciliation: platform-admins +${platformAdmins.added}/-${platformAdmins.removed}, ` +
      `group-admins +${groupAdmins.added}/-${groupAdmins.removed}`;
    if (drift > 0) {
      logger.warn(line + (dryRun ? ' (drift detected)' : ' (drift repaired)'));
    } else {
      logger.info(line + ' (in sync)');
    }

    return { dryRun, platformAdmins, groupAdmins };
  }

  /** Name/email for a mirror row: prefer what Hermes has seen, fall back to Keycloak. */
  private async resolveProfile(
    userId: string,
  ): Promise<{ userName: string; userEmail: string }> {
    // One row per (user, platform) now; name/email match across them, so findFirst.
    const seen = await prisma.userCreationRequest.findFirst({
      where: { userId },
      select: { userName: true, userEmail: true },
    });
    if (seen) {
      return seen;
    }
    const kc = await keycloakAdminService.getUser(userId);
    return { userName: kc?.username || userId, userEmail: kc?.email || '' };
  }

  private async reconcilePlatformAdmins(
    dryRun: boolean,
  ): Promise<ReconcileCounts> {
    const counts = zero();
    const tag = dryRun ? '[dry-run] would' : '';

    const platforms = provisioningRegistry.listPlatforms().filter(platform => {
      const adapter = provisioningRegistry.tryGet(platform);
      if (adapter?.isEnabled && !adapter.isEnabled()) {
        logger.debug(
          `🔁 Reconcile: Skipping platform-admin reconciliation for ${platform} because it is disabled.`,
        );
        return false;
      }
      return true;
    });

    // Each platform's reconciliation touches only its own PlatformAdmin rows and
    // its own Keycloak role — independent work, run concurrently. allSettled keeps
    // one platform's failure from blocking the others' counts.
    const results = await Promise.allSettled(
      platforms.map(async (platform): Promise<ReconcileCounts> => {
        const kcIds = new Set(
          await keycloakAdminService.getUsersInRole(
            platformAdminRole(platform),
          ),
        );
        const mirror = await prisma.platformAdmin.findMany({
          where: { platform },
        });
        const mirrorIds = new Set(mirror.map(m => m.userId));
        const platformCounts = zero();
        platformCounts.checked += 1;

        for (const userId of kcIds) {
          if (mirrorIds.has(userId)) {
            continue;
          }
          if (!dryRun) {
            const p = await this.resolveProfile(userId);
            await prisma.platformAdmin.upsert({
              where: { userId_platform: { userId, platform } },
              update: { userName: p.userName, userEmail: p.userEmail },
              create: {
                userId,
                platform,
                userName: p.userName,
                userEmail: p.userEmail,
                assignedBy: 'reconcile',
              },
            });
          }
          platformCounts.added += 1;
          logger.warn(
            `🔁 Reconcile: ${tag} add missing platform_admin mirror (${userId} / ${platform}).`,
          );
        }

        for (const m of mirror) {
          if (kcIds.has(m.userId)) {
            continue;
          }
          if (!dryRun) {
            await prisma.platformAdmin.delete({ where: { id: m.id } });
          }
          platformCounts.removed += 1;
          logger.warn(
            `🔁 Reconcile: ${tag} remove stale platform_admin mirror (${m.userId} / ${platform}).`,
          );
        }

        return platformCounts;
      }),
    );

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        counts.checked += result.value.checked;
        counts.added += result.value.added;
        counts.removed += result.value.removed;
      } else {
        logger.error(
          `🔁 Reconcile: platform-admin reconcile failed for "${platforms[i]}": ${result.reason?.message ?? result.reason}`,
        );
      }
    });

    return counts;
  }

  private async reconcileGroupAdmins(
    dryRun: boolean,
  ): Promise<ReconcileCounts> {
    const counts = zero();
    const tag = dryRun ? '[dry-run] would' : '';
    const disabledPlatforms = provisioningRegistry
      .listPlatforms()
      .filter(key => {
        const adapter = provisioningRegistry.tryGet(key);
        return !!(adapter?.isEnabled && !adapter.isEnabled());
      });
    const groups = await prisma.group.findMany({
      where: {
        platform: { notIn: disabledPlatforms },
      },
      select: { id: true, slug: true, platform: true },
    });

    for (const g of groups) {
      try {
        const kcIds = new Set(
          await keycloakAdminService.getUsersInRole(
            groupAdminRole(g.platform, g.slug),
          ),
        );
        const mirror = await prisma.groupAdmin.findMany({
          where: { groupId: g.id },
        });
        const mirrorIds = new Set(mirror.map(m => m.userId));
        counts.checked += 1;

        for (const userId of kcIds) {
          if (mirrorIds.has(userId)) {
            continue;
          }
          if (!dryRun) {
            const p = await this.resolveProfile(userId);
            await prisma.groupAdmin.upsert({
              where: { groupId_userId: { groupId: g.id, userId } },
              update: { userName: p.userName, userEmail: p.userEmail },
              create: {
                groupId: g.id,
                userId,
                userName: p.userName,
                userEmail: p.userEmail,
                assignedBy: 'reconcile',
              },
            });
          }
          counts.added += 1;
          logger.warn(
            `🔁 Reconcile: ${tag} add missing group_admin mirror (${userId} / ${g.slug}).`,
          );
        }

        for (const m of mirror) {
          if (kcIds.has(m.userId)) {
            continue;
          }
          if (!dryRun) {
            await prisma.groupAdmin.delete({ where: { id: m.id } });
          }
          counts.removed += 1;
          logger.warn(
            `🔁 Reconcile: ${tag} remove stale group_admin mirror (${m.userId} / ${g.slug}).`,
          );
        }
      } catch (err: any) {
        logger.error(
          `🔁 Reconcile: group-admin reconcile failed for "${g.slug}": ${err.message}`,
        );
      }
    }

    return counts;
  }
}

export const adminReconciliationService = new AdminReconciliationService();
export default adminReconciliationService;
