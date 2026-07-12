import apiClient from '../apiClient';
import { fetchPlatforms } from './platforms';

/** One Secret Ingestion instance (AWS account) as offered by the prod/sandbox chooser. */
export interface SecretsInstance {
  key: string;
  label: string;
}

/**
 * The configured Secret Ingestion instances (family "secrets"), prod first. Derived from
 * GET /api/platforms — an unconfigured sandbox simply isn't registered, so it never appears.
 */
export const listSecretsInstances = async (): Promise<SecretsInstance[]> => {
  const platforms = await fetchPlatforms();
  return platforms
    .filter((p) => p.family === 'secrets')
    .map((p) => ({ key: p.key, label: p.label || p.displayName }))
    // Prod ("secrets") first, then the rest alphabetically for a stable chooser order.
    .sort((a, b) => (a.key === 'secrets' ? -1 : b.key === 'secrets' ? 1 : a.key.localeCompare(b.key)));
};

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

export type InfraManifestFormat = 'helm-values' | 'spc';

/** A manifest the auto-scan found, with the keys a request would add to it (compose preview). */
export interface InfraTargetPreview {
  path: string;
  env: string;
  format: InfraManifestFormat;
  manifestRef: string;
  keysToAdd: string[];
  /** True when this file references the secret but its expected key-list structure could not
   *  be located — the key was NOT registered here, distinct from genuinely up to date. */
  unmatched?: boolean;
}

export interface InfraPreviewResult {
  secretName: string;
  targets: InfraTargetPreview[];
}

/** The requester's final file selection, sent on submit. */
export interface InfraTargetSelection {
  path: string;
  manifestRef?: string;
  format?: InfraManifestFormat;
  /** Exact keys to apply to THIS file — a subset of its keysToAdd. Omitted = apply all. */
  keys?: string[];
  /** The env this path resolved to at compose time — carried through so the review queue
   *  badges the SAME env the requester saw. Optional: rows from before this field existed
   *  have none and callers should fall back to envOf(path). */
  env?: string;
}

export interface SecretIngestionRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  groupId: string | null;
  /** Which instance (AWS account) the request targets: "secrets" (prod + QA) or "secrets-sandbox". */
  platform: string;
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
  // infra-deployment PR mirror
  infraPrNumber?: number | null;
  infraPrUrl?: string | null;
  infraSyncState?: 'OPEN' | 'MERGED' | 'CLOSED' | 'SKIPPED' | 'FAILED' | null;
  infraSyncNote?: string | null;
  infraTargets?: InfraTargetSelection[] | null;
}

// Every read/submit is scoped to one instance via `?platform=` / a body field. Omitting it
// targets prod ("secrets"); the reviewer inbox (listIngestionRequests scope 'review' with no
// platform) intentionally merges the whole family so an admin sees both accounts in one list.

export const getSecretScope = (platform?: string): Promise<SecretScopeEntry[]> =>
  apiClient.get('/api/secrets/scope', { params: platform ? { platform } : {} }).then((r) => r.data);

export const listSecretKeys = (name: string, platform?: string): Promise<SecretKeysResult> =>
  apiClient.get('/api/secrets/keys', { params: { name, ...(platform ? { platform } : {}) } }).then((r) => r.data);

export const previewInfraTargets = (secretName: string, keys: string[], platform?: string): Promise<InfraPreviewResult> =>
  apiClient.post('/api/secrets/requests/infra-preview', { secretName, keys, ...(platform ? { platform } : {}) }).then((r) => r.data);

export const submitIngestionRequest = (payload: {
  secretName: string;
  justification?: string;
  entries: { key: string; value: string }[];
  infraTargets?: InfraTargetSelection[];
  platform?: string;
}): Promise<SecretIngestionRequest> =>
  apiClient.post('/api/secrets/requests', payload).then((r) => r.data);

export const listIngestionRequests = (scope: 'mine' | 'review', platform?: string): Promise<SecretIngestionRequest[]> =>
  apiClient.get('/api/secrets/requests', { params: { scope, ...(platform ? { platform } : {}) } }).then((r) => r.data);

export const reviewIngestionRequest = (
  id: string,
  payload: { decisions: { key: string; decision: 'APPROVED' | 'REJECTED' }[]; note?: string }
): Promise<SecretIngestionRequest> =>
  apiClient.put(`/api/secrets/requests/${id}/review`, payload).then((r) => r.data);
