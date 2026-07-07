import prisma from '../config/prisma';
import zookeeperService, { normalizePerms } from './zookeeper.service';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import { isSuperAdmin, isPlatformAdminOf } from '../utils/authz';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../utils/errors';

const PLATFORM = 'zookeeper';

export type ZkChangeAction = 'SET' | 'CREATE' | 'DELETE' | 'CLEAR';
export type ZkChangeDecision = 'APPROVED' | 'REJECTED';

/** One staged change. The owning group + per-change decision are snapshotted server-side. */
export interface ZkChange {
  path: string;
  action: ZkChangeAction;
  oldValue?: string | null;
  newValue?: string | null;
  /** The group whose paths cover this change (snapshotted at submit for routing/display). */
  groupId?: string;
  groupName?: string;
  /** Reviewer's per-change decision (null until reviewed). */
  decision?: ZkChangeDecision | null;
  applied?: boolean;
  error?: string | null;
}

export interface ZkBrowseChild {
  name: string;
  path: string;
  isFolder: boolean;
  value: string | null;
  canWrite: boolean;
}

export interface ZkScopeEntry {
  groupId: string;
  groupName: string;
  levelId: string | null;
  levelName: string | null;
  paths: { path: string; perms: string; canWrite: boolean }[];
}

/** One granted (group, path, perms) target — the unit grant resolution works on. */
interface ZkGrantTarget {
  groupId: string;
  groupName: string;
  levelId: string | null;
  levelName: string | null;
  path: string;
  perms: string;
}

type FinalStatus =
  | 'APPLIED'
  | 'PARTIALLY_APPLIED'
  | 'APPLY_FAILED'
  | 'REJECTED';

/**
 * Business logic for approval-based ZooKeeper config management. ALL authorization is
 * here, computed from the user's **active grants** (the platform cache stores only bare
 * paths, no perms, so read-vs-write must come from the grant's `externalGroupId#perms`).
 *
 * Multi-group: a user in several ZK groups browses the UNION of their paths, and a single
 * change request may touch paths from several groups — each change is routed to its owning
 * group, the request is reviewable by the admins of any involved group, and reviewers
 * decide each change independently.
 *
 * ⚠ Reads run through {@link zookeeperService}'s privileged admin connection, which holds
 * ADMIN on every managed node — so ZooKeeper's per-node ACLs do NOT scope these reads.
 * This service is the enforcement point: every browse/export/submit is filtered against
 * the caller's resolved grant paths before any ZooKeeper call that would expose data.
 */
export class ZookeeperConfigService {
  // ── Grant resolution & path predicates ──────────────────────────────────────────

  private unionPerms(a: string, b: string): string {
    return normalizePerms(a + b);
  }

  private isAtOrUnder(node: string, ancestor: string): boolean {
    return zookeeperService.isAtOrUnder(node, ancestor);
  }

  /** Every (group, path, perms) the user holds via active ZooKeeper grants. */
  private async resolveUserGrantTargets(
    userId: string,
  ): Promise<ZkGrantTarget[]> {
    const grants = await prisma.userAccess.findMany({
      where: { userId, isActive: true, group: { platform: PLATFORM } },
      include: { group: true, level: true },
      orderBy: { grantedAt: 'desc' },
    });
    const out: ZkGrantTarget[] = [];
    for (const g of grants) {
      const externalGroupId =
        g.level?.externalGroupId ?? g.group.externalGroupId;
      if (!externalGroupId) {continue;}
      let targets: { path: string; perms: string }[] = [];
      try {
        targets = zookeeperService.parseExternalGroupIds(externalGroupId);
      } catch {
        continue;
      }
      for (const t of targets) {
        out.push({
          groupId: g.groupId,
          groupName: g.group.name,
          levelId: g.levelId,
          levelName: g.level?.name ?? null,
          path: t.path,
          perms: t.perms,
        });
      }
    }
    return out;
  }

