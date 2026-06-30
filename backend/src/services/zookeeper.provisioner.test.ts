import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../config/prisma';
import config from '../config/config';
import { zookeeperProvisioner } from './zookeeper.provisioner';
import { zookeeperService } from './zookeeper.service';
import { ValidationError } from '../utils/errors';

/**
 * Unit/integration tests for the ZooKeeper adapter in simulation mode.
 * Assertions verify cache rows in platform_external_users and znode existence in the sim store.
 */
describe('ZookeeperProvisioner (simulation)', () => {
  const GROUP_PATH = '/hermes/credit-card';

  let rootPathSpy: any;

  beforeEach(() => {
    zookeeperService.__resetSim();
    rootPathSpy = vi.spyOn(config.zookeeper, 'rootPath', 'get').mockReturnValue('/hermes');
  });

  afterEach(() => {
    rootPathSpy?.mockRestore();
  });

  /** Invite a user and return their minted ACL id. */
  async function invite(email: string, name = 'Test User'): Promise<string> {
    const res = await zookeeperProvisioner.inviteUser(email, name);
    return res.externalUserId;
  }

  it('seeds the cache with a stable identity and completes immediately (no credential, no setup link)', async () => {
    const email = 'alice@bachatt.app';
    const res = await zookeeperProvisioner.inviteUser(email, 'Alice');

    // No inviteLink => the user-creation flow treats the account as ready now.
    expect(res.metadata?.inviteLink).toBeUndefined();
    // externalUserId is the stable identity key (the lowercased email), not a credential.
    expect(res.externalUserId).toBe(email);
    // No credential is minted in the world-open model.
    expect(res.metadata?.zkUsername).toBeUndefined();
    expect(res.metadata?.zkPassword).toBeUndefined();

    const row = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email } },
    });
    expect(row?.externalId).toBe(res.externalUserId);
    expect(row?.isPending).toBe(false);
  });

  it('checkUserStatus reflects the cache (absent then present)', async () => {
    expect(await zookeeperProvisioner.checkUserStatus('bob@bachatt.app')).toMatchObject({ exists: false });
    const aclId = await invite('bob@bachatt.app');
    expect(await zookeeperProvisioner.checkUserStatus('bob@bachatt.app')).toMatchObject({
      exists: true,
      externalUserId: aclId,
    });
  });

  it('provision adds the user to the cache', async () => {
    const aclId = await invite('carol@bachatt.app');
    const result = await zookeeperProvisioner.provision({
      email: 'carol@bachatt.app',
      name: 'Carol',
      externalGroupId: `${GROUP_PATH}#r`,
    });
    expect(result.externalUserId).toBe(aclId);

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'carol@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([GROUP_PATH]);
  });

  it('refuses to provision a user who has no ZooKeeper credential yet', async () => {
    await expect(
      zookeeperProvisioner.provision({ email: 'nobody@bachatt.app', name: 'Nobody', externalGroupId: `${GROUP_PATH}#r` }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('resolves the credential by userId when the request email drifts from the account email', async () => {
    const accountEmail = 'frank@bachatt.app';
    const aclId = await invite(accountEmail, 'Frank');
    await prisma.userCreationRequest.create({
      data: {
        userId: 'usr-frank',
        userName: 'Frank',
        userEmail: accountEmail,
        platform: 'zookeeper',
        status: 'COMPLETED',
        externalUserId: aclId,
      },
    });

    for (const reqEmail of ['frank-other@bachatt.app', '']) {
      const res = await zookeeperProvisioner.provision({
        email: reqEmail,
        name: 'Frank',
        userId: 'usr-frank',
        externalGroupId: `${GROUP_PATH}#r`,
      });
      expect(res.externalUserId).toBe(aclId);
    }

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: accountEmail } },
    });
    expect(cached?.externalGroupIds).toEqual([GROUP_PATH]);
  });

  it('deprovision removes the entry from the cache and is idempotent', async () => {
    const aclId = await invite('erin@bachatt.app');
    await zookeeperProvisioner.provision({ email: 'erin@bachatt.app', name: 'Erin', externalGroupId: `${GROUP_PATH}#cdrw` });

    let cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'erin@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([GROUP_PATH]);

    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${GROUP_PATH}#cdrw` });
    cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'erin@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([]);

    await expect(
      zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${GROUP_PATH}#cdrw` }),
    ).resolves.toBeUndefined();
  });

  it('provision updates cache with every path in a multi-line group id; deprovision removes them all', async () => {
    const P1 = '/hermes/multi-a';
    const P2 = '/hermes/multi-b';
    const aclId = await invite('judy@bachatt.app');

    await zookeeperProvisioner.provision({
      email: 'judy@bachatt.app',
      name: 'Judy',
      externalGroupId: `${P1}#r\n${P2}#cdrw`,
    });

    let cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'judy@bachatt.app' } },
    });
    expect(cached?.externalGroupIds.sort()).toEqual([P1, P2].sort());

    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${P1}#r\n${P2}#cdrw` });
    cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'judy@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([]);
  });

  it('reconcileMembers updates cache for existing members', async () => {
    const PATH_A = '/hermes/credit-card';
    const PATH_B = '/hermes/shared';
    const PATH_C = '/hermes/audit';
    const aclId = await invite('ivy@bachatt.app');

    await zookeeperProvisioner.provision({
      email: 'ivy@bachatt.app',
      name: 'Ivy',
      externalGroupId: `${PATH_A}#r\n${PATH_B}#r`,
    });

    // Setup active UserAccess row matching the new state (PATH_A and PATH_C)
    const group = await prisma.group.create({
      data: {
        name: 'Test Group',
        slug: 'test-group',
        description: '',
        platform: 'zookeeper',
        externalGroupId: `${PATH_A}#cdrw\n${PATH_C}#r`,
        tables: [],
      },
    });
    await prisma.userAccess.create({
      data: {
        userId: 'usr-ivy',
        userName: 'Ivy',
        userEmail: 'ivy@bachatt.app',
        groupId: group.id,
        isActive: true,
        externalUserId: aclId,
        grantedBy: 'test',
      },
    });

    const result = await zookeeperProvisioner.reconcileMembers({
      oldExternalGroupId: `${PATH_A}#r\n${PATH_B}#r`,
      newExternalGroupId: `${PATH_A}#cdrw\n${PATH_C}#r`,
      members: [{ email: 'ivy@bachatt.app', name: 'Ivy', externalUserId: aclId }],
    });

    expect(result.addedPaths).toEqual([PATH_C]);
    expect(result.removedPaths).toEqual([PATH_B]);
    expect(result.updatedPaths).toEqual([PATH_A]);
    expect(result.memberCount).toBe(1);
    expect(result.errors).toHaveLength(0);

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'ivy@bachatt.app' } },
    });
    expect(cached?.externalGroupIds.sort()).toEqual([PATH_A, PATH_C].sort());
  });

  it('deprovision keeps paths the new mapping still grants — shared paths survive a level swap', async () => {
    const SHARED = '/hermes/shared';
    const OLD_ONLY = '/hermes/old-only';
    const NEW_ONLY = '/hermes/new-only';
    const aclId = await invite('mallory@bachatt.app');

    await zookeeperProvisioner.provision({
      email: 'mallory@bachatt.app',
      name: 'Mallory',
      externalGroupId: `${SHARED}#r\n${OLD_ONLY}#r`,
    });

    // Setup active UserAccess row for the new level
    const group = await prisma.group.create({
      data: {
        name: 'New Level Group',
        slug: 'new-level-gp',
        description: '',
        platform: 'zookeeper',
        externalGroupId: `${SHARED}#cdrw\n${NEW_ONLY}#r`,
        tables: [],
      },
    });
    await prisma.userAccess.create({
      data: {
        userId: 'usr-mallory',
        userName: 'Mallory',
        userEmail: 'mallory@bachatt.app',
        groupId: group.id,
        isActive: true,
        externalUserId: aclId,
        grantedBy: 'test',
      },
    });

    await zookeeperProvisioner.deprovision({
      externalUserId: aclId,
      externalGroupId: `${SHARED}#r\n${OLD_ONLY}#r`,
      retainExternalGroupId: `${SHARED}#cdrw\n${NEW_ONLY}#r`,
    });

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'mallory@bachatt.app' } },
    });
    expect(cached?.externalGroupIds.sort()).toEqual([SHARED, NEW_ONLY].sort());
  });

  it('reconcileMembers keeps a removed path the member still holds via another grant', async () => {
    const SHARED = '/hermes/shared';
    const OTHER = '/hermes/other';
    const aclId = await invite('reese@bachatt.app');

    // Group A (SHARED)
    const gA = await prisma.group.create({
      data: { name: 'Group A', slug: 'group-a', description: '', platform: 'zookeeper', externalGroupId: `${SHARED}#r`, tables: [] },
    });
    // Group B (now only OTHER)
    const gB = await prisma.group.create({
      data: { name: 'Group B', slug: 'group-b', description: '', platform: 'zookeeper', externalGroupId: `${OTHER}#r`, tables: [] },
    });

    await prisma.userAccess.create({
      data: { userId: 'usr-reese', userName: 'Reese', userEmail: 'reese@bachatt.app', groupId: gA.id, isActive: true, externalUserId: aclId, grantedBy: 'test' },
    });
    await prisma.userAccess.create({
      data: { userId: 'usr-reese', userName: 'Reese', userEmail: 'reese@bachatt.app', groupId: gB.id, isActive: true, externalUserId: aclId, grantedBy: 'test' },
    });

    await zookeeperProvisioner.provision({
      email: 'reese@bachatt.app',
      name: 'Reese',
      externalGroupId: `${SHARED}#r\n${OTHER}#r`,
    });

    const result = await zookeeperProvisioner.reconcileMembers({
      oldExternalGroupId: `${SHARED}#r\n${OTHER}#r`,
      newExternalGroupId: `${OTHER}#r`,
      members: [
        { email: 'reese@bachatt.app', name: 'Reese', externalUserId: aclId, retainExternalGroupIds: [`${SHARED}#r`] },
      ],
    });

    expect(result.removedPaths).toEqual([SHARED]);
    expect(result.errors).toHaveLength(0);

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'reese@bachatt.app' } },
    });
    expect(cached?.externalGroupIds.sort()).toEqual([SHARED, OTHER].sort());
  });

  it('reconcileMembers is a no-op when the path set is unchanged', async () => {
    const aclId = await invite('ken@bachatt.app');
    await zookeeperProvisioner.provision({ email: 'ken@bachatt.app', name: 'Ken', externalGroupId: `${GROUP_PATH}#r` });

    const result = await zookeeperProvisioner.reconcileMembers({
      oldExternalGroupId: `${GROUP_PATH}#r`,
      newExternalGroupId: `${GROUP_PATH}#r`,
      members: [{ email: 'ken@bachatt.app', name: 'Ken', externalUserId: aclId }],
    });

    expect(result).toMatchObject({ addedPaths: [], removedPaths: [], updatedPaths: [], errors: [] });

    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'ken@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([GROUP_PATH]);
  });

  it('createExternalGroup returns default /#cdrw group ID and does not create znodes', async () => {
    const { externalGroupId } = await zookeeperProvisioner.createExternalGroup('Risk Ops');
    expect(externalGroupId).toBe('/#cdrw');
    expect(await zookeeperService.exists('/hermes/risk-ops')).toBe(false);

    await zookeeperProvisioner.deleteExternalGroup(externalGroupId);
  });

  it('reports simulation and reserves the ZooKeeper system subtree', () => {
    expect(zookeeperProvisioner.isSimulation()).toBe(config.zookeeper.isSimulation);
    if (zookeeperProvisioner.isSimulation()) {
      expect(zookeeperProvisioner.getLaunchUrl()).toBeNull();
    }
    expect(zookeeperProvisioner.isReservedExternalGroup({ externalId: '/zookeeper', name: 'zookeeper' })).toBe(true);
    expect(zookeeperProvisioner.isReservedExternalGroup({ externalId: '/zookeeper/quota', name: 'quota' })).toBe(true);
    expect(zookeeperProvisioner.isReservedExternalGroup({ externalId: '/hermes/credit-card', name: 'cc' })).toBe(false);
  });

  it('two empty-email users get independent cache rows and never clobber each other (regression: shared email key)', async () => {
    const aclA = (await zookeeperProvisioner.inviteUser('', 'User A', 'usr-a')).externalUserId;
    const aclB = (await zookeeperProvisioner.inviteUser('', 'User B', 'usr-b')).externalUserId;

    expect(aclA).not.toBe(aclB);
    const rows = await prisma.platformExternalUser.findMany({ where: { platform: 'zookeeper' } });
    expect(rows).toHaveLength(2);
    const byAcl = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(byAcl[aclA]?.name).toBe('User A');
    expect(byAcl[aclB]?.name).toBe('User B');

    await prisma.userCreationRequest.createMany({
      data: [
        { userId: 'usr-a', userName: 'User A', userEmail: 'a-acct@bachatt.app', platform: 'zookeeper', status: 'COMPLETED', externalUserId: aclA },
        { userId: 'usr-b', userName: 'User B', userEmail: 'b-acct@bachatt.app', platform: 'zookeeper', status: 'COMPLETED', externalUserId: aclB },
      ],
    });

    await zookeeperProvisioner.provision({ email: '', name: 'User A', userId: 'usr-a', externalGroupId: '/hermes/team-a#r' });
    await zookeeperProvisioner.provision({ email: '', name: 'User B', userId: 'usr-b', externalGroupId: '/hermes/team-b#cdrw' });

    const a = await prisma.platformExternalUser.findUnique({
      where: { platform_externalId: { platform: 'zookeeper', externalId: aclA } },
    });
    const b = await prisma.platformExternalUser.findUnique({
      where: { platform_externalId: { platform: 'zookeeper', externalId: aclB } },
    });
    expect(a?.externalGroupIds).toEqual(['/hermes/team-a']);
    expect(b?.externalGroupIds).toEqual(['/hermes/team-b']);
  });

  it('getOnboardingMessage is a credential-free "access is set up" confirmation', () => {
    const msg = zookeeperProvisioner.getOnboardingMessage();
    expect(msg.notification.message).toContain('access is set up');
    expect(msg.email.text).not.toContain('password');
    expect(msg.email.text).not.toContain('addauth');
    expect(msg.dm).not.toContain('addauth');
  });

  it('checkUserStatus resolves status for blank-email ZK users', async () => {
    const aclId = (await zookeeperProvisioner.inviteUser('', 'Blank User', 'usr-blank')).externalUserId;
    await prisma.userCreationRequest.create({
      data: {
        userId: 'usr-blank',
        userName: 'Blank User',
        userEmail: '',
        platform: 'zookeeper',
        status: 'COMPLETED',
        externalUserId: aclId,
      },
    });

    const status = await zookeeperProvisioner.checkUserStatus('', 'usr-blank');
    expect(status).toMatchObject({
      exists: true,
      externalUserId: aclId,
    });
  });

  it('createExternalGroup allows multiple groups with the default /#cdrw path without collision errors', async () => {
    const res1 = await zookeeperProvisioner.createExternalGroup('Group 1');
    await prisma.group.create({
      data: {
        name: 'Group 1',
        slug: 'group-1',
        description: '',
        platform: 'zookeeper',
        externalGroupId: res1.externalGroupId,
        tables: [],
      },
    });

    const res2 = await zookeeperProvisioner.createExternalGroup('Group 2');
    expect(res2.externalGroupId).toBe('/#cdrw');
  });

  it('provisions and deprovisions descendant paths in Postgres cache recursively', async () => {
    // 1. Create a tree in the simulation store
    await zookeeperService.createNodeRecursive('/retention/child/grandchild');

    const aclId = await invite('test-descendant@bachatt.app');

    // 2. Provision access to the root of that subtree
    await zookeeperProvisioner.provision({
      email: 'test-descendant@bachatt.app',
      name: 'Test Descendant User',
      externalGroupId: '/retention#cdrw',
    });

    // 3. Verify the cache contains the root path and its descendants
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'test-descendant@bachatt.app' } },
    });
    expect(cached?.externalGroupIds.sort()).toEqual([
      '/retention',
      '/retention/child',
      '/retention/child/grandchild',
    ].sort());

    // 4. Deprovision and verify the cache is cleared
    await zookeeperProvisioner.deprovision({
      externalUserId: aclId,
      externalGroupId: '/retention#cdrw',
    });
    const cleared = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'test-descendant@bachatt.app' } },
    });
    expect(cleared?.externalGroupIds).toEqual([]);
  });
});
