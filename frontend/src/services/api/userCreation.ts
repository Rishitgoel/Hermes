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
  justification: string | null;
  status: 'PENDING';
  submittedAt: string | null;
  createdAt: string;
}

/** User submits their DRAFT → PENDING. */
export async function submitUserCreationRequest(justification: string): Promise<UserCreationInfo> {
  const res = await apiClient.post('/api/user-creation-requests', { justification });
  return res.data as UserCreationInfo;
}

/** Admin: list all PENDING user-creation requests. */
export async function listPendingUserCreations(): Promise<PendingUserCreationRequest[]> {
  const res = await apiClient.get('/api/user-creation-requests/pending');
  return res.data as PendingUserCreationRequest[];
}

/** Admin: approve or reject a user-creation request. */
export async function reviewUserCreation(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<UserCreationInfo> {
  const res = await apiClient.put(`/api/user-creation-requests/${id}/review`, { status, note });
  return res.data as UserCreationInfo;
}

/** User: re-trigger the Redash invitation email. */
export async function resendRedashInvite(): Promise<UserCreationInfo> {
  const res = await apiClient.post('/api/user-creation-requests/me/resend');
  return res.data as UserCreationInfo;
}

/** User: ask the server to re-sync from Redash and re-check whether their account exists. */
export async function syncUserCreationStatusNow(): Promise<UserCreationInfo | null> {
  const res = await apiClient.post('/api/user-creation-requests/me/sync-now');
  return res.data as UserCreationInfo | null;
}
