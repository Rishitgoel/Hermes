import { AccessDuration } from '@prisma/client';
export declare class AccessWorkflowService {
    private calculateExpiry;
    createRequest(requester: {
        id: string;
        username: string;
        email: string;
    }, groupId: string, justification: string, duration: AccessDuration): Promise<{
        id: string;
        createdAt: Date;
        groupId: string;
        requesterId: string;
        requesterName: string;
        requesterEmail: string;
        justification: string;
        duration: import(".prisma/client").$Enums.AccessDuration;
        expiresAt: Date | null;
        status: import(".prisma/client").$Enums.RequestStatus;
        reviewerId: string | null;
        reviewerName: string | null;
        reviewNote: string | null;
        reviewedAt: Date | null;
        provisionedAt: Date | null;
        provisionError: string | null;
        revokedAt: Date | null;
        revokeReason: string | null;
        updatedAt: Date;
    }>;
    reviewRequest(requestId: string, reviewer: {
        id: string;
        username: string;
    }, status: 'APPROVED' | 'REJECTED', note?: string): Promise<{
        id: string;
        createdAt: Date;
        groupId: string;
        requesterId: string;
        requesterName: string;
        requesterEmail: string;
        justification: string;
        duration: import(".prisma/client").$Enums.AccessDuration;
        expiresAt: Date | null;
        status: import(".prisma/client").$Enums.RequestStatus;
        reviewerId: string | null;
        reviewerName: string | null;
        reviewNote: string | null;
        reviewedAt: Date | null;
        provisionedAt: Date | null;
        provisionError: string | null;
        revokedAt: Date | null;
        revokeReason: string | null;
        updatedAt: Date;
    }>;
    /**
     * Shared provisioning routine — used by reviewRequest (admin path) and
     * provisionWaitingRequests (post-setup path). Assumes the AccessRequest has
     * already been moved to PROVISIONING by the caller; on success transitions to
     * PROVISIONED, on failure to PROVISION_FAILED.
     */
    private _provision;
    /**
     * Bulk-reject all of a user's PENDING + WAITING_FOR_SETUP group requests in one transaction.
     * Called from user-creation service when an admin rejects a user-creation request.
     */
    cascadeRejectForUser(userId: string, note: string): Promise<number>;
    /**
     * After a user-creation completes (Redash sync detected the user), provision any
     * of that user's group requests that were queued in WAITING_FOR_SETUP.
     * Per-row try/catch so one provisioning failure doesn't abort the batch.
     */
    provisionWaitingRequests(userId: string): Promise<{
        provisioned: number;
        failed: number;
    }>;
    revokeAccess(userAccessId: string, revoker: {
        id: string;
        username: string;
    }, reason?: string, force?: boolean): Promise<{
        id: string;
        userId: string;
        createdAt: Date;
        externalUserId: string | null;
        groupId: string;
        expiresAt: Date | null;
        revokedAt: Date | null;
        updatedAt: Date;
        isActive: boolean;
        userName: string;
        userEmail: string;
        grantedAt: Date;
        grantedBy: string;
        accessRequestId: string | null;
    }>;
    expireAccess(userAccessId: string): Promise<void>;
}
export declare const accessWorkflowService: AccessWorkflowService;
export default accessWorkflowService;
