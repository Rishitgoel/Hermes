import apiClient from '../apiClient';

/**
 * ZooKeeper config-management API. All reads are scoped server-side to the caller's
 * active ZK grants; all writes go through the approval flow (submit → admin review →
 * apply). apiClient unwraps the response envelope, so each call resolves to the payload.
 */

export interface ZkScopePath {
  path: string;
  perms: string;
  canWrite: boolean;
}

export interface ZkScopeEntry {
  groupId: string;
  groupName: string;
  levelId: string | null;
  levelName: string | null;
  paths: ZkScopePath[];
}

export interface ZkBrowseChild {
  name: string;
  path: string;
  isFolder: boolean;
  value: string | null;
  canWrite: boolean;
}

export interface ZkBrowseResult {
  path: string;
  data: string | null;
  canWrite: boolean;
  children: ZkBrowseChild[];
}

export type ZkChangeAction = 'SET' | 'CREATE' | 'DELETE' | 'CLEAR';
export type ZkChangeDecision = 'APPROVED' | 'REJECTED';

export interface ZkChange {
  path: string;
  action: ZkChangeAction;
  oldValue?: string | null;
  newValue?: string | null;
  /** Owning group (resolved server-side at submit). */
  groupId?: string;
  groupName?: string;
  /** Reviewer's per-change decision (null until reviewed). */
  decision?: ZkChangeDecision | null;
  applied?: boolean;
  error?: string | null;
}

export type ZkChangeStatus = 'PENDING' | 'APPLYING' | 'APPLIED' | 'PARTIALLY_APPLIED' | 'APPLY_FAILED' | 'REJECTED';

export interface ZkChangeRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  groupId: string | null;
  /** Every group whose paths this request touches. */
  groupIds: string[];
  status: ZkChangeStatus;
  changes: ZkChange[];
  justification: string | null;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  applyError: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getZkScope = (): Promise<ZkScopeEntry[]> =>
  apiClient.get('/api/zookeeper/scope').then((r) => r.data);

export const browseZkNode = (path: string): Promise<ZkBrowseResult> =>
  apiClient.get('/api/zookeeper/nodes', { params: { path } }).then((r) => r.data);

export const exportZkSubtree = (path: string): Promise<{ path: string; content: string }> =>
  apiClient.get('/api/zookeeper/export', { params: { path } }).then((r) => r.data);

export const submitZkChangeRequest = (payload: {
  justification?: string;
  changes: ZkChange[];
}): Promise<ZkChangeRequest[]> =>
  apiClient.post('/api/zookeeper/requests', payload).then((r) => r.data);

export const listZkChangeRequests = (scope: 'mine' | 'review'): Promise<ZkChangeRequest[]> =>
  apiClient.get('/api/zookeeper/requests', { params: { scope } }).then((r) => r.data);

export const reviewZkChangeRequest = (
  id: string,
  payload: { decisions: { path: string; decision: ZkChangeDecision }[]; note?: string },
): Promise<ZkChangeRequest> =>
  apiClient.put(`/api/zookeeper/requests/${id}/review`, payload).then((r) => r.data);