  /** The user's effective `path → perms` (UNION across all active grants). */
  async resolveUserZkPaths(userId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const t of await this.resolveUserGrantTargets(userId)) {
      const prev = map.get(t.path);
      map.set(t.path, prev ? this.unionPerms(prev, t.perms) : t.perms);
    }
    return map;
  }

  private readable(path: string, G: Map<string, string>): boolean {
    for (const g of G.keys()) {
      if (this.isAtOrUnder(path, g) || this.isAtOrUnder(g, path)) {return true;}
    }
    return false;
  }

  private writable(path: string, G: Map<string, string>): boolean {
    for (const [g, perms] of G.entries()) {
      const hasMutatingPerm =
        perms.includes('c') || perms.includes('d') || perms.includes('w');
      if (hasMutatingPerm && this.isAtOrUnder(path, g)) {return true;}
    }
    return false;
  }

  private requiredPermForAction(action: ZkChangeAction): string {
    switch (action) {
      case 'CREATE':
        return 'c';
      case 'DELETE':
        return 'd';
      case 'SET':
      case 'CLEAR':
        return 'w';
      default:
        return 'w';
    }
  }

  /** The user's write-granting group that most specifically covers `path` (deepest grant
   *  path; ties broken by groupId for determinism). null ⇒ no write coverage. */
  private owningGroup(
    targets: ZkGrantTarget[],
    path: string,
    action: ZkChangeAction,
  ): ZkGrantTarget | null {
    const requiredPerm = this.requiredPermForAction(action);
    const candidates = targets.filter(
      t => t.perms.includes(requiredPerm) && this.isAtOrUnder(path, t.path),
    );
    if (candidates.length === 0) {return null;}
    candidates.sort(
      (a, b) =>
        b.path.split('/').length - a.path.split('/').length ||
        a.groupId.localeCompare(b.groupId),
    );
    return candidates[0];
  }

  // ── Scope / browse / export ──────────────────────────────────────────────────────

  /** The user's active ZK groups + resolved paths — seeds the browse roots + diff display. */
  async getUserScope(userId: string): Promise<ZkScopeEntry[]> {
    const byGroup = new Map<string, ZkScopeEntry>();
    for (const t of await this.resolveUserGrantTargets(userId)) {
      let entry = byGroup.get(t.groupId);
      if (!entry) {
        entry = {
          groupId: t.groupId,
          groupName: t.groupName,
          levelId: t.levelId,
          levelName: t.levelName,
          paths: [],
        };
        byGroup.set(t.groupId, entry);
      }
      entry.paths.push({
        path: t.path,
        perms: t.perms,
        canWrite: t.perms.includes('w'),
      });
    }
    return [...byGroup.values()];
  }

  async browseNode(
    userId: string,
    path: string,
  ): Promise<{
    path: string;
    data: string | null;
    canWrite: boolean;
    children: ZkBrowseChild[];
  }> {
    const p = (path || '').trim();
    if (!p.startsWith('/'))
      {throw new ValidationError('A ZooKeeper path must start with "/".');}
    if (zookeeperService.isReservedPath(p))
      {throw new AuthorizationError('That ZooKeeper path is reserved.');}

    const G = await this.resolveUserZkPaths(userId);
    if (!this.readable(p, G))
      {throw new AuthorizationError(
        'You do not have access to this ZooKeeper path.',
      );}

    const [data, childNames] = await Promise.all([
      zookeeperService.getData(p),
      zookeeperService.getChildren(p),
    ]);

    const children = (
      await Promise.all(
        childNames.map(async (name): Promise<ZkBrowseChild | null> => {
          const childPath = p === '/' ? `/${name}` : `${p}/${name}`;
          if (!this.readable(childPath, G)) {return null;}
          const [grandkids, value] = await Promise.all([
            zookeeperService.getChildren(childPath),
            zookeeperService.getData(childPath),
          ]);
          return {
            name,
            path: childPath,
            isFolder: grandkids.length > 0,
            value,
            canWrite: this.writable(childPath, G),
          };
        }),
      )
    ).filter((c): c is ZkBrowseChild => c !== null);

    return { path: p, data, canWrite: this.writable(p, G), children };
  }

  async exportSubtree(userId: string, path: string): Promise<string> {
    const p = (path || '').trim();
    if (!p.startsWith('/'))
      {throw new ValidationError('A ZooKeeper path must start with "/".');}
    const G = await this.resolveUserZkPaths(userId);
    if (![...G.keys()].some(g => this.isAtOrUnder(p, g))) {
      throw new AuthorizationError(
        'You can only export within your granted ZooKeeper paths.',
      );
    }
    const nodes = [p, ...(await zookeeperService.descendantPaths(p))];
    const readableNodes = nodes.filter(node => this.readable(node, G));
    const values = await Promise.all(
      readableNodes.map(node => zookeeperService.getData(node)),
    );
    const lines: string[] = [];
    for (let i = 0; i < readableNodes.length; i++) {
      const value = values[i];
      if (value === null) {continue;}
      lines.push(JSON.stringify({ path: readableNodes[i], value }));
    }
    return lines.join('\n');
  }

  // ── Change requests ───────────────────────────────────────────────────────────────

  /**
   * Stage a batch of changes as a PENDING request. The target group is resolved
   * automatically per change (no group picker): each change is routed to the user's
   * write-granting group that most specifically covers its path. A request may span
   * several groups — the admins of all involved groups can review it.
   */
  async createChangeRequest(args: {
    requester: { id: string; username: string; email: string };
    changes: ZkChange[];
    justification?: string;
  }) {
    const { requester, changes, justification } = args;
    if (!Array.isArray(changes) || changes.length === 0)
      {throw new ValidationError('No changes to submit.');}

    const targets = await this.resolveUserGrantTargets(requester.id);
    if (targets.length === 0)
      {throw new AuthorizationError(
        'You are not a member of any ZooKeeper group.',
      );}

    const stagedExists = new Map<string, boolean>();
    const getStagedExists = async (path: string): Promise<boolean> => {
      if (stagedExists.has(path)) {return stagedExists.get(path)!;}
      const res = await zookeeperService.exists(path);
      stagedExists.set(path, res);
      return res;
    };

    const resolved: ZkChange[] = [];
    for (const c of changes) {
      if (!c.path || !c.path.startsWith('/'))
        {throw new ValidationError(`Invalid path "${c.path}".`);}
      if (zookeeperService.isReservedPath(c.path))
        {throw new ValidationError(`Path "${c.path}" is reserved.`);}
      const owner = this.owningGroup(targets, c.path, c.action);
      if (!owner)
        {throw new AuthorizationError(
          `You don't have permission to perform ${c.action} on "${c.path}".`,
        );}

      const exists = await getStagedExists(c.path);
      if (c.action === 'CREATE') {
        if (exists) {
          throw new ValidationError(
            `Node "${c.path}" already exists. Please submit a SET change to update its value instead.`,
          );
        }
        stagedExists.set(c.path, true);
      } else {
        if (!exists) {
          throw new ValidationError(
            `Node "${c.path}" does not exist. Please submit a CREATE change to create it.`,
          );
        }
        if (c.action === 'DELETE') {
          stagedExists.set(c.path, false);
        }
      }

      resolved.push({
        path: c.path,
        action: c.action,
        oldValue: c.oldValue ?? null,
        newValue: c.newValue ?? null,
        groupId: owner.groupId,
        groupName: owner.groupName,
        decision: null,
        applied: false,
      });
    }

    const changesByGroup = new Map<string, ZkChange[]>();
    for (const c of resolved) {
      const gid = c.groupId!;
      const list = changesByGroup.get(gid) || [];
      list.push(c);
      changesByGroup.set(gid, list);
    }

    const rows = await prisma.$transaction(async tx => {
      const createdRequests = [];
      for (const [gid, groupChanges] of changesByGroup.entries()) {
        const row = await tx.zookeeperChangeRequest.create({
          data: {
            requesterId: requester.id,
            requesterName: requester.username,
            requesterEmail: requester.email,
            groupId: gid,
            groupIds: [gid],
            status: 'PENDING',
            changes: groupChanges as any,
            justification: justification?.trim() || null,
          },
        });

        await tx.auditEntry.create({
          data: {
            action: 'ZK_CHANGE_SUBMITTED',
            performerId: requester.id,
            performerName: requester.username,
            groupId: gid,
            details: {
              requestId: row.id,
              changeCount: groupChanges.length,
              groupIds: [gid],
              groupName: groupChanges[0]?.groupName ?? null,
              justification: justification?.trim() || null,
              changes: groupChanges,
            } as any,
          },
        });

        createdRequests.push(row);
      }
      return createdRequests;
    });

    for (const row of rows) {
      const groupChanges = row.changes as unknown as ZkChange[];
      eventBus.emitAccessEvent({
        type: 'zk-change.submitted',
        payload: {
          requestId: row.id,
          groupIds: row.groupIds,
          groupNames: [groupChanges[0].groupName!],
          requesterName: requester.username,
          justification: row.justification,
          changeCount: groupChanges.length,
        },
        timestamp: new Date(),
      });
    }

    return rows;
  }

  /** Group ids a non-super/non-platform admin may review (their ZK GroupAdmin rows). */
  async reviewableGroupIds(
    user: AuthenticatedUser,
  ): Promise<{ all: boolean; groupIds: string[] }> {
    if (isSuperAdmin(user) || (await isPlatformAdminOf(user, PLATFORM)))
      {return { all: true, groupIds: [] };}
    const rows = await prisma.groupAdmin.findMany({
      where: { userId: user.id },
      include: { group: { select: { platform: true } } },
    });
    return {
      all: false,
      groupIds: rows
        .filter(r => r.group.platform === PLATFORM)
        .map(r => r.groupId),
    };
  }

  /** `scope='mine'` → the caller's own; `scope='review'` → requests awaiting review
   *  (PENDING, plus retryable APPLY_FAILED — recovered/failed applies must re-surface in
   *  the review queue or they'd be stranded) touching any group the caller can review. */
  async listChangeRequests(user: AuthenticatedUser, scope: 'mine' | 'review') {
    if (scope === 'mine') {
      return prisma.zookeeperChangeRequest.findMany({
        where: { requesterId: user.id },
        orderBy: { createdAt: 'desc' },
        // Cap the personal history — long-lived users accumulate rows forever.
        take: 200,
      });
    }
    const { all, groupIds } = await this.reviewableGroupIds(user);
    if (!all && groupIds.length === 0) {return [];}
    return prisma.zookeeperChangeRequest.findMany({
      where: {
        status: { in: ['PENDING', 'APPLY_FAILED'] },
        ...(all ? {} : { groupIds: { hasSome: groupIds } }),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(id: string) {
    return prisma.zookeeperChangeRequest.findUnique({ where: { id } });
  }

  /**
   * Recover requests orphaned mid-apply. `APPLYING` is a transient state with no resting
   * point: if the process dies (crash / redeploy) between claiming a request and writing
   * its terminal status, the row is stranded — never re-listed for review, never terminal.
   * A periodic sweep flips any `APPLYING` row untouched for longer than `maxAgeMs` to
   * `APPLY_FAILED` (retryable) so an admin can re-review it. Keyed off `updatedAt`, which is
   * bumped to the claim time when the request enters APPLYING and not touched again while
   * stuck. The conditional `updateMany` is race-safe: a legitimately-finishing apply that
   * writes its terminal status first leaves the row out of the next sweep. Returns the count.
   */
  async sweepStuckApplying(maxAgeMs: number = 10 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const result = await prisma.zookeeperChangeRequest.updateMany({
      where: { status: 'APPLYING', updatedAt: { lt: cutoff } },
      data: {
        status: 'APPLY_FAILED',
        applyError:
          'Apply did not complete (process interrupted); recovered by sweep — re-review to retry.',
      },
    });
    if (result.count > 0) {
      logger.warn(
        { count: result.count },
        'Recovered ZooKeeper change requests stuck in APPLYING',
      );
    }
    return result.count;
  }

  /** Can `user` review this request? Super / ZK platform admin / group admin of ANY
   *  involved group. Used by the controller before delegating here. */
  async canReview(
    user: AuthenticatedUser,
    request: { groupIds: string[] },
  ): Promise<boolean> {
    const { all, groupIds } = await this.reviewableGroupIds(user);
    if (all) {return true;}
    return request.groupIds.some(g => groupIds.includes(g));
  }

  /**
   * Review a request with PER-CHANGE decisions (git-style). Approved changes are applied;
   * everything else (explicitly rejected, or not listed) is rejected. APPLY_FAILED is
   * retryable — re-review is allowed from that status too (the sweep recovers crashed
   * applies into it), so a failed apply can't strand the request. On retry, changes that
   * already applied on a previous attempt are locked APPROVED and not re-applied (they
   * cannot be un-applied; re-running a SET would also trip its lost-update guard).
   */
  async reviewChangeRequest(
    requestId: string,
    reviewer: { id: string; username: string },
    decisions: { path: string; decision: ZkChangeDecision }[],
    note?: string,
  ) {
    const row = await prisma.zookeeperChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {throw new NotFoundError('Change request not found');}
    if (row.status !== 'PENDING' && row.status !== 'APPLY_FAILED')
      {throw new ValidationError(
        `Request is not pending or retryable (status: ${row.status}).`,
      );}

    const result = await prisma.zookeeperChangeRequest.updateMany({
      where: { id: requestId, status: { in: ['PENDING', 'APPLY_FAILED'] } },
      data: {
        status: 'APPLYING',
        reviewerId: reviewer.id,
        reviewerName: reviewer.username,
        reviewNote: note ?? null,
        reviewedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new ConflictError(
        'This change request is already being reviewed or applied by another admin.',
      );
    }

    const decisionByPath = new Map(decisions.map(d => [d.path, d.decision]));
    const changes = ((row.changes as unknown as ZkChange[]) ?? []).map(c => ({
      ...c,
    }));
    // Unlisted ⇒ rejected, so nothing is silently applied. Changes that already applied
    // on a previous attempt (APPLY_FAILED retry) are locked APPROVED — see doc above.
    for (const c of changes)
      {c.decision = c.applied
        ? 'APPROVED'
        : decisionByPath.get(c.path) === 'APPROVED'
          ? 'APPROVED'
          : 'REJECTED';}

    const backing = await this.backingPaths();
    let approved = 0;
    let applied = 0;
    let failed = 0;
    let rejected = 0;
    for (const c of changes) {
      if (c.decision !== 'APPROVED') {
        rejected++;
        c.applied = false;
        continue;
      }
      approved++;
      if (c.applied) {
        // Applied on a previous attempt — count it, don't re-apply.
        applied++;
        continue;
      }
      try {
        await this.applyOne(c, backing);
        c.applied = true;
        c.error = null;
        applied++;
      } catch (err: any) {
        c.applied = false;
        c.error = err.message;
        failed++;
        logger.warn(
          { requestId, path: c.path, action: c.action, error: err.message },
          'ZooKeeper applyOne failed',
        );
      }
    }

    let status: FinalStatus;
    if (failed > 0) {status = 'APPLY_FAILED';}
    else if (approved === 0) {status = 'REJECTED';}
    else if (rejected === 0) {status = 'APPLIED';}
    else {status = 'PARTIALLY_APPLIED';}

    const updated = await prisma.zookeeperChangeRequest.update({
      where: { id: row.id },
      data: {
        status,
        changes: changes as any,
        // A fully-rejected request never touched ZooKeeper — don't stamp an apply time.
        appliedAt: status === 'REJECTED' ? null : new Date(),
        applyError: failed
          ? `${failed} approved change(s) failed to apply`
          : null,
      },
    });

    await prisma.auditEntry.create({
      data: {
        action: `ZK_CHANGE_${status}`,
        performerId: reviewer.id,
        performerName: reviewer.username,
        groupId: row.groupId,
        details: {
          requestId: row.id,
          approved,
          applied,
          rejected,
          failed,
          reviewNote: note ?? null,
          justification: row.justification ?? null,
          changes,
        } as any,
      },
    });

    eventBus.emitAccessEvent({
      type: 'zk-change.reviewed',
      payload: {
        requestId: row.id,
        requesterId: row.requesterId,
        requesterEmail: row.requesterEmail,
        groupNames: [...new Set(changes.map(c => c.groupName).filter(Boolean))],
        reviewerName: reviewer.username,
        note,
        approved,
        rejected,
        status,
      },
      timestamp: new Date(),
    });

    return updated;
  }

  /** Backing paths of every ZK group/level — DELETE must never remove one. */
  private async backingPaths(): Promise<Set<string>> {
    const [groups, levels] = await Promise.all([
      prisma.group.findMany({
        where: { platform: PLATFORM, externalGroupId: { not: null } },
        select: { externalGroupId: true },
      }),
      prisma.groupLevel.findMany({
        where: {
          group: { platform: PLATFORM },
          externalGroupId: { not: null },
        },
        select: { externalGroupId: true },
      }),
    ]);
    const set = new Set<string>();
    for (const g of [...groups, ...levels]) {
      if (!g.externalGroupId) {continue;}
      try {
        for (const t of zookeeperService.parseExternalGroupIds(
          g.externalGroupId,
        ))
          {set.add(t.path);}
      } catch {
        /* malformed mapping isn't a valid DELETE target anyway */
      }
    }
    return set;
  }

  /** Apply one approved change to ZooKeeper. Throws on failure (caller records per-change). */
  private async applyOne(c: ZkChange, backing: Set<string>): Promise<void> {
    switch (c.action) {
      case 'CREATE':
        await zookeeperService.createNodeRecursive(c.path);
        await zookeeperService.setData(c.path, c.newValue ?? '');
        break;
      case 'SET': {
        // Lost-update guard: ALWAYS compare the node's current value to the value the
        // requester saw when drafting (`oldValue`). Gating this on `oldValue != null`
        // skipped the check for a node that was empty/absent at draft time, letting an
        // approved SET silently clobber whatever someone else wrote in the meantime.
        // `getData` returns null for an empty/missing node, so treat null and "" as the
        // same empty state.
        const current = (await zookeeperService.getData(c.path)) ?? '';
        const drafted = c.oldValue ?? '';
        if (current !== drafted) {
          throw new Error(
            `value changed since draft (expected "${drafted}", found "${current}")`,
          );
        }
        await zookeeperService.setData(c.path, c.newValue ?? '');
        break;
      }
      case 'CLEAR':
        await zookeeperService.setData(c.path, '');
        break;
      case 'DELETE':
        if (backing.has(c.path))
          {throw new Error(
            'path backs a Hermes group/level — clear it instead of deleting',
          );}
        await zookeeperService.deleteNode(c.path);
        break;
      default:
        throw new Error(`unknown action "${(c as ZkChange).action}"`);
    }
  }
}

export const zookeeperConfigService = new ZookeeperConfigService();
export default zookeeperConfigService;
