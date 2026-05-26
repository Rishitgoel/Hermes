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
        updatedAt: Date;
        groupId: string;
        expiresAt: Date | null;
        revokedAt: Date | null;
        requesterId: string;
        requesterName: string;
        requesterEmail: string;
        justification: string;
        duration: import(".prisma/client").$Enums.AccessDuration;
        status: import(".prisma/client").$Enums.RequestStatus;
        reviewerId: string | null;
        reviewerName: string | null;
        reviewNote: string | null;
        reviewedAt: Date | null;
        provisionedAt: Date | null;
        provisionError: string | null;
        revokeReason: string | null;
    }>;
    reviewRequest(requestId: string, reviewer: {
        id: string;
        username: string;
    }, status: 'APPROVED' | 'REJECTED', note?: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        groupId: string;
        expiresAt: Date | null;
        revokedAt: Date | null;
        requesterId: string;
        requesterName: string;
        requesterEmail: string;
        justification: string;
        duration: import(".prisma/client").$Enums.AccessDuration;
        status: import(".prisma/client").$Enums.RequestStatus;
        reviewerId: string | null;
        reviewerName: string | null;
        reviewNote: string | null;
        reviewedAt: Date | null;
        provisionedAt: Date | null;
        provisionError: string | null;
        revokeReason: string | null;
    }>;
    revokeAccess(userAccessId: string, revoker: {
        id: string;
        username: string;
    }, reason?: string, force?: boolean): Promise<{
        id: string;
        userId: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userName: string;
        userEmail: string;
        groupId: string;
        externalUserId: string | null;
        grantedAt: Date;
        expiresAt: Date | null;
        revokedAt: Date | null;
        grantedBy: string;
        accessRequestId: string | null;
    }>;
    expireAccess(userAccessId: string): Promise<void>;
}
export declare const accessWorkflowService: AccessWorkflowService;
export default accessWorkflowService;
