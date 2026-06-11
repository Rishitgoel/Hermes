import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import { syncService } from './sync.service';
import type { PlatformAdapter } from './provisioner.interface';

/**
 * Integration tests for SyncService.reconcileHermesGroups — the step that keeps
 * the Hermes `groups` table mirroring the platform's real group list (creating
 * missing groups, archiving vanished ones, hiding reserved ones like AWS's
 * API-TESTING permission group).
 */
describe('SyncService.reconcileHermesGroups', () => {
  const OLD = new Date(Date.now() - 60 * 60 * 1000); // 1h ago — outside the grace window
  const NOW = new Date();

  /** A live AWS-like adapter stub that reserves the API-TESTING group. */
  const liveAdapter = {
    platform: 'aws',
    displayName: 'AWS',
    isSimulation: () => false,
    isReservedExternalGroup: (g: { name: string; type?: string | null }) =>
      g.name.toLowerCase() === 'api-testing',
  } as unknown as PlatformAdapter;

  const cacheRow = (externalId: string, name: string, type: string | null = 'identity-center') => ({
    platform: 'aws',
    externalId,
    name,
    type,
    lastSyncedAt: NOW,
  });

  const seedCache = (rows: ReturnType<typeof cacheRow>[]) =>
    prisma.platformExternalGroup.createMany({ data: rows });

  const seedGroup = (over: Partial<Parameters<typeof prisma.group.create>[0]['data']> = {}) =>
    prisma.group.create({
      data: {
        name: 'Growth',
        slug: 'growth',
        description: 'test',
        platform: 'aws',
        externalGroupId: 'ext-growth',
        tables: [],
        createdAt: OLD,
        ...over,
      } as any,
    });

  beforeEach(async () => {
    // setup.ts truncates all tables between tests; nothing extra needed here.
  });

  it('creates Hermes groups for platform groups Hermes does not know yet', async () => {
    await seedCache([cacheRow('ext-1', 'Data Eng'), cacheRow('ext-2', 'Finance')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const groups = await prisma.group.findMany({ orderBy: { name: 'asc' } });
    expect(groups.map(g => ({ name: g.name, slug: g.slug, externalGroupId: g.externalGroupId, isActive: g.isActive }))).toEqual([
      { name: 'Data Eng', slug: 'data-eng', externalGroupId: 'ext-1', isActive: true },
      { name: 'Finance', slug: 'finance', externalGroupId: 'ext-2', isActive: true },
    ]);
    const audits = await prisma.auditEntry.findMany({ where: { action: 'GROUP_CREATED' } });
    expect(audits).toHaveLength(2);
    expect(audits[0].performerName).toBe('Platform Sync');
  });

  it('never creates a Hermes group for a reserved platform group (API-TESTING)', async () => {
    await seedCache([cacheRow('ext-res', 'API-TESTING'), cacheRow('ext-ok', 'Analytics')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const groups = await prisma.group.findMany();
    expect(groups.map(g => g.name)).toEqual(['Analytics']);
  });

  it('does not surface a level-backing platform group as a standalone group', async () => {
    const parent = await seedGroup({ externalGroupId: null });
    await prisma.groupLevel.create({
      data: { groupId: parent.id, name: 'Senior', slug: 'senior', externalGroupId: 'ext-senior', rank: 2, createdAt: OLD },
    });
    await seedCache([cacheRow('ext-senior', 'Growth — Senior')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.count()).toBe(1); // only the parent
  });

  it('archives an active group whose backing platform group vanished', async () => {
    const g = await seedGroup(); // ext-growth, NOT in cache
    await seedCache([cacheRow('ext-other', 'Other')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const after = await prisma.group.findUnique({ where: { id: g.id } });
    expect(after!.isActive).toBe(false);
    const audit = await prisma.auditEntry.findFirst({ where: { action: 'GROUP_ARCHIVED', groupId: g.id } });
    expect(audit).not.toBeNull();
  });

  it('archives an active group that points at a reserved platform group', async () => {
    const g = await seedGroup({ name: 'Api Tester', slug: 'api-tester', externalGroupId: 'ext-res' });
    await seedCache([cacheRow('ext-res', 'API-TESTING'), cacheRow('ext-other', 'Other')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const after = await prisma.group.findUnique({ where: { id: g.id } });
    expect(after!.isActive).toBe(false);
  });

  it('leaves a just-created group alone (grace window for eventual consistency)', async () => {
    const g = await seedGroup({ createdAt: new Date() }); // fresh — backing group may not be listed yet
    await seedCache([cacheRow('ext-other', 'Other')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const after = await prisma.group.findUnique({ where: { id: g.id } });
    expect(after!.isActive).toBe(true);
  });

  it('deactivates a level whose backing group vanished, keeps group if another level is live', async () => {
    const g = await seedGroup({ externalGroupId: null });
    const dead = await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Intern', slug: 'intern', externalGroupId: 'ext-dead', rank: 1, createdAt: OLD },
    });
    const alive = await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Senior', slug: 'senior', externalGroupId: 'ext-alive', rank: 2, createdAt: OLD },
    });
    await seedCache([cacheRow('ext-alive', 'Growth — Senior')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect((await prisma.groupLevel.findUnique({ where: { id: dead.id } }))!.isActive).toBe(false);
    expect((await prisma.groupLevel.findUnique({ where: { id: alive.id } }))!.isActive).toBe(true);
    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(true);
  });

  it('archives a leveled group once every level lost its backing group', async () => {
    const g = await seedGroup(); // base ext-growth also gone
    await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Intern', slug: 'intern', externalGroupId: 'ext-dead', rank: 1, createdAt: OLD },
    });
    await seedCache([cacheRow('ext-other', 'Other')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(false);
  });

  it('skips entirely in simulation mode', async () => {
    const simAdapter = { ...liveAdapter, isSimulation: () => true } as unknown as PlatformAdapter;
    const g = await seedGroup(); // would be archived if reconciliation ran
    await seedCache([cacheRow('ext-other', 'Other')]);

    await syncService.reconcileHermesGroups('aws', simAdapter);

    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(true);
    expect(await prisma.group.count()).toBe(1); // and nothing created
  });

  it('skips entirely when the platform cache is empty (transient empty fetch)', async () => {
    const g = await seedGroup();

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(true);
  });

  it('disambiguates a slug already taken by a group on another platform', async () => {
    await seedGroup({ platform: 'redash', externalGroupId: '101' }); // slug "growth" taken
    await seedCache([cacheRow('ext-growth-aws', 'Growth')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const created = await prisma.group.findFirst({ where: { platform: 'aws' } });
    expect(created!.slug).toBe('aws-growth');
  });

  it('skips auto-create when the name collides with an existing group on the same platform', async () => {
    await seedGroup({ externalGroupId: 'ext-growth' }); // "Growth" exists, mapped elsewhere
    await seedCache([cacheRow('ext-growth', 'Whatever'), cacheRow('ext-growth-2', 'Growth')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.count()).toBe(1); // no duplicate "Growth"
  });

  it('does not reactivate an archived group whose backing group still exists (admin intent wins)', async () => {
    const g = await seedGroup({ isActive: false });
    await seedCache([cacheRow('ext-growth', 'Growth')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(false);
    expect(await prisma.group.count()).toBe(1); // and no duplicate created — the mapping is referenced
  });
});
