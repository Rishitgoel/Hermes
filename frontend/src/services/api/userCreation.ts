import apiClient from '../apiClient';
import type { UserCreationInfo } from '../../contexts/AuthContext';

/**
 * Backend rows for the admin "User Approvals" table. Server-side shape from
 * GET /api/user-creation-requests/pending.
 */
export interface PendingUserCreationRequest {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** Which platform this account request is for ("redash", "aws", …). */
  platform: string;
  justification: string | null;
  status: 'PENDING';
  submittedAt: string | null;
  createdAt: string;
}

const enc = encodeURIComponent;

/** User submits their account request for a platform (DRAFT → PENDING, or creates PENDING). */
export async function submitUserCreationRequest(
  justification: string,
  platform: string = 'redash',
): Promise<UserCreationInfo> {
  const res = await apiClient.post('/api/user-creation-requests', { justification, platform });
  return res.data as UserCreationInfo;
}

/** Current user's account request for one platform (null if none yet). */
export async function getMyUserCreation(platform: string = 'redash'): Promise<UserCreationInfo | null> {
  const res = await apiClient.get(`/api/user-creation-requests/me?platform=${enc(platform)}`);
  return (res.data as UserCreationInfo | null) ?? null;
}

/** Current user's account requests across all platforms. */
export async function getMyUserCreations(): Promise<UserCreationInfo[]> {
  const res = await apiClient.get('/api/user-creation-requests/me/all');
  return (res.data as UserCreationInfo[]) ?? [];
}

/** Admin: list all PENDING user-creation requests (across platforms). */
export async function listPendingUserCreations(): Promise<PendingUserCreationRequest[]> {
  const res = await apiClient.get('/api/user-creation-requests/pending');
  return res.data as PendingUserCreationRequest[];
}

/** Admin: approve or reject a user-creation request (keyed on id; platform comes from the row). */
export async function reviewUserCreation(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<UserCreationInfo> {
  const res = await apiClient.put(`/api/user-creation-requests/${id}/review`, { status, note });
  return res.data as UserCreationInfo;
}

/** User: re-trigger the setup invite for a platform (Redash only — AWS emails its own). */
export async function resendInvite(platform: string = 'redash'): Promise<UserCreationInfo> {
  const res = await apiClient.post(`/api/user-creation-requests/me/resend?platform=${enc(platform)}`);
  return res.data as UserCreationInfo;
}

/** User: ask the server to re-sync from the platform and re-check whether their account exists. */
export async function syncUserCreationStatusNow(
  platform: string = 'redash',
): Promise<UserCreationInfo | null> {
  const res = await apiClient.post(`/api/user-creation-requests/me/sync-now?platform=${enc(platform)}`);
  return (res.data as UserCreationInfo | null) ?? null;
}
