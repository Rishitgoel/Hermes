// Enable BOTH Secret Ingestion instances in simulation so the sandbox ("secrets-sandbox") is a
// live, isolated second AWS account for these tests. Must be set before config is imported.
process.env.SECRETS_INGESTION_SIMULATION = 'true';
process.env.SECRETS_SANDBOX_SIMULATION = 'true';
// The Azure instance is a different PROVIDER (Key Vault), not just a third account — enabled here
// so the isolation checks cover all three.
process.env.SECRETS_AZURE_SIMULATION = 'true';
process.env.SECRETS_AZURE_VAULT_NAME = 'bachatt-prod-kv';

import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import {
  secretIngestionService,
  secretsFamilyPlatforms,
} from './secret-ingestion.service';
import {
  getSecretsManagerService,
  __resetSecretsManagerServiceCacheForTest,
} from './secrets-manager.service';
import { createSecretsProvisioner } from './secrets.provisioner';
import { isInfraRepoEnabled } from './infra-repo-sync.service';
import config from '../config/config';

const PROD = 'secrets';
const SANDBOX = 'secrets-sandbox';
const AZURE = 'secrets-azure';
const VAULT = 'bachatt-prod-kv';

describe('Secret Ingestion — multi-instance (prod + sandbox)', () => {
  const USER = { id: 'usr-mi-1', username: 'Mia', email: 'mia@bachatt.app' };
  const REVIEWER = { id: 'admin-mi-1', username: 'Boss' };

  beforeEach(() => {
    // A module elsewhere (provisioningRegistry, secretsProvisioner — both construct singletons
    // at IMPORT time) can call getSecretsManagerService for every configured instance before
    // this file's own env overrides above take effect, permanently caching a wrong config for
    // 'secrets-azure'. Clear the cache first so every getSecretsManagerService call below is
    // guaranteed to re-read config fresh, with this file's overrides now in effect.
    __resetSecretsManagerServiceCacheForTest();
    getSecretsManagerService(PROD).__resetSim();
    getSecretsManagerService(SANDBOX).__resetSim();
    getSecretsManagerService(AZURE).__resetSim();
  });

  it('registers all three instances in the secrets family', () => {
    expect(secretsFamilyPlatforms()).toEqual(
      expect.arrayContaining([PROD, SANDBOX, AZURE]),
    );
  });

  async function grant(platform: string, externalGroupId: string, slug: string) {
    const provisioner = createSecretsProvisioner(
      platform === SANDBOX
        ? { key: SANDBOX, family: 'secrets', label: 'Sandbox', displayName: 'Secret Ingestion (Sandbox)' }
        : platform === AZURE
          ? { key: AZURE, family: 'secrets', label: 'Azure', displayName: 'Secret Ingestion (Azure)', provider: 'azure' }
          : { key: PROD, family: 'secrets', label: 'Prod + QA', displayName: 'Secret Ingestion' },
    );
    const { externalUserId } = await provisioner.inviteUser(USER.email, USER.username, USER.id);
    await prisma.userCreationRequest.create({
      data: {
        userId: USER.id,
        userName: USER.username,
        userEmail: USER.email,
        platform,
        status: 'COMPLETED',
        externalUserId,
      },
    });
    const group = await prisma.group.create({
      data: {
        name: `Group ${slug}`,
        slug,
        description: '',
        platform,
        externalGroupId,
        tables: [],
      },
    });
    await prisma.userAccess.create({
      data: {
        userId: USER.id,
        userName: USER.username,
        userEmail: USER.email,
        groupId: group.id,
        isActive: true,
        externalUserId,
        grantedBy: 'test',
      },
    });
    return group;
  }

  it('resolves each instance to its own account: a sandbox wildcard grant sees sandbox secrets, not prod', async () => {
    await grant(SANDBOX, '*', 'mi-sandbox-all');

    const sandboxScope = await secretIngestionService.getUserScope(USER.id, SANDBOX);
    const sandboxSecrets = sandboxScope.flatMap((s) => s.secretNames);
    // Sandbox sim account exposes sandbox/* secrets, and NOT the prod payment/* seed.
    expect(sandboxSecrets).toEqual(expect.arrayContaining(['sandbox/database', 'sandbox/redis']));
    expect(sandboxSecrets).not.toContain('payment/gateway');

    // With no prod grant, the prod instance sees nothing for this user.
    const prodScope = await secretIngestionService.getUserScope(USER.id, PROD);
    expect(prodScope).toHaveLength(0);
  });

  it('applies an approved sandbox request to the sandbox account only (prod untouched)', async () => {
    await grant(SANDBOX, '*', 'mi-sandbox-write');

    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: 'sandbox/new-secret',
      entries: [{ key: 'SBX_KEY', value: 'sbx-value' }],
      platform: SANDBOX,
    });
    expect(request.platform).toBe(SANDBOX);

    const reviewed = await secretIngestionService.reviewIngestionRequest(
      request.id,
      { id: REVIEWER.id, username: REVIEWER.username },
      [{ key: 'SBX_KEY', decision: 'APPROVED' }],
    );
    expect(reviewed.status).toBe('APPLIED');

    // Written to the sandbox account…
    const sandboxMap = await getSecretsManagerService(SANDBOX).getSecretMap('sandbox/new-secret');
    expect(sandboxMap?.SBX_KEY).toBe('sbx-value');
    // …and NOT to the prod account.
    const prodMap = await getSecretsManagerService(PROD).getSecretMap('sandbox/new-secret');
    expect(prodMap).toBeNull();
  });

  it('keeps the Azure vault isolated from the AWS accounts', async () => {
    await grant(AZURE, VAULT, 'mi-azure-vault');

    // The Azure instance exposes exactly one "secret" — the vault itself.
    const azureScope = await secretIngestionService.getUserScope(USER.id, AZURE);
    expect(azureScope.flatMap((s) => s.secretNames)).toEqual([VAULT]);

    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: VAULT,
      // On Azure the "key" is a Key Vault secret name and envVar is what the pod reads.
      entries: [{ key: 'orbit-new-thing', value: 'kv-value', envVar: 'CUSTOM_NAME' }],
      platform: AZURE,
    });
    expect(request.platform).toBe(AZURE);
    // envVar must survive the create path — it is rebuilt field-by-field there.
    expect((request.entries as any[])[0].envVar).toBe('CUSTOM_NAME');

    const reviewed = await secretIngestionService.reviewIngestionRequest(
      request.id,
      { id: REVIEWER.id, username: REVIEWER.username },
      [{ key: 'orbit-new-thing', decision: 'APPROVED' }],
    );
    expect(reviewed.status).toBe('APPLIED');

    // Written to the vault…
    const azureMap = await getSecretsManagerService(AZURE).getSecretMap(VAULT);
    expect(azureMap?.['orbit-new-thing']).toBe('kv-value');
    // …and to neither AWS account.
    expect(await getSecretsManagerService(PROD).getSecretMap(VAULT)).toBeNull();
    expect(await getSecretsManagerService(SANDBOX).getSecretMap(VAULT)).toBeNull();
  });

  it('scopes the Azure instance to the azure/ folder of the shared infra repo (one-directional)', () => {
    // Both instances mirror to the SAME repo. Azure is scoped to azure/ only; prod is
    // deliberately NOT excluded from it (a real AWS-shaped manifest, findesk-be, is misfiled
    // under azure/ in the live repo and would otherwise be invisible to prod) — accepted
    // consequence: prod's tree scan can now also reach azure/orbit, azure/saathi-be, azure/tolgee.
    // Routing for those files still depends on manifestFlavor/path detection doing the right
    // thing at write time (see infra-repo-sync.service.ts), not on prod being denied the path.
    expect(isInfraRepoEnabled(AZURE)).toBe(true);
    const azureCfg = config.secretsInstances.find((i) => i.key === AZURE)!;
    const prodCfg = config.secretsInstances.find((i) => i.key === PROD)!;
    expect(azureCfg.infraRepo.repo).toBe(prodCfg.infraRepo.repo);
    expect((azureCfg.infraRepo as any).pathInclude).toBe('azure/');
    expect((prodCfg.infraRepo as any).pathExclude).toBeUndefined();
  });

  it('has the infra-deployment flow wired per-instance: prod on, sandbox off until its repo is configured', () => {
    expect(isInfraRepoEnabled(PROD)).toBe(true);

    const prevEnabled = process.env.SECRETS_SANDBOX_INFRA_REPO_ENABLED;
    const prevName = process.env.SECRETS_SANDBOX_INFRA_REPO_NAME;
    delete process.env.SECRETS_SANDBOX_INFRA_REPO_ENABLED;
    delete process.env.SECRETS_SANDBOX_INFRA_REPO_NAME;

    try {
      // Sandbox is off by default (no SECRETS_SANDBOX_INFRA_REPO_NAME / _ENABLED set).
      expect(isInfraRepoEnabled(SANDBOX)).toBe(false);

      process.env.SECRETS_SANDBOX_INFRA_REPO_NAME = 'infra-deployment-sandbox';
      expect(isInfraRepoEnabled(SANDBOX)).toBe(true);
    } finally {
      if (prevEnabled !== undefined) process.env.SECRETS_SANDBOX_INFRA_REPO_ENABLED = prevEnabled;
      else delete process.env.SECRETS_SANDBOX_INFRA_REPO_ENABLED;

      if (prevName !== undefined) process.env.SECRETS_SANDBOX_INFRA_REPO_NAME = prevName;
      else delete process.env.SECRETS_SANDBOX_INFRA_REPO_NAME;
    }
  });

  it('skips infra-deployment targets for the sandbox while its repo is unconfigured', async () => {
    await grant(SANDBOX, '*', 'mi-sandbox-infra');
    const preview = await secretIngestionService.previewInfraTargets(
      USER.id,
      'sandbox/database',
      ['SOME_KEY'],
      SANDBOX,
    );
    expect(preview.targets).toEqual([]);
  });
});
