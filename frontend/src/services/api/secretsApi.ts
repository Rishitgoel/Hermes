import apiClient from '../apiClient';

export interface SecretScopeEntry {
  groupId: string;
  groupName: string;
  secretNames: string[];
}

export interface SecretKeysResult {
  exists: boolean;
  keys: string[];
}

export interface SecretIngestionEntry {
  key: string;
  value: string;
  decision?: 'APPROVED' | 'REJECTED' | null;
  applied?: boolean;
  error?: string | null;
}

export type SecretIngestionStatus = 'PENDING' | 'APPLYING' | 'APPLIED' | 'PARTIALLY_APPLIED' | 'APPLY_FAILED' | 'REJECTED';

export interface SecretIngestionRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  groupId: string | null;
  secretName: string;
  entries: SecretIngestionEntry[];
  justification: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  applyError: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: SecretIngestionStatus;
}

export const getSecretScope = (): Promise<SecretScopeEntry[]> =>
  apiClient.get('/api/secrets/scope').then((r) => r.data);

export const listSecretKeys = (name: string): Promise<SecretKeysResult> =>
  apiClient.get('/api/secrets/keys', { params: { name } }).then((r) => r.data);

export const submitIngestionRequest = (payload: {
  secretName: string;
  justification?: string;
  entries: { key: string; value: string }[];
}): Promise<SecretIngestionRequest> =>
  apiClient.post('/api/secrets/requests', payload).then((r) => r.data);

export const listIngestionRequests = (scope: 'mine' | 'review'): Promise<SecretIngestionRequest[]> =>
  apiClient.get('/api/secrets/requests', { params: { scope } }).then((r) => r.data);

export const reviewIngestionRequest = (
  id: string,
  payload: { decisions: { key: string; decision: 'APPROVED' | 'REJECTED' }[]; note?: string }
): Promise<SecretIngestionRequest> =>
  apiClient.put(`/api/secrets/requests/${id}/review`, payload).then((r) => r.data);
