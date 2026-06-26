import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Exception } from 'node-zookeeper-client';
import prisma from '../config/prisma';
import config from '../config/config';
import { zookeeperProvisioner } from './zookeeper.provisioner';
import { zookeeperService } from './zookeeper.service';
import { ValidationError } from '../utils/errors';

/**
 * Unit/integration tests for the ZooKeeper adapter, all in simulation mode
 * (ZOOKEEPER_SIMULATION is implied on locally — no connect string is set). Cache rows
 * use the real Postgres (setup.ts truncates between tests); the znode ACL state lives
 * in the service's in-process sim store, reset before each test.
 */
describe('ZookeeperProvisioner (simulation)', () => {
  const GROUP_PATH = '/hermes/credit-card';

  beforeEach(() => {
    zookeeperService.__resetSim();
  });

  /** Invite a user and return their minted ACL id. */
  async function invite(email: string, name = 'Test User'): Promise<string> {
    const res = await zookeeperProvisioner.inviteUser(email, name);
    return res.externalUserId;
  }

  it('mints a digest credential, seeds the cache, and completes immediately (no setup link)', async () => {
    const email = 'alice@bachatt.app';
    const res = await zookeeperProvisioner.inviteUser(email, 'Alice');

    // No inviteLink ⇒ the user-creation flow treats the account as ready now.
    expect(res.metadata?.inviteLink).toBeUndefined();
    // externalUserId is the digest ACL id "<user>:<hash>".
    expect(res.externalUserId.startsWith(`${email}:`)).toBe(true);
    // One-time credential rides in metadata for the onboarding message.
    expect(res.metadata?.zkUsername).toBe(email);
    expect(typeof res.metadata?.zkPassword).toBe('string');
    expect((res.metadata?.zkPassword as string).length).toBeGreaterThan(0);

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

  it('provision adds the user as a digest ACL entry on the level znode', async () => {
    const aclId = await invite('carol@bachatt.app');
    const result = await zookeeperProvisioner.provision({
      email: 'carol@bachatt.app',
      name: 'Carol',
      externalGroupId: `${GROUP_PATH}#r`,
    });
    expect(result.externalUserId).toBe(aclId);

    const acl = await zookeeperService.getAcl(GROUP_PATH);
    expect(acl).toHaveLength(1);
    expect(acl[0]).toMatchObject({ scheme: 'digest', id: aclId, perms: 'r', mask: 1 });
  });

  it('refuses to provision a user who has no ZooKeeper credential yet', async () => {
    await expect(
      zookeeperProvisioner.provision({ email: 'nobody@bachatt.app', name: 'Nobody', externalGroupId: `${GROUP_PATH}#r` }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('resolves the credential by userId when the request email drifts from the account email', async () => {
    // The account-creation gate keys on (userId, platform) and stores the minted aclId on
    // that row. The Keycloak JWT may carry no/different email between account approval and
    // this grant — provision must still resolve the credential by userId, not throw the
    // contradictory "account not created" error. (Regression: email-only lookup.)
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

    // Group request carries a DIFFERENT email (and even an empty one) — both must work.
    for (const reqEmail of ['frank-other@bachatt.app', '']) {
      const res = await zookeeperProvisioner.provision({
        email: reqEmail,
        name: 'Frank',
        userId: 'usr-frank',
        externalGroupId: `${GROUP_PATH}#r`,
      });
      expect(res.externalUserId).toBe(aclId);
    }

    const acl = await zookeeperService.getAcl(GROUP_PATH);
    expect(acl).toHaveLength(1);
    expect(acl[0]).toMatchObject({ scheme: 'digest', id: aclId, perms: 'r' });
  });

  it('read (#r) and write (#cdrw) levels resolve to different permission bits; a level change rewrites the same entry', async () => {
    const aclId = await invite('dave@bachatt.app');

    // Read-only level.
    await zookeeperProvisioner.provision({ email: 'dave@bachatt.app', name: 'Dave', externalGroupId: `${GROUP_PATH}#r` });
    let acl = await zookeeperService.getAcl(GROUP_PATH);
    expect(acl).toHaveLength(1);
    expect(acl[0].mask).toBe(1); // r

    // Promote to read-write on the SAME path → one entry, new perms (no duplicate).
    await zookeeperProvisioner.provision({ email: 'dave@bachatt.app', name: 'Dave', externalGroupId: `${GROUP_PATH}#cdrw` });
    acl = await zookeeperService.getAcl(GROUP_PATH);
    expect(acl).toHaveLength(1);
    expect(acl[0].id).toBe(aclId);
    expect(acl[0].perms).toBe('cdrw');
    expect(acl[0].mask).toBe(1 | 2 | 4 | 8); // r|w|c|d = 15
  });

  it('deprovision removes the entry and is idempotent', async () => {
    const aclId = await invite('erin@bachatt.app');
    await zookeeperProvisioner.provision({ email: 'erin@bachatt.app', name: 'Erin', externalGroupId: `${GROUP_PATH}#cdrw` });
    expect(await zookeeperService.getAcl(GROUP_PATH)).toHaveLength(1);

    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${GROUP_PATH}#cdrw` });
    expect(await zookeeperService.getAcl(GROUP_PATH)).toHaveLength(0);

    // Second call is a no-op (no throw).
    await expect(
      zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${GROUP_PATH}#cdrw` }),
    ).resolves.toBeUndefined();
  });

  it('provision fans out to every path in a multi-line group id; deprovision removes them all', async () => {
    const P1 = '/hermes/multi-a';
    const P2 = '/hermes/multi-b';
    const aclId = await invite('judy@bachatt.app');

    // A group id is a newline-separated list of path#perms — one grant, two znodes.
    await zookeeperProvisioner.provision({
      email: 'judy@bachatt.app',
      name: 'Judy',
      externalGroupId: `${P1}#r\n${P2}#cdrw`,
    });
    expect((await zookeeperService.getAcl(P1))[0]).toMatchObject({ id: aclId, perms: 'r' });
    expect((await zookeeperService.getAcl(P2))[0]).toMatchObject({ id: aclId, perms: 'cdrw' });

    // The cache mirrors both bare paths.
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'judy@bachatt.app' } },
    });
    expect(cached?.externalGroupIds.sort()).toEqual([P1, P2].sort());

    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${P1}#r\n${P2}#cdrw` });
    expect(await zookeeperService.getAcl(P1)).toHaveLength(0);
    expect(await zookeeperService.getAcl(P2)).toHaveLength(0);
  });

  it('reconcileMembers grants added paths, strips removed paths, and updates changed perms for existing members', async () => {
    const PATH_A = '/hermes/credit-card';
    const PATH_B = '/hermes/shared';
    const PATH_C = '/hermes/audit';
    const aclId = await invite('ivy@bachatt.app');

    // Existing grant: A(#r) + B(#r).
    await zookeeperProvisioner.provision({
      email: 'ivy@bachatt.app',
      name: 'Ivy',
      externalGroupId: `${PATH_A}#r\n${PATH_B}#r`,
    });
    expect((await zookeeperService.getAcl(PATH_A))[0].perms).toBe('r');
    expect(await zookeeperService.getAcl(PATH_B)).toHaveLength(1);

    // New mapping: A perms r→cdrw (changed), B dropped, C added (#r).
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

    expect((await zookeeperService.getAcl(PATH_A))[0]).toMatchObject({ id: aclId, perms: 'cdrw' }); // perms updated
    expect(await zookeeperService.getAcl(PATH_B)).toHaveLength(0); // removed
    expect((await zookeeperService.getAcl(PATH_C))[0]).toMatchObject({ id: aclId, perms: 'r' }); // added
  });

  it('deprovision keeps paths the new mapping still grants (retainExternalGroupId) — shared paths survive a level swap', async () => {
    const SHARED = '/hermes/shared';
    const OLD_ONLY = '/hermes/old-only';
    const NEW_ONLY = '/hermes/new-only';
    const aclId = await invite('mallory@bachatt.app');

    // On the OLD level's paths: shared(#r) + old-only(#r).
    await zookeeperProvisioner.provision({
      email: 'mallory@bachatt.app',
      name: 'Mallory',
      externalGroupId: `${SHARED}#r\n${OLD_ONLY}#r`,
    });

    // Swap, as _swapGrant drives it: provision the NEW level first (shared now #cdrw +
    // new-only)...
    await zookeeperProvisioner.provision({
      email: 'mallory@bachatt.app',
      name: 'Mallory',
      externalGroupId: `${SHARED}#cdrw\n${NEW_ONLY}#r`,
    });
    // ...then deprovision the OLD mapping, retaining whatever the NEW one still grants.
    await zookeeperProvisioner.deprovision({
      externalUserId: aclId,
      externalGroupId: `${SHARED}#r\n${OLD_ONLY}#r`,
      retainExternalGroupId: `${SHARED}#cdrw\n${NEW_ONLY}#r`,
    });

    // Shared path kept with the NEW perms; old-only stripped; new-only present.
    const sharedAcl = await zookeeperService.getAcl(SHARED);
    expect(sharedAcl).toHaveLength(1);
    expect(sharedAcl[0]).toMatchObject({ id: aclId, perms: 'cdrw' });
    expect(await zookeeperService.getAcl(OLD_ONLY)).toHaveLength(0);
    expect((await zookeeperService.getAcl(NEW_ONLY))[0]?.id).toBe(aclId);
  });

  it('partial-failure rollback keeps a path the user already held via another grant (C-3)', async () => {
    const SHARED = '/hermes/shared';
    const ONLY_B = '/hermes/only-b';
    const FAIL = '/hermes/fail';
    const aclId = await invite('peggy@bachatt.app');

    // Group A grants SHARED — the user legitimately holds it before group B.
    await zookeeperProvisioner.provision({ email: 'peggy@bachatt.app', name: 'Peggy', externalGroupId: `${SHARED}#r` });
    expect(await zookeeperService.getAcl(SHARED)).toHaveLength(1);

    // Group B = SHARED + ONLY_B + FAIL; make the FAIL path blow up mid-provision so the
    // rollback fires after SHARED and ONLY_B were applied.
    const realAdd = zookeeperService.addAclEntry.bind(zookeeperService);
    const spy = vi
      .spyOn(zookeeperService, 'addAclEntry')
      .mockImplementation(async (path: string, id: string, perms: string) => {
        if (path === FAIL) throw new Error('boom');
        return realAdd(path, id, perms);
      });

    await expect(
      zookeeperProvisioner.provision({
        email: 'peggy@bachatt.app',
        name: 'Peggy',
        externalGroupId: `${SHARED}#cdrw\n${ONLY_B}#r\n${FAIL}#r`,
      }),
    ).rejects.toThrow('boom');
    spy.mockRestore();

    // SHARED survived (pre-existing → not stripped); ONLY_B (new to this grant) rolled
    // back; FAIL never applied. Without the fix the rollback would have stripped SHARED.
    const sharedAcl = await zookeeperService.getAcl(SHARED);
    expect(sharedAcl).toHaveLength(1);
    expect(sharedAcl[0].id).toBe(aclId);
    expect(await zookeeperService.getAcl(ONLY_B)).toHaveLength(0);
    expect(await zookeeperService.getAcl(FAIL)).toHaveLength(0);
  });

  it('reconcileMembers keeps a removed path the member still holds via another grant (retainExternalGroupIds)', async () => {
    const SHARED = '/hermes/shared';
    const OTHER = '/hermes/other';
    const aclId = await invite('reese@bachatt.app');

    // Member holds SHARED + OTHER.
    await zookeeperProvisioner.provision({
      email: 'reese@bachatt.app',
      name: 'Reese',
      externalGroupId: `${SHARED}#r\n${OTHER}#r`,
    });

    // This group drops SHARED, but the member still holds SHARED via another grant
    // (passed as retainExternalGroupIds), so its ACL must NOT be stripped.
    const result = await zookeeperProvisioner.reconcileMembers({
      oldExternalGroupId: `${SHARED}#r\n${OTHER}#r`,
      newExternalGroupId: `${OTHER}#r`,
      members: [
        { email: 'reese@bachatt.app', name: 'Reese', externalUserId: aclId, retainExternalGroupIds: [`${SHARED}#cdrw`] },
      ],
    });

    // The mapping diff still reports the removal, but the member's ACL entry is kept.
    expect(result.removedPaths).toEqual([SHARED]);
    expect(result.errors).toHaveLength(0);
    expect(await zookeeperService.getAcl(SHARED)).toHaveLength(1);
    expect(await zookeeperService.getAcl(OTHER)).toHaveLength(1);
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
    expect(await zookeeperService.getAcl(GROUP_PATH)).toHaveLength(1);
  });

  it('serializes concurrent grants on the same znode so neither is clobbered (per-path lock)', async () => {
    const idA = await invite('frank@bachatt.app');
    const idB = await invite('grace@bachatt.app');

    // setACL replaces the whole ACL → without the per-path lock, one of these
    // concurrent read-modify-writes would drop the other's entry.
    await Promise.all([
      zookeeperProvisioner.provision({ email: 'frank@bachatt.app', name: 'Frank', externalGroupId: `${GROUP_PATH}#r` }),
      zookeeperProvisioner.provision({ email: 'grace@bachatt.app', name: 'Grace', externalGroupId: `${GROUP_PATH}#cdrw` }),
    ]);

    const acl = await zookeeperService.getAcl(GROUP_PATH);
    expect(acl).toHaveLength(2);
    expect(acl.map((e) => e.id).sort()).toEqual([idA, idB].sort());
  });

  it('createExternalGroup / deleteExternalGroup manage the backing znode', async () => {
    const { externalGroupId } = await zookeeperProvisioner.createExternalGroup('Risk Ops');
    expect(externalGroupId).toBe('/hermes/risk-ops');
    expect(await zookeeperService.getAcl(externalGroupId)).toHaveLength(0); // node exists, empty ACL

    await zookeeperProvisioner.deleteExternalGroup(externalGroupId);
    expect(await zookeeperService.getAcl(externalGroupId)).toHaveLength(0); // gone (empty)
  });

  it('reports simulation and reserves the ZooKeeper system subtree', () => {
    expect(zookeeperProvisioner.isSimulation()).toBe(true);
    expect(zookeeperProvisioner.getLaunchUrl()).toBeNull();
    expect(zookeeperProvisioner.isReservedExternalGroup({ externalId: '/zookeeper', name: 'zookeeper' })).toBe(true);
    expect(zookeeperProvisioner.isReservedExternalGroup({ externalId: '/zookeeper/quota', name: 'quota' })).toBe(true);
    expect(zookeeperProvisioner.isReservedExternalGroup({ externalId: '/hermes/credit-card', name: 'cc' })).toBe(false);
  });

  it('subtree expansion: grants READ on ancestors + matching perms on existing descendants while the node keeps its own perms', async () => {
    const aclId = await invite('nina@bachatt.app');
    // A child znode that exists before the grant — it should become readable.
    await zookeeperService.createNode(`${GROUP_PATH}/transactions`);
    await zookeeperService.createNode(`${GROUP_PATH}/transactions/2024`);

    await zookeeperProvisioner.provision({
      email: 'nina@bachatt.app',
      name: 'Nina',
      externalGroupId: `${GROUP_PATH}#cdrw`,
    });

    // The granted node keeps the full level perms…
    expect((await zookeeperService.getAcl(GROUP_PATH))[0]).toMatchObject({ id: aclId, perms: 'cdrw' });
    // …ancestors get READ so the tree expands from / in ZooNavigator…
    expect((await zookeeperService.getAcl('/'))[0]).toMatchObject({ id: aclId, perms: 'r' });
    expect((await zookeeperService.getAcl('/hermes'))[0]).toMatchObject({ id: aclId, perms: 'r' });
    // …and existing descendants get matching perms so the subtree is writable/browsable.
    expect((await zookeeperService.getAcl(`${GROUP_PATH}/transactions`))[0]).toMatchObject({ id: aclId, perms: 'cdrw' });
    expect((await zookeeperService.getAcl(`${GROUP_PATH}/transactions/2024`))[0]).toMatchObject({ id: aclId, perms: 'cdrw' });

    // The cache still records ONLY the explicit granted path, not the derived reads.
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'zookeeper', email: 'nina@bachatt.app' } },
    });
    expect(cached?.externalGroupIds).toEqual([GROUP_PATH]);
  });

  it('subtree expansion: revoking the only grant strips the node, its ancestors and its descendants', async () => {
    const aclId = await invite('omar@bachatt.app');
    await zookeeperService.createNode(`${GROUP_PATH}/transactions`);
    await zookeeperProvisioner.provision({ email: 'omar@bachatt.app', name: 'Omar', externalGroupId: `${GROUP_PATH}#r` });
    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${GROUP_PATH}#r` });

    // Nothing of this user's lingers anywhere on the line, since it was their only grant.
    expect(await zookeeperService.getAcl(GROUP_PATH)).toHaveLength(0);
    expect(await zookeeperService.getAcl('/hermes')).toHaveLength(0);
    expect(await zookeeperService.getAcl('/')).toHaveLength(0);
    expect(await zookeeperService.getAcl(`${GROUP_PATH}/transactions`)).toHaveLength(0);
  });

  it('subtree expansion: a shared ancestor READ survives while the user still holds another path under it', async () => {
    const A = '/hermes/credit-card';
    const B = '/hermes/payments';
    const aclId = await invite('pia@bachatt.app');

    // Two separate grants under /hermes.
    await zookeeperProvisioner.provision({ email: 'pia@bachatt.app', name: 'Pia', externalGroupId: `${A}#r` });
    await zookeeperProvisioner.provision({ email: 'pia@bachatt.app', name: 'Pia', externalGroupId: `${B}#r` });
    expect((await zookeeperService.getAcl('/hermes'))[0]?.id).toBe(aclId);

    // Revoke only A: /hermes (and /) must stay readable because B still lives under them.
    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${A}#r` });
    expect(await zookeeperService.getAcl(A)).toHaveLength(0); // A itself gone
    expect((await zookeeperService.getAcl('/hermes'))[0]?.id).toBe(aclId); // shared ancestor kept
    expect((await zookeeperService.getAcl('/'))[0]?.id).toBe(aclId);
    expect((await zookeeperService.getAcl(B))[0]?.id).toBe(aclId); // B untouched
  });

  it('subtree expansion: revoking a parent keeps READ on it when the user still holds a child beneath it', async () => {
    const PARENT = '/hermes/credit-card';
    const CHILD = '/hermes/credit-card/reports';
    const aclId = await invite('quinn@bachatt.app');

    // Hold both the parent (write) and a child (read) via two grants.
    await zookeeperProvisioner.provision({ email: 'quinn@bachatt.app', name: 'Quinn', externalGroupId: `${PARENT}#cdrw` });
    await zookeeperProvisioner.provision({ email: 'quinn@bachatt.app', name: 'Quinn', externalGroupId: `${CHILD}#r` });

    // Revoke the parent grant: the parent node must stay (downgraded to READ) so the user
    // can still traverse to the child they retain.
    await zookeeperProvisioner.deprovision({ externalUserId: aclId, externalGroupId: `${PARENT}#cdrw` });
    expect((await zookeeperService.getAcl(PARENT))[0]).toMatchObject({ id: aclId, perms: 'r' }); // downgraded, not stripped
    expect((await zookeeperService.getAcl(CHILD))[0]).toMatchObject({ id: aclId, perms: 'r' }); // retained child
  });

  it('two empty-email users get independent cache rows and never clobber each other (regression: shared email key)', async () => {
    // A live Keycloak JWT frequently carries no email claim, so req.user.email === '' for
    // many distinct users (auth.middleware.ts). Keyed on email alone, both invites would
    // land on the single ('zookeeper','') row and the second would overwrite the first's
    // minted aclId + path cache. Keying a blank email on the stable userId keeps them apart.
    const aclA = (await zookeeperProvisioner.inviteUser('', 'User A', 'usr-a')).externalUserId;
    const aclB = (await zookeeperProvisioner.inviteUser('', 'User B', 'usr-b')).externalUserId;

    // Distinct minted identities, each in its OWN cache row (the empty-email row was not
    // shared/clobbered): A's externalId still points at A after B's invite.
    expect(aclA).not.toBe(aclB);
    const rows = await prisma.platformExternalUser.findMany({ where: { platform: 'zookeeper' } });
    expect(rows).toHaveLength(2);
    const byAcl = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(byAcl[aclA]?.name).toBe('User A');
    expect(byAcl[aclB]?.name).toBe('User B');

    // The account-creation gate keys the credential on (userId, platform); seed both so
    // provision resolves each user by their stable userId. (userEmail here is irrelevant to
    // resolution — resolveAclId looks up by userId — and is given distinct values only to
    // satisfy the gate table's own (userEmail, platform) unique constraint.)
    await prisma.userCreationRequest.createMany({
      data: [
        { userId: 'usr-a', userName: 'User A', userEmail: 'a-acct@bachatt.app', platform: 'zookeeper', status: 'COMPLETED', externalUserId: aclA },
        { userId: 'usr-b', userName: 'User B', userEmail: 'b-acct@bachatt.app', platform: 'zookeeper', status: 'COMPLETED', externalUserId: aclB },
      ],
    });

    // Each empty-email user is granted a different path; their caches must stay independent.
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

    // And the ACLs on each znode carry only the matching user's digest id.
    expect((await zookeeperService.getAcl('/hermes/team-a'))[0]).toMatchObject({ id: aclA, perms: 'r' });
    expect((await zookeeperService.getAcl('/hermes/team-b'))[0]).toMatchObject({ id: aclB, perms: 'cdrw' });
  });

  it('getOnboardingMessage embeds the one-time credential in email/DM but not the stored notification', () => {
    const msg = zookeeperProvisioner.getOnboardingMessage({
      zkUsername: 'heidi@bachatt.app',
      zkPassword: 's3cret-token',
      connectString: 'localhost:2181',
    });
    // The persisted in-app notification must NOT contain the password.
    expect(msg.notification.message).not.toContain('s3cret-token');
    // The transient email/DM channels carry it.
    expect(msg.email.text).toContain('s3cret-token');
    expect(msg.dm).toContain('s3cret-token');
    expect(msg.dm).toContain('addauth digest heidi@bachatt.app:s3cret-token');
  });

  it('checkUserStatus resolves status for blank-email ZK users', async () => {
    const aclId = await invite('', 'Blank User');
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

  it('createExternalGroup throws ConflictError on backing path collision', async () => {
    const res = await zookeeperProvisioner.createExternalGroup('Conflict Group');
    await prisma.group.create({
      data: {
        name: 'Conflict Group',
        slug: 'conflict-group',
        description: '',
        platform: 'zookeeper',
        externalGroupId: res.externalGroupId,
        tables: [],
      },
    });

    await expect(
      zookeeperProvisioner.createExternalGroup('Conflict-Group')
    ).rejects.toThrow(/already in use/);
  });

  it('revoking broad grant downgrades child grant to its correct narrower permissions', async () => {
    const PARENT = '/hermes/credit-card';
    const CHILD = '/hermes/credit-card/reports';
    const aclId = await invite('quinn-broad@bachatt.app');

    const gParent = await prisma.group.create({
      data: { name: 'Parent', slug: 'parent-gp', description: '', platform: 'zookeeper', externalGroupId: `${PARENT}#cdrw`, tables: [] },
    });
    const gChild = await prisma.group.create({
      data: { name: 'Child', slug: 'child-gp', description: '', platform: 'zookeeper', externalGroupId: `${CHILD}#r`, tables: [] },
    });

    await prisma.userAccess.create({
      data: { userId: 'usr-quinn', userName: 'Quinn', userEmail: 'quinn-broad@bachatt.app', groupId: gParent.id, isActive: true, externalUserId: aclId, grantedBy: 'test' },
    });
    await prisma.userAccess.create({
      data: { userId: 'usr-quinn', userName: 'Quinn', userEmail: 'quinn-broad@bachatt.app', groupId: gChild.id, isActive: true, externalUserId: aclId, grantedBy: 'test' },
    });

    await zookeeperProvisioner.provision({ email: 'quinn-broad@bachatt.app', name: 'Quinn', userId: 'usr-quinn', externalGroupId: `${CHILD}#r` });
    await zookeeperProvisioner.provision({ email: 'quinn-broad@bachatt.app', name: 'Quinn', userId: 'usr-quinn', externalGroupId: `${PARENT}#cdrw` });

    expect((await zookeeperService.getAcl(PARENT))[0].perms).toBe('cdrw');
    expect((await zookeeperService.getAcl(CHILD))[0].perms).toBe('cdrw');

    await prisma.userAccess.updateMany({
      where: { groupId: gParent.id, userId: 'usr-quinn' },
      data: { isActive: false },
    });

    await zookeeperProvisioner.deprovision({
      externalUserId: aclId,
      externalGroupId: `${PARENT}#cdrw`,
    });

    expect((await zookeeperService.getAcl(PARENT))[0].perms).toBe('r');
    expect((await zookeeperService.getAcl(CHILD))[0].perms).toBe('r');
  });
});

