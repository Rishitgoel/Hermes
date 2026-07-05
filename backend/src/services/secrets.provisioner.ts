import {
  PlatformAdapter,
  ProvisionContext,
  ProvisionResult,
  DeprovisionContext,
  PlatformUserStatus,
  OnboardingMessage,
  ReconcileMembersContext,
  ReconcileMembersResult,
} from './provisioner.interface';
import secretsManagerService from './secrets-manager.service';
import prisma from '../config/prisma';
import config from '../config/config';
import logger from '../utils/logger';
import { ValidationError } from '../utils/errors';
import * as templates from '../utils/email-templates';

const PLATFORM = 'secrets';

export class SecretsProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;
  readonly displayName = 'Secret Ingestion';

  // ── Provisioning lifecycle ────────────────────────────────────────────────────

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const aclId = await this.resolveAclId(ctx.email, ctx.userId);
    if (ctx.externalGroupId) {
      for (const secretName of this.extractExactSecretNames(ctx.externalGroupId)) {
        await this.cacheAddGroup(aclId, secretName);
      }
    }
    return { externalUserId: aclId };
  }

  async deprovision(ctx: DeprovisionContext): Promise<void> {
    // Prefer the caller's already-computed "what this user still holds elsewhere"
    // snapshot (userId-scoped, from access-workflow.service.ts's deprovisionWithRetain
    // / _swapGrant) over an equivalent externalUserId-scoped re-query — avoids a
    // redundant DB round trip on every revoke/expire, and a scoping mismatch if
    // externalUserId and userId were ever not strictly 1:1 for this platform.
    if (ctx.retainExternalGroupId !== undefined) {
      let names: string[];
      try {
        names = this.extractExactSecretNames(ctx.retainExternalGroupId);
      } catch {
        // Malformed retain string — fall back to a full recompute rather than
        // guessing at a possibly-wrong cache value.
        await this.cacheRemoveGroup(ctx.externalUserId, '');
        return;
      }
      await prisma.platformExternalUser.update({
        where: { platform_externalId: { platform: PLATFORM, externalId: ctx.externalUserId } },
        data: { externalGroupIds: names, lastSyncedAt: new Date() },
      });
      return;
    }
    await this.cacheRemoveGroup(ctx.externalUserId, '');
  }

  /** Look a user up — cache-only, since Secret Ingestion has no user directory. */
  async checkUserStatus(
    email: string,
    userId?: string,
  ): Promise<PlatformUserStatus> {
    const cached = await prisma.platformExternalUser.findUnique({
      where: {
        platform_email: {
          platform: PLATFORM,
          email: this.cacheRowEmail(email, userId),
        },
      },
    });
    return cached
      ? { exists: true, externalUserId: cached.externalId, email }
      : { exists: false, email };
  }

  /**
   * Seed the user's cache row. No credential is minted — AWS Secrets Manager is network-isolated
   * from the client and access is managed via Hermes with admin credentials.
   */
  async inviteUser(
    email: string,
    name: string,
    userId?: string,
  ): Promise<ProvisionResult> {
    const aclId = this.cacheRowEmail(email, userId);
    const rowEmail = aclId;
    const now = new Date();
    await prisma.platformExternalUser.upsert({
      where: { platform_email: { platform: PLATFORM, email: rowEmail } },
      update: {
        externalId: aclId,
        name,
        isDisabled: false,
        isPending: false,
        lastSyncedAt: now,
      },
      create: {
        platform: PLATFORM,
        externalId: aclId,
        email: rowEmail,
        name,
        isDisabled: false,
        isPending: false,
        externalGroupIds: [],
        lastSyncedAt: now,
      },
    });
    return { externalUserId: aclId };
  }

  // ── Group lifecycle ─────────────────────────────────────────────────────────────

  /** Create a backing group; returns the group name as the external group id placeholder. */
  async createExternalGroup(
    name: string,
  ): Promise<{ externalGroupId: string; name?: string }> {
    return { externalGroupId: name, name };
  }

  /**
   * Validate a candidate group id BEFORE it is persisted: it must parse to at least one secret name.
   */
  validateExternalGroupId(externalGroupId: string): void {
    secretsManagerService.parseSecretNames(externalGroupId);
  }

  /**
   * Delete backing group — no-op/log only (do NOT delete real secrets from AWS).
   */
  async deleteExternalGroup(externalGroupId: string): Promise<void> {
    logger.info(
      { externalGroupId },
      'deleteExternalGroup called for platform secrets (no-op to prevent deletion of real AWS secrets)',
    );
  }

  /**
   * Reconcile members by diffing old vs new secret-name lists and re-caching active grants.
   * Note: `addedPaths`/`removedPaths` are the raw scope lines, which may be wildcard/prefix
   * patterns ('*', 'foo*') rather than literal secret names — callers rendering these for an
   * admin should not assume every entry is a concrete AWS secret.
   */
  async reconcileMembers(
    ctx: ReconcileMembersContext,
  ): Promise<ReconcileMembersResult> {
    const oldSecrets = ctx.oldExternalGroupId
      ? secretsManagerService.parseSecretNames(ctx.oldExternalGroupId)
      : [];
    const newSecrets = ctx.newExternalGroupId
      ? secretsManagerService.parseSecretNames(ctx.newExternalGroupId)
      : [];
    const oldSet = new Set(oldSecrets);
    const newSet = new Set(newSecrets);

    const addedPaths = newSecrets.filter(s => !oldSet.has(s));
    const removedPaths = oldSecrets.filter(s => !newSet.has(s));

    const errors: { member: string; error: string }[] = [];
    if (addedPaths.length > 0 || removedPaths.length > 0) {
      try {
        await Promise.all(
          ctx.members.map(m => this.cacheRemoveGroup(m.externalUserId, '')),
        );
      } catch (err: any) {
        errors.push({
          member: 'all',
          error: `reconcile failed: ${err.message}`,
        });
      }
    }

    return {
      addedPaths,
      removedPaths,
      updatedPaths: [],
      memberCount: ctx.members.length,
      errors,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return secretsManagerService.healthCheck();
  }

  /** Whether the adapter is running against the in-process mock store. */
  isSimulation(): boolean {
    return config.secrets.isSimulation;
  }

  isReservedExternalGroup(_group: {
    externalId: string;
    name: string;
    type?: string | null;
  }): boolean {
    // No reserved AWS secret pattern (unlike AWS's API-TESTING or Redash's default/admin
    // groups) — every secret a group's grant list names is requestable.
    return false;
  }

  /** Secret Ingestion has no direct launch URL. */
  getLaunchUrl(): string | null {
    return null;
  }

  /**
   * Onboarding nudge once Secret Ingestion access is created.
   */
  getOnboardingMessage(): OnboardingMessage {
    return {
      notification: {
        title: 'Secret Ingestion access ready',
        message:
          'Your Secret Ingestion access is set up. Any approved secret access has been provisioned.',
        link: '/secrets',
      },
      email: templates.userSecretsAccountReady({}),
      dm: '🎉 Your Secret Ingestion access is set up — any approved access has been provisioned.',
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────────

  private async resolveAclId(email: string, userId?: string): Promise<string> {
    if (userId) {
      const account = await prisma.userCreationRequest.findUnique({
        where: { userId_platform: { userId, platform: PLATFORM } },
      });
      if (account?.externalUserId) {return account.externalUserId;}
    }
    const cached = await prisma.platformExternalUser.findUnique({
      where: {
        platform_email: { platform: PLATFORM, email: email.toLowerCase() },
      },
    });
    if (!cached) {
      throw new ValidationError(
        `No Secret Ingestion identity exists for ${email}. The user's Secret Ingestion account must be created (approved) before access can be provisioned.`,
      );
    }
    return cached.externalId;
  }

  private cacheRowEmail(email: string, userId?: string): string {
    const normalized = (email || '').trim().toLowerCase();
    if (normalized) {return normalized;}
    return userId ? `__secrets_uid:${userId}` : '';
  }

  /**
   * Concrete (non-wildcard) secret names from a group's externalGroupId. Wildcard/prefix
   * patterns ('*', 'foo*') are resolved live elsewhere and aren't real secret names, so
   * they're skipped — there's nothing meaningful to record for them in this per-user cache.
   */
  private extractExactSecretNames(externalGroupId: string): string[] {
    const names: string[] = [];
    for (const pattern of secretsManagerService.parseScopePatterns(externalGroupId)) {
      if (pattern.kind === 'exact') {
        names.push(pattern.name);
      }
    }
    return names;
  }

  private async cacheAddGroup(aclId: string, secretName: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE platform_external_users
      SET external_group_ids = array_append(external_group_ids, ${secretName}),
          last_synced_at = NOW()
      WHERE platform = ${PLATFORM} AND external_id = ${aclId}
        AND NOT (${secretName} = ANY(external_group_ids))
    `;
  }

  private async cacheRemoveGroup(aclId: string, _path: string): Promise<void> {
    const grants = await prisma.userAccess.findMany({
      where: { externalUserId: aclId, isActive: true, group: { platform: PLATFORM } },
      include: { group: true, level: true },
    });
    const activeSecrets = new Set<string>();
    for (const g of grants) {
      const externalGroupId =
        g.level?.externalGroupId ?? g.group.externalGroupId;
      if (!externalGroupId) {continue;}
      try {
        for (const name of this.extractExactSecretNames(externalGroupId)) {
          activeSecrets.add(name);
        }
      } catch {
        // ignore malformed config
      }
    }
    await prisma.platformExternalUser.update({
      where: { platform_externalId: { platform: PLATFORM, externalId: aclId } },
      data: {
        externalGroupIds: [...activeSecrets],
        lastSyncedAt: new Date(),
      },
    });
  }
}

export const secretsProvisioner = new SecretsProvisioner();
export default secretsProvisioner;
