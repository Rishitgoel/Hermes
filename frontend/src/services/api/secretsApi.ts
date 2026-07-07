import apiClient from '../apiClient';

export interface SecretScopeEntry {
  groupId: string;
  groupName: string;
  secretNames: string[];
}

export interface SecretKeysResult {
  exists: boolean;
  keys: string[];
  /** false ⇒ the secret exists but its payload is not key-value JSON (not mergeable). */
  keyValueFormat?: boolean;
}

export interface SecretIngestionEntry {
  key: string;
  /** null once the request is terminal — values are redacted server-side. */
  value: string | null;
  decision?: 'APPROVED' | 'REJECTED' | null;
  applied?: boolean;
  error?: string | null;
  /**
   * Live AWS value at the time the review queue was loaded (review scope only).
   * null = key doesn't exist yet (this entry is an ADD). undefined = unknown
   * (e.g. the secret isn't key-value JSON, or this isn't the review scope).
   */
  previousValue?: string | null;
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
