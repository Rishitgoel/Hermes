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

  it('re-links a group whose backing group was recreated under a new id, instead of archiving it', async () => {
    const g = await seedGroup({ isActive: false }); // archived by a previous run; ext-growth is dead
    await seedCache([cacheRow('ext-growth-NEW', 'Growth')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const after = await prisma.group.findUnique({ where: { id: g.id } });
    expect(after!.externalGroupId).toBe('ext-growth-NEW');
    expect(after!.isActive).toBe(true);
    expect(await prisma.group.count()).toBe(1); // no duplicate created
    const audit = await prisma.auditEntry.findFirst({ where: { action: 'GROUP_UPDATED', groupId: g.id } });
    expect((audit!.details as any).relinkedTo).toBe('ext-growth-NEW');
  });

  it('re-links a level by the "<Group> — <Level>" convention and reactivates it and its parent', async () => {
    const g = await seedGroup({ name: 'Credit Card', slug: 'credit-card', externalGroupId: null, isActive: false });
    const level = await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Admin', slug: 'admin', externalGroupId: 'ext-dead', rank: 3, isActive: false, createdAt: OLD },
    });
    await seedCache([cacheRow('ext-cc-admin-NEW', 'Credit Card — Admin')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const afterLevel = await prisma.groupLevel.findUnique({ where: { id: level.id } });
    expect(afterLevel!.externalGroupId).toBe('ext-cc-admin-NEW');
    expect(afterLevel!.isActive).toBe(true);
    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(true);
    expect(await prisma.group.count()).toBe(1); // the level's backing group did NOT become a standalone group
  });

  it('level matching is dash- and case-insensitive ("Credit Card - admin" matches level Admin of Credit Card)', async () => {
    const g = await seedGroup({ name: 'Credit Card', slug: 'credit-card', externalGroupId: null });
    const level = await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Admin', slug: 'admin', externalGroupId: 'ext-dead', rank: 3, createdAt: OLD },
    });
    await seedCache([cacheRow('ext-new', 'credit card - ADMIN')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect((await prisma.groupLevel.findUnique({ where: { id: level.id } }))!.externalGroupId).toBe('ext-new');
    expect(await prisma.group.count()).toBe(1);
  });

  it('deletes the pristine duplicate a previous sync auto-created when a level reclaims its backing group', async () => {
    // Parent group with a level pointing at a dead id...
    const g = await seedGroup({ name: 'Credit Card', slug: 'credit-card', externalGroupId: null, isActive: false });
    const level = await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Admin', slug: 'admin', externalGroupId: 'ext-dead', rank: 3, isActive: false, createdAt: OLD },
    });
    // ...and the stray standalone group a previous (buggy) sync created for the
    // level's recreated backing group, marked by its system GROUP_CREATED audit.
    const stray = await seedGroup({ name: 'Credit Card — Admin', slug: 'credit-card-admin', externalGroupId: 'ext-cc-admin-NEW' });
    await prisma.auditEntry.create({
      data: { action: 'GROUP_CREATED', performerId: 'system', performerName: 'Platform Sync', groupId: stray.id },
    });
    await seedCache([cacheRow('ext-cc-admin-NEW', 'Credit Card — Admin')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.findUnique({ where: { id: stray.id } })).toBeNull(); // duplicate gone
    const afterLevel = await prisma.groupLevel.findUnique({ where: { id: level.id } });
    expect(afterLevel!.externalGroupId).toBe('ext-cc-admin-NEW');
    expect(afterLevel!.isActive).toBe(true);
    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(true);
    const delAudit = await prisma.auditEntry.findFirst({ where: { action: 'GROUP_DELETED' } });
    expect(delAudit).not.toBeNull();
  });

  it('does NOT delete an admin-created group to heal a level (only sync-created pristine duplicates)', async () => {
    const g = await seedGroup({ name: 'Credit Card', slug: 'credit-card', externalGroupId: null });
    const level = await prisma.groupLevel.create({
      data: { groupId: g.id, name: 'Admin', slug: 'admin', externalGroupId: 'ext-dead', rank: 3, createdAt: OLD },
    });
    // Same name + claims the candidate id, but created by an admin (no system audit).
    const adminGroup = await seedGroup({ name: 'Credit Card — Admin', slug: 'credit-card-admin', externalGroupId: 'ext-cc-admin-NEW' });
    await seedCache([cacheRow('ext-cc-admin-NEW', 'Credit Card — Admin')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.findUnique({ where: { id: adminGroup.id } })).not.toBeNull();
    // Level stays broken (and gets deactivated) rather than stealing an admin-owned mapping.
    const afterLevel = await prisma.groupLevel.findUnique({ where: { id: level.id } });
    expect(afterLevel!.externalGroupId).toBe('ext-dead');
    expect(afterLevel!.isActive).toBe(false);
  });

  it('imports "<Group> — <Level>" platform groups as levels, not standalone groups', async () => {
    await seedCache([
      cacheRow('ext-cc', 'Credit Card'),
      cacheRow('ext-cc-admin', 'Credit Card — Admin'),
      cacheRow('ext-cc-senior', 'Credit Card — Senior Dev'),
    ]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    const groups = await prisma.group.findMany({ include: { levels: true } });
    expect(groups).toHaveLength(1); // ONE group...
    expect(groups[0].name).toBe('Credit Card');
    expect(groups[0].externalGroupId).toBe('ext-cc');
    // ...with the dashed names as its levels. Sort by name in JS so the assertion is
    // order-independent: reconciliation assigns the two auto-created levels their ranks
    // in platform-cache read order, which Postgres does not guarantee.
    expect(
      groups[0].levels
        .map((l) => ({ name: l.name, ext: l.externalGroupId, active: l.isActive }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'Admin', ext: 'ext-cc-admin', active: true },
      { name: 'Senior Dev', ext: 'ext-cc-senior', active: true },
    ]);
  });

  it('attaches a new "<Group> — <Level>" platform group as a level of an existing Hermes group', async () => {
    const g = await seedGroup({ name: 'Credit Card', slug: 'credit-card', externalGroupId: 'ext-cc' });
    await seedCache([cacheRow('ext-cc', 'Credit Card'), cacheRow('ext-cc-admin', 'Credit Card — Admin')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.count()).toBe(1);
    const levels = await prisma.groupLevel.findMany({ where: { groupId: g.id } });
    expect(levels).toHaveLength(1);
    expect(levels[0].name).toBe('Admin');
    expect(levels[0].externalGroupId).toBe('ext-cc-admin');
  });

  it('converts a stray sync-created "<Group> — <Level>" group back into a level of its parent', async () => {
    // The exact mess the old sync left behind: parent group + dashed standalone groups.
    const parent = await seedGroup({ name: 'Credit Card', slug: 'redash-credit-card', externalGroupId: '8' });
    const strayAdmin = await seedGroup({ name: 'Credit Card — Admin', slug: 'credit-card-admin', externalGroupId: '9' });
    const straySenior = await seedGroup({ name: 'Credit Card — Senior Dev', slug: 'credit-card-senior-dev', externalGroupId: '10' });
    for (const stray of [strayAdmin, straySenior]) {
      await prisma.auditEntry.create({
        data: { action: 'GROUP_CREATED', performerId: 'system', performerName: 'Platform Sync', groupId: stray.id },
      });
    }
    await seedCache([
      cacheRow('8', 'Credit Card'),
      cacheRow('9', 'Credit Card — Admin'),
      cacheRow('10', 'Credit Card — Senior Dev'),
    ]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.count()).toBe(1); // strays gone
    // Sort by name in JS so the assertion is order-independent: reconciliation assigns
    // the two auto-created levels their ranks in platform-cache read order, which
    // Postgres does not guarantee (this was an intermittently-failing assertion).
    const levels = await prisma.groupLevel.findMany({ where: { groupId: parent.id } });
    expect(
      levels
        .map((l) => ({ name: l.name, ext: l.externalGroupId, active: l.isActive }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'Admin', ext: '9', active: true },
      { name: 'Senior Dev', ext: '10', active: true },
    ]);
    expect(await prisma.auditEntry.count({ where: { action: 'GROUP_DELETED' } })).toBe(2);
  });

  it('does NOT convert an admin-created dashed group into a level', async () => {
    await seedGroup({ name: 'Credit Card', slug: 'credit-card', externalGroupId: '8' });
    // Dashed name, but created by an admin (no system GROUP_CREATED audit) — leave it alone.
    const adminGroup = await seedGroup({ name: 'Credit Card — Admin', slug: 'credit-card-admin', externalGroupId: '9' });
    await seedCache([cacheRow('8', 'Credit Card'), cacheRow('9', 'Credit Card — Admin')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect(await prisma.group.findUnique({ where: { id: adminGroup.id } })).not.toBeNull();
    expect(await prisma.groupLevel.count()).toBe(0);
  });

  it('does not reactivate an archived group whose backing group still exists (admin intent wins)', async () => {
    const g = await seedGroup({ isActive: false });
    await seedCache([cacheRow('ext-growth', 'Growth')]);

    await syncService.reconcileHermesGroups('aws', liveAdapter);

    expect((await prisma.group.findUnique({ where: { id: g.id } }))!.isActive).toBe(false);
    expect(await prisma.group.count()).toBe(1); // and no duplicate created — the mapping is referenced
  });
});
