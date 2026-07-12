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
import {
  SecretsManagerService,
  getSecretsManagerService,
} from './secrets-manager.service';
import prisma from '../config/prisma';
import config from '../config/config';
import logger from '../utils/logger';
import { ValidationError } from '../utils/errors';
import * as templates from '../utils/email-templates';

/**
 * Secret Ingestion implementation of {@link PlatformAdapter}.
 *
 * One instance is constructed per configured Secret Ingestion account (prod + QA share the
 * `secrets` instance; `secrets-sandbox` is a second AWS account) — see
 * {@link createSecretsProvisioner} and provisioning.registry.ts. `platform` is that instance's
 * unique registry key; every cache row and DB lookup is tagged with it, and the injected
 * {@link SecretsManagerService} points at that instance's AWS account, so prod and sandbox never
 * share state. Both instances carry `family: 'secrets'` so the UI collapses them into one
 * Secret Ingestion surface with a prod/sandbox chooser.
 */
export class SecretsProvisioner implements PlatformAdapter {
  readonly platform: string;
  readonly displayName: string;
  readonly family: string;
  readonly label?: string;
  private readonly service: SecretsManagerService;

  constructor(opts: {
    platform: string;
    displayName: string;
    family: string;
    label?: string;
    service: SecretsManagerService;
  }) {
    this.platform = opts.platform;
    this.displayName = opts.displayName;
    this.family = opts.family;
    this.label = opts.label;
    this.service = opts.service;
  }

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
        where: { platform_externalId: { platform: this.platform, externalId: ctx.externalUserId } },
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
          platform: this.platform,
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
      where: { platform_email: { platform: this.platform, email: rowEmail } },
      update: {
        externalId: aclId,
        name,
        isDisabled: false,
        isPending: false,
        lastSyncedAt: now,
      },
      create: {
        platform: this.platform,
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
    this.service.parseSecretNames(externalGroupId);
  }

  /**
   * Delete backing group — no-op/log only (do NOT delete real secrets from AWS).
   */
  async deleteExternalGroup(externalGroupId: string): Promise<void> {
    logger.info(
      { externalGroupId, platform: this.platform },
      'deleteExternalGroup called for a secrets platform (no-op to prevent deletion of real AWS secrets)',
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
      ? this.service.parseSecretNames(ctx.oldExternalGroupId)
      : [];
    const newSecrets = ctx.newExternalGroupId
      ? this.service.parseSecretNames(ctx.newExternalGroupId)
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
    return this.service.healthCheck();
  }

  /** Whether the adapter is running against the in-process mock store. */
  isSimulation(): boolean {
    return this.service.getIsSimulation();
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
        where: { userId_platform: { userId, platform: this.platform } },
      });
      if (account?.externalUserId) {return account.externalUserId;}
    }
    const cached = await prisma.platformExternalUser.findUnique({
      where: {
        platform_email: { platform: this.platform, email: email.toLowerCase() },
      },
    });
    if (!cached) {
      throw new ValidationError(
        `No ${this.displayName} identity exists for ${email}. The user's account must be created (approved) before access can be provisioned.`,
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
    for (const pattern of this.service.parseScopePatterns(externalGroupId)) {
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
      WHERE platform = ${this.platform} AND external_id = ${aclId}
        AND NOT (${secretName} = ANY(external_group_ids))
    `;
  }

  private async cacheRemoveGroup(aclId: string, _path: string): Promise<void> {
    const grants = await prisma.userAccess.findMany({
      where: { externalUserId: aclId, isActive: true, group: { platform: this.platform } },
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
      where: { platform_externalId: { platform: this.platform, externalId: aclId } },
      data: {
        externalGroupIds: [...activeSecrets],
        lastSyncedAt: new Date(),
      },
    });
  }
}

/**
 * Build a {@link SecretsProvisioner} for one registered Secret Ingestion instance.
 * Resolves the instance's own {@link SecretsManagerService} (own AWS account/credentials).
 */
export function createSecretsProvisioner(instance: {
  key: string;
  family: string;
  label: string;
  displayName: string;
}): SecretsProvisioner {
  return new SecretsProvisioner({
    platform: instance.key,
    displayName: instance.displayName,
    family: instance.family,
    label: instance.label,
    service: getSecretsManagerService(instance.key),
  });
}

// Back-compat default export: the prod instance ("secrets"), sourced from config.secretsInstances.
// Existing callers (tests, admin maintenance) keep working unchanged.
const prodInstance =
  config.secretsInstances.find((i) => i.key === 'secrets') ?? config.secretsInstances[0];
export const secretsProvisioner = createSecretsProvisioner({
  key: prodInstance.key,
  family: prodInstance.family,
  label: prodInstance.label,
  displayName: prodInstance.displayName,
});
export default secretsProvisioner;
