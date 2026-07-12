// Enable BOTH Secret Ingestion instances in simulation so the sandbox ("secrets-sandbox") is a
// live, isolated second AWS account for these tests. Must be set before config is imported.
process.env.SECRETS_INGESTION_SIMULATION = 'true';
process.env.SECRETS_SANDBOX_SIMULATION = 'true';

import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import {
  secretIngestionService,
  secretsFamilyPlatforms,
} from './secret-ingestion.service';
import { getSecretsManagerService } from './secrets-manager.service';
import { createSecretsProvisioner } from './secrets.provisioner';
import { isInfraRepoEnabled } from './infra-repo-sync.service';

const PROD = 'secrets';
const SANDBOX = 'secrets-sandbox';

describe('Secret Ingestion — multi-instance (prod + sandbox)', () => {
  const USER = { id: 'usr-mi-1', username: 'Mia', email: 'mia@bachatt.app' };
  const REVIEWER = { id: 'admin-mi-1', username: 'Boss' };

  beforeEach(() => {
    getSecretsManagerService(PROD).__resetSim();
    getSecretsManagerService(SANDBOX).__resetSim();
  });

  it('registers both instances in the secrets family', () => {
    expect(secretsFamilyPlatforms()).toEqual(expect.arrayContaining([PROD, SANDBOX]));
  });

  async function grant(platform: string, externalGroupId: string, slug: string) {
    const provisioner = createSecretsProvisioner(
      platform === SANDBOX
        ? { key: SANDBOX, family: 'secrets', label: 'Sandbox', displayName: 'Secret Ingestion (Sandbox)' }
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

  it('has the infra-deployment flow wired per-instance: prod on, sandbox off until its repo is configured', () => {
    expect(isInfraRepoEnabled(PROD)).toBe(true);
    // Sandbox is off by default (no SECRETS_SANDBOX_INFRA_REPO_NAME / _ENABLED set).
    expect(isInfraRepoEnabled(SANDBOX)).toBe(false);

    const prev = process.env.SECRETS_SANDBOX_INFRA_REPO_NAME;
    try {
      process.env.SECRETS_SANDBOX_INFRA_REPO_NAME = 'infra-deployment-sandbox';
      expect(isInfraRepoEnabled(SANDBOX)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SECRETS_SANDBOX_INFRA_REPO_NAME;
      else process.env.SECRETS_SANDBOX_INFRA_REPO_NAME = prev;
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
