process.env.SECRETS_INGESTION_SIMULATION = 'true';

import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import { secretsProvisioner } from './secrets.provisioner';
import { secretsManagerService } from './secrets-manager.service';
import { ValidationError } from '../utils/errors';

describe('SecretsProvisioner (simulation)', () => {
  const SECRET_NAMES = ['payment/gateway', 'payment/webhook'];
  const EXTERNAL_GROUP_ID = SECRET_NAMES.join('\n');

  beforeEach(() => {
    secretsManagerService.__resetSim();
  });

  async function invite(email: string, name = 'Test User'): Promise<string> {
    const res = await secretsProvisioner.inviteUser(email, name);
    return res.externalUserId;
  }

  it('seeds the cache with stable identity and completes immediately', async () => {
    const email = 'alice@bachatt.app';
    const res = await secretsProvisioner.inviteUser(email, 'Alice');

    expect(res.metadata?.inviteLink).toBeUndefined();
    expect(res.externalUserId).toBe(email);

    const row = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'secrets', email } },
    });
    expect(row?.externalId).toBe(res.externalUserId);
    expect(row?.isPending).toBe(false);
  });

  it('checkUserStatus reflects the cache', async () => {
    expect(await secretsProvisioner.checkUserStatus('bob@bachatt.app')).toMatchObject({ exists: false });
    const aclId = await invite('bob@bachatt.app');
    expect(await secretsProvisioner.checkUserStatus('bob@bachatt.app')).toMatchObject({
      exists: true,
      externalUserId: aclId,
    });
  });

  it('provision adds the user to the cache', async () => {
    const aclId = await invite('carol@bachatt.app');
    const result = await secretsProvisioner.provision({
      email: 'carol@bachatt.app',
      name: 'Carol',
      externalGroupId: EXTERNAL_GROUP_ID,
    });
    expect(result.externalUserId).toBe(aclId);

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'secrets', email: 'carol@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual(SECRET_NAMES);
  });

  it('refuses to provision a user who has no secrets credential yet', async () => {
    await expect(
      secretsProvisioner.provision({
        email: 'nobody@bachatt.app',
        name: 'Nobody',
        externalGroupId: EXTERNAL_GROUP_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deprovision removes user group membership from cache', async () => {
    await invite('dave@bachatt.app');
    await secretsProvisioner.provision({
      email: 'dave@bachatt.app',
      name: 'Dave',
      externalGroupId: EXTERNAL_GROUP_ID,
    });

    await secretsProvisioner.deprovision({
      email: 'dave@bachatt.app',
      name: 'Dave',
      externalUserId: 'dave@bachatt.app',
      externalGroupId: EXTERNAL_GROUP_ID,
    });

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'secrets', email: 'dave@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([]);
  });

  it('cacheRemoveGroup only recomputes from active grants on the secrets platform, not other platforms sharing the same externalUserId', async () => {
    const email = 'erin@bachatt.app';
    await invite(email, 'Erin');
    await secretsProvisioner.provision({
      email,
      name: 'Erin',
      externalGroupId: EXTERNAL_GROUP_ID,
    });

    // A grant on a DIFFERENT platform whose provisioner also keys real-email users by
    // their email (e.g. ZooKeeper) — same externalUserId value, unrelated platform.
    const zkGroup = await prisma.group.create({
      data: {
        name: 'Unrelated ZK Group',
        slug: 'secrets-crosscheck-zk-group',
        description: '',
        platform: 'zookeeper',
        externalGroupId: '/hermes/unrelated#r',
        tables: [],
      },
    });
    await prisma.userAccess.create({
      data: {
        userId: 'zk-user-1',
        userName: 'Erin',
        userEmail: email,
        groupId: zkGroup.id,
        isActive: true,
        externalUserId: email,
        grantedBy: 'test',
      },
    });

    await secretsProvisioner.deprovision({
      email,
      name: 'Erin',
      externalUserId: email,
      externalGroupId: EXTERNAL_GROUP_ID,
    });

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'secrets', email } },
    });
    // No active `secrets`-platform grant remains, so the cache must be empty — NOT
    // repopulated with the unrelated ZooKeeper path just because it shares the externalUserId.
    expect(cached?.externalGroupIds).toEqual([]);
  });

  it('validateExternalGroupId validates secret names', () => {
    expect(() => secretsProvisioner.validateExternalGroupId('valid/secret\nanother-valid')).not.toThrow();
    expect(() => secretsProvisioner.validateExternalGroupId('')).toThrow(ValidationError);
    expect(() => secretsProvisioner.validateExternalGroupId(' ')).toThrow(ValidationError);
  });

  it('reconcileMembers returns diff metrics', async () => {
    const res = await secretsProvisioner.reconcileMembers({
      groupId: 'g-1',
      groupSlug: 'secrets-group',
      groupName: 'Secrets Group',
      oldExternalGroupId: EXTERNAL_GROUP_ID,
      newExternalGroupId: 'payment/gateway\npayment/webhook\npayment/third',
      members: [],
    });
    expect(res).toEqual({
      addedPaths: ['payment/third'],
      removedPaths: [],
      updatedPaths: [],
      memberCount: 0,
      errors: [],
    });
  });
});
