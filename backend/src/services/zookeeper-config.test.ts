import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import { zookeeperConfigService } from './zookeeper-config.service';
import { zookeeperService } from './zookeeper.service';
import { zookeeperProvisioner } from './zookeeper.provisioner';
import { AuthorizationError, ConflictError } from '../utils/errors';

/**
 * Config-service tests, all in simulation mode. Grants live in real Postgres (setup.ts
 * truncates between tests); znode data/ACLs live in the in-process sim store, reset each test.
 */
describe('ZookeeperConfigService (simulation)', () => {
  const USER = { id: 'usr-1', username: 'Ana', email: 'ana@bachatt.app' };
  const REVIEWER = { id: 'admin-1', username: 'Boss' };

  beforeEach(() => {
    zookeeperService.__resetSim();
  });

  /** Mint USER's single ZK credential + a COMPLETED account row. */
  async function mintUser(): Promise<string> {
    const { externalUserId } = await zookeeperProvisioner.inviteUser(USER.email, USER.username, USER.id);
    await prisma.userCreationRequest.create({
      data: { userId: USER.id, userName: USER.username, userEmail: USER.email, platform: 'zookeeper', status: 'COMPLETED', externalUserId },
    });
    return externalUserId;
  }

  /** Create a ZK group + an active grant for USER (reusing their credential). */
  async function addGroupGrant(externalUserId: string, externalGroupId: string, opts: { slug?: string; name?: string } = {}) {
    const group = await prisma.group.create({
      data: { name: opts.name ?? 'Credit Card', slug: opts.slug ?? 'zk-test-group', description: '', platform: 'zookeeper', externalGroupId, tables: [] },
    });
    await prisma.userAccess.create({
      data: { userId: USER.id, userName: USER.username, userEmail: USER.email, groupId: group.id, isActive: true, externalUserId, grantedBy: 'test' },
    });
    return group;
  }

  async function setupGrant(externalGroupId: string, opts: { slug?: string; name?: string } = {}) {
    const externalUserId = await mintUser();
    const group = await addGroupGrant(externalUserId, externalGroupId, opts);
    return { group, externalUserId };
  }

  async function seed(path: string, value: string) {
    await zookeeperService.createNodeRecursive(path);
    await zookeeperService.setData(path, value);
  }

  const approve = (path: string) => ({ path, decision: 'APPROVED' as const });
  const reject = (path: string) => ({ path, decision: 'REJECTED' as const });

  it('getUserScope returns the grant paths with canWrite from perms', async () => {
    const { group } = await setupGrant('/hermes/credit-card#cdrw');
    const scope = await zookeeperConfigService.getUserScope(USER.id);
    expect(scope).toHaveLength(1);
    expect(scope[0]).toMatchObject({ groupId: group.id, groupName: 'Credit Card' });
    expect(scope[0].paths[0]).toMatchObject({ path: '/hermes/credit-card', perms: 'cdrw', canWrite: true });
  });

  it('browseNode hides out-of-scope siblings and annotates canWrite', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/db-host', '10.0.0.5');
    await seed('/hermes/other/secret', 'nope');

    const node = await zookeeperConfigService.browseNode(USER.id, '/hermes/credit-card');
    expect(node.canWrite).toBe(true);
    expect(node.children.map((c) => c.name)).toEqual(['db-host']);
    expect(node.children[0]).toMatchObject({ value: '10.0.0.5', canWrite: true });

    const parent = await zookeeperConfigService.browseNode(USER.id, '/hermes');
    expect(parent.children.map((c) => c.name)).toEqual(['credit-card']);
  });

  it('browseNode rejects a path the user has no access to', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await expect(zookeeperConfigService.browseNode(USER.id, '/hermes/other')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('read-only grant ⇒ child canWrite false and a submit is rejected', async () => {
    await setupGrant('/hermes/reports#r');
    await seed('/hermes/reports/daily', 'on');

    const node = await zookeeperConfigService.browseNode(USER.id, '/hermes/reports');
    expect(node.children[0].canWrite).toBe(false);

    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/reports/daily', action: 'SET', newValue: 'off' }],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('enforces action-specific permissions on createChangeRequest (e.g. only deletion for #d)', async () => {
    await setupGrant('/hermes/lending#d', { slug: 'lending', name: 'Lending' });
    await seed('/hermes/lending/foo', 'value');

    // 1. Should be able to request DELETE
    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [{ path: '/hermes/lending/foo', action: 'DELETE', oldValue: 'value' }],
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].changes[0]).toMatchObject({ path: '/hermes/lending/foo', action: 'DELETE' });

    // 2. Should reject SET
    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/lending/foo', action: 'SET', oldValue: 'value', newValue: 'new' }],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // 3. Should reject CREATE on a non-existent child
    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/lending/bar', action: 'CREATE', newValue: 'new' }],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('submit + approve-all applies SET/CREATE/CLEAR to the sim store', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/db-host', 'old');
    await seed('/hermes/credit-card/timeout', '30s');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      justification: 'tune config',
      changes: [
        { path: '/hermes/credit-card/db-host', action: 'SET', oldValue: 'old', newValue: '10.0.0.9' },
        { path: '/hermes/credit-card/new-key', action: 'CREATE', newValue: 'hello' },
        { path: '/hermes/credit-card/timeout', action: 'CLEAR', newValue: '' },
      ],
    });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(req.status).toBe('PENDING');

    const reviewed = await zookeeperConfigService.reviewChangeRequest(req.id, REVIEWER, [
      approve('/hermes/credit-card/db-host'),
      approve('/hermes/credit-card/new-key'),
      approve('/hermes/credit-card/timeout'),
    ]);
    expect(reviewed.status).toBe('APPLIED');

    expect(await zookeeperService.getData('/hermes/credit-card/db-host')).toBe('10.0.0.9');
    expect(await zookeeperService.getData('/hermes/credit-card/new-key')).toBe('hello');
    expect(await zookeeperService.getData('/hermes/credit-card/timeout')).toBe('');
  });

  it('records rich ZK_CHANGE_SUBMITTED and ZK_CHANGE_<status> audit details', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/db-host', 'old');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      justification: 'tune config',
      changes: [
        { path: '/hermes/credit-card/db-host', action: 'SET', oldValue: 'old', newValue: '10.0.0.9' },
      ],
    });
    const req = reqs[0];

    const submitted = await prisma.auditEntry.findFirst({
      where: { action: 'ZK_CHANGE_SUBMITTED', groupId: req.groupId! },
    });
    expect(submitted).toBeTruthy();
    expect(submitted!.details).toMatchObject({
      requestId: req.id,
      changeCount: 1,
      justification: 'tune config',
      changes: [
        expect.objectContaining({
          path: '/hermes/credit-card/db-host',
          action: 'SET',
          oldValue: 'old',
          newValue: '10.0.0.9',
        }),
      ],
    });

    await zookeeperConfigService.reviewChangeRequest(
      req.id,
      REVIEWER,
      [approve('/hermes/credit-card/db-host')],
      'looks good',
    );

    const reviewed = await prisma.auditEntry.findFirst({
      where: { action: 'ZK_CHANGE_APPLIED', groupId: req.groupId! },
    });
    expect(reviewed).toBeTruthy();
    expect(reviewed!.details).toMatchObject({
      requestId: req.id,
      approved: 1,
      applied: 1,
      rejected: 0,
      failed: 0,
      reviewNote: 'looks good',
      justification: 'tune config',
      changes: [
        expect.objectContaining({
          path: '/hermes/credit-card/db-host',
          decision: 'APPROVED',
          applied: true,
        }),
      ],
    });
  });

  it('per-change review: approve one, reject the other → PARTIALLY_APPLIED', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/a', 'a0');
    await seed('/hermes/credit-card/b', 'b0');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [
        { path: '/hermes/credit-card/a', action: 'SET', oldValue: 'a0', newValue: 'a1' },
        { path: '/hermes/credit-card/b', action: 'SET', oldValue: 'b0', newValue: 'b1' },
      ],
    });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];

    const reviewed = await zookeeperConfigService.reviewChangeRequest(req.id, REVIEWER, [
      approve('/hermes/credit-card/a'),
      reject('/hermes/credit-card/b'),
    ]);
    expect(reviewed.status).toBe('PARTIALLY_APPLIED');
    expect(await zookeeperService.getData('/hermes/credit-card/a')).toBe('a1');
    expect(await zookeeperService.getData('/hermes/credit-card/b')).toBe('b0');
  });

  it('routes each change to its owning group across a multi-group request, creating separate requests', async () => {
    const externalUserId = await mintUser();
    const gA = await addGroupGrant(externalUserId, '/hermes/team-a#cdrw', { slug: 'team-a', name: 'Team A' });
    const gB = await addGroupGrant(externalUserId, '/hermes/team-b#cdrw', { slug: 'team-b', name: 'Team B' });
    await seed('/hermes/team-a/x', '1');
    await seed('/hermes/team-b/y', '2');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [
        { path: '/hermes/team-a/x', action: 'SET', newValue: '10' },
        { path: '/hermes/team-b/y', action: 'SET', newValue: '20' },
      ],
    });
    expect(reqs).toHaveLength(2);
    const reqA = reqs.find((r) => r.groupId === gA.id);
    const reqB = reqs.find((r) => r.groupId === gB.id);
    expect(reqA).toBeDefined();
    expect(reqB).toBeDefined();
    expect(reqA!.groupIds).toEqual([gA.id]);
    expect(reqB!.groupIds).toEqual([gB.id]);
    expect(reqA!.changes).toHaveLength(1);
    expect(reqB!.changes).toHaveLength(1);
    expect((reqA!.changes as any[])[0].path).toBe('/hermes/team-a/x');
    expect((reqB!.changes as any[])[0].path).toBe('/hermes/team-b/y');

    // Test that review permissions are isolated per-request
    const adminA = { id: 'admin-a', username: 'Admin A' };
    const adminB = { id: 'admin-b', username: 'Admin B' };
    await prisma.groupAdmin.create({
      data: { groupId: gA.id, userId: adminA.id, userName: adminA.username, userEmail: 'admina@bachatt.app', assignedBy: 'test' }
    });
    await prisma.groupAdmin.create({
      data: { groupId: gB.id, userId: adminB.id, userName: adminB.username, userEmail: 'adminb@bachatt.app', assignedBy: 'test' }
    });

    const authAdminA = { ...adminA, email: 'admina@bachatt.app', roles: [] } as any;
    const authAdminB = { ...adminB, email: 'adminb@bachatt.app', roles: [] } as any;

    expect(await zookeeperConfigService.canReview(authAdminA, reqA!)).toBe(true);
    expect(await zookeeperConfigService.canReview(authAdminA, reqB!)).toBe(false);

    expect(await zookeeperConfigService.canReview(authAdminB, reqA!)).toBe(false);
    expect(await zookeeperConfigService.canReview(authAdminB, reqB!)).toBe(true);
  });

  it('owningGroup picks the deeper directory on overlapping path grants', async () => {
    const externalUserId = await mintUser();
    const gBroad = await addGroupGrant(externalUserId, '/hermes#cdrw', { slug: 'broad', name: 'Broad' });
    const gDeep = await addGroupGrant(externalUserId, '/hermes/credit-card#cdrw', { slug: 'deep', name: 'Deep' });

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [{ path: '/hermes/credit-card/db-host', action: 'CREATE', newValue: 'deeper' }],
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].groupId).toBe(gDeep.id);
  });

  it('DELETE refuses a group/level backing path → APPLY_FAILED, others still apply', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card', '');
    await seed('/hermes/credit-card/leaf', 'x');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [
        { path: '/hermes/credit-card/leaf', action: 'DELETE' },
        { path: '/hermes/credit-card', action: 'DELETE' },
      ],
    });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];

    const reviewed = await zookeeperConfigService.reviewChangeRequest(req.id, REVIEWER, [
      approve('/hermes/credit-card/leaf'),
      approve('/hermes/credit-card'),
    ]);
    expect(reviewed.status).toBe('APPLY_FAILED');

    const changes = reviewed.changes as any[];
    expect(changes.find((c) => c.path === '/hermes/credit-card/leaf').applied).toBe(true);
    const backing = changes.find((c) => c.path === '/hermes/credit-card');
    expect(backing.applied).toBe(false);
    expect(backing.error).toMatch(/backs a Hermes/);
  });

  it('reject-all marks REJECTED and applies nothing', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/db-host', 'keep');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [{ path: '/hermes/credit-card/db-host', action: 'SET', newValue: 'changed' }],
    });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    const reviewed = await zookeeperConfigService.reviewChangeRequest(req.id, REVIEWER, [reject('/hermes/credit-card/db-host')], 'no');
    expect(reviewed.status).toBe('REJECTED');
    expect(await zookeeperService.getData('/hermes/credit-card/db-host')).toBe('keep');
  });

  it('exportSubtree emits JSONL for data nodes within the grant', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card', '');
    await seed('/hermes/credit-card/db-host', '10.0.0.5');
    await seed('/hermes/credit-card/timeout', '30s');

    const content = await zookeeperConfigService.exportSubtree(USER.id, '/hermes/credit-card');
    const lines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const byPath = Object.fromEntries(lines.map((l: any) => [l.path, l.value]));
    expect(byPath['/hermes/credit-card/db-host']).toBe('10.0.0.5');
    expect(byPath['/hermes/credit-card/timeout']).toBe('30s');
  });

  it('exportSubtree refuses a path outside the grant', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await expect(zookeeperConfigService.exportSubtree(USER.id, '/hermes/secret')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('createChangeRequest rejects CREATE on existing node', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/existing', 'value');

    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/credit-card/existing', action: 'CREATE', newValue: 'new' }],
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('createChangeRequest rejects SET/CLEAR/DELETE on non-existent node', async () => {
    await setupGrant('/hermes/credit-card#cdrw');

    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/credit-card/nonexistent', action: 'SET', newValue: 'new' }],
      }),
    ).rejects.toThrow(/does not exist/);

    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/credit-card/nonexistent', action: 'CLEAR' }],
      }),
    ).rejects.toThrow(/does not exist/);

    await expect(
      zookeeperConfigService.createChangeRequest({
        requester: USER,
        changes: [{ path: '/hermes/credit-card/nonexistent', action: 'DELETE' }],
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('createChangeRequest handles sequential staged state in a single batch correctly', async () => {
    await setupGrant('/hermes/credit-card#cdrw');

    // CREATE then SET in the same request batch on a non-existent node should succeed!
    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [
        { path: '/hermes/credit-card/staged', action: 'CREATE', newValue: 'initial' },
        { path: '/hermes/credit-card/staged', action: 'SET', oldValue: 'initial', newValue: 'updated' },
      ],
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe('PENDING');
  });

  it('reviewChangeRequest atomically transitions PENDING -> APPLYING and prevents concurrent reviews', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/db-host', 'old');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [{ path: '/hermes/credit-card/db-host', action: 'SET', oldValue: 'old', newValue: '10.0.0.9' }],
    });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];

    // Fire two review calls concurrently
    const p1 = zookeeperConfigService.reviewChangeRequest(req.id, REVIEWER, [approve('/hermes/credit-card/db-host')]);
    const p2 = zookeeperConfigService.reviewChangeRequest(req.id, REVIEWER, [approve('/hermes/credit-card/db-host')]);

    // One must succeed, the other must reject with ConflictError
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already being reviewed/);
  });

  it('SET guards against a lost update even when drafted on an empty node (#10)', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/key', ''); // empty when the requester drafts the change

    // Drafted with no recorded old value — the node was empty when the requester saw it.
    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [{ path: '/hermes/credit-card/key', action: 'SET', oldValue: null, newValue: 'mine' }],
    });

    // Someone else writes the node after the draft but before it is reviewed.
    await zookeeperService.setData('/hermes/credit-card/key', 'sneaky');

    const reviewed = await zookeeperConfigService.reviewChangeRequest(reqs[0].id, REVIEWER, [
      approve('/hermes/credit-card/key'),
    ]);

    // The stale SET must be caught and must NOT clobber the concurrent write.
    expect(reviewed.status).toBe('APPLY_FAILED');
    expect((reviewed.changes as any[])[0].error).toMatch(/changed since draft/);
    expect(await zookeeperService.getData('/hermes/credit-card/key')).toBe('sneaky');
  });

  it('SET on a still-empty node applies (null/empty old value normalized) (#10)', async () => {
    await setupGrant('/hermes/credit-card#cdrw');
    await seed('/hermes/credit-card/key', '');

    const reqs = await zookeeperConfigService.createChangeRequest({
      requester: USER,
      changes: [{ path: '/hermes/credit-card/key', action: 'SET', oldValue: null, newValue: 'mine' }],
    });
    const reviewed = await zookeeperConfigService.reviewChangeRequest(reqs[0].id, REVIEWER, [
      approve('/hermes/credit-card/key'),
    ]);
    expect(reviewed.status).toBe('APPLIED');
    expect(await zookeeperService.getData('/hermes/credit-card/key')).toBe('mine');
  });

  it('sweepStuckApplying recovers requests orphaned in APPLYING, sparing fresh ones (4.3)', async () => {
    const { group } = await setupGrant('/hermes/credit-card#cdrw');
    const stuck = await prisma.zookeeperChangeRequest.create({
      data: {
        requesterId: USER.id,
        requesterName: USER.username,
        requesterEmail: USER.email,
        groupId: group.id,
        groupIds: [group.id],
        status: 'APPLYING',
        changes: [],
      },
    });

    // A fresh APPLYING row (within the default 10-min cutoff) is left alone.
    expect(await zookeeperConfigService.sweepStuckApplying()).toBe(0);
    expect((await prisma.zookeeperChangeRequest.findUnique({ where: { id: stuck.id } }))!.status).toBe('APPLYING');

    // A negative maxAge puts the cutoff in the future, so the stuck row qualifies.
    expect(await zookeeperConfigService.sweepStuckApplying(-1000)).toBe(1);
    const after = await prisma.zookeeperChangeRequest.findUnique({ where: { id: stuck.id } });
    expect(after!.status).toBe('APPLY_FAILED');
    expect(after!.applyError).toMatch(/process interrupted/);
  });
});