/**
 * Live-mode ACL writes use ZooKeeper's optimistic concurrency (versioned setACL): a
 * concurrent writer on the same znode (another replica) makes the first setACL fail with
 * BAD_VERSION, and the read-modify-write is re-read + re-applied. Sim mode has no version,
 * so this path is only reachable in live mode — exercised here with a fake ZK client.
 */
describe('ZookeeperService — versioned ACL writes (live)', () => {
  const PATH = '/hermes/credit-card';

  /** A minimal stateful fake ZK client: getACL returns the stored ACL + version; setACL
   *  enforces the version and can inject one BAD_VERSION to simulate a lost race. */
  function makeFakeClient(injectBadVersionOnce: boolean) {
    const state = { acls: [] as any[], version: 0, fail: injectBadVersionOnce, setAclCalls: 0 };
    const badVersionErr = () => Object.assign(new Error('bad version'), { code: Exception.BAD_VERSION });
    return {
      state,
      mkdirp: (_p: string, _acl: any, cb: (e: unknown) => void) => cb(null),
      getACL: (_p: string, cb: (e: unknown, acls: any[], stat: any) => void) =>
        cb(null, state.acls.slice(), { aversion: state.version }),
      setACL: (_p: string, acls: any[], version: number, cb: (e: unknown) => void) => {
        state.setAclCalls++;
        if (state.fail) {
          // A concurrent writer committed after our read: bump version so `version` is stale.
          state.fail = false;
          state.version++;
          return cb(badVersionErr());
        }
        if (version !== state.version) return cb(badVersionErr());
        state.acls = acls;
        state.version++;
        cb(null);
      },
    };
  }

  let fake: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    vi.spyOn(config.zookeeper, 'isSimulation', 'get').mockReturnValue(false);
    vi.spyOn(config.zookeeper, 'adminAuth', 'get').mockReturnValue('admin:secret');
    vi.spyOn(config.zookeeper, 'connectString', 'get').mockReturnValue('localhost:2181');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries the read-modify-write on BAD_VERSION and ultimately writes the entry', async () => {
    fake = makeFakeClient(true);
    vi.spyOn(zookeeperService as any, 'getClient').mockResolvedValue(fake);

    await zookeeperService.addAclEntry(PATH, 'carol@bachatt.app:hash', 'r');

    // First setACL lost the race (BAD_VERSION), second won → exactly two attempts.
    expect(fake.state.setAclCalls).toBe(2);
    // The user's digest entry is present (admin entry filtered out by getAcl).
    const acl = await zookeeperService.getAcl(PATH);
    expect(acl).toEqual([{ scheme: 'digest', id: 'carol@bachatt.app:hash', perms: 'r', mask: 1 }]);
  });

  it('gives up after MAX_ACL_WRITE_ATTEMPTS when the race never resolves', async () => {
    // A client whose setACL always reports BAD_VERSION (a writer that never stops winning).
    const alwaysFail = {
      mkdirp: (_p: string, _acl: any, cb: (e: unknown) => void) => cb(null),
      getACL: (_p: string, cb: (e: unknown, acls: any[], stat: any) => void) => cb(null, [], { aversion: 0 }),
      setACL: (_p: string, _acls: any[], _v: number, cb: (e: unknown) => void) =>
        cb(Object.assign(new Error('bad version'), { code: Exception.BAD_VERSION })),
    };
    vi.spyOn(zookeeperService as any, 'getClient').mockResolvedValue(alwaysFail);

    await expect(zookeeperService.addAclEntry(PATH, 'dave@bachatt.app:hash', 'r')).rejects.toThrow(
      /kept losing to concurrent writers/,
    );
  });
});
