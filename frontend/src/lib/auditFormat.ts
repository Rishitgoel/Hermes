/** Shared between AuditLog.tsx (table) and AuditDetailModal.tsx (drill-in) so both
 * surfaces stay in sync — defined here rather than in either component to avoid a
 * circular import between the page and the modal it renders. */
export interface AuditLogEntry {
  id: string;
  action: string;
  performerId: string;
  performerName: string;
  targetUserId: string | null;
  targetUserName: string | null;
  groupId: string | null;
  accessRequestId: string | null;
  details: any;
  ipAddress: string | null;
  createdAt: string;
}

/** Same GRANT/SYNC → approved, REJECT/REVOKE → rejected, else neutral coloring used
 * for the action column badge and the detail modal's title badge. */
export const actionBadgeStyle = (action: string): { backgroundColor: string; color: string } => {
  if (action.includes('GRANT') || action.includes('SYNC')) {
    return { backgroundColor: 'var(--status-approved-bg)', color: 'var(--status-approved-text)' };
  }
  if (action.includes('REJECT') || action.includes('REVOKE')) {
    return { backgroundColor: 'var(--status-rejected-bg)', color: 'var(--status-rejected-text)' };
  }
  return { backgroundColor: 'var(--primary-light)', color: 'var(--primary)' };
};
