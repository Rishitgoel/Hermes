export declare class NotificationService {
    createNotification(userId: string, title: string, message: string, linkUrl?: string): Promise<void>;
    notifyRequestCreated(requestId: string, groupId: string, groupName: string, requesterName: string, justification: string, duration: string): Promise<void>;
    notifyRequestReviewed(requesterId: string, groupName: string, approved: boolean, reviewerName: string, note?: string): Promise<void>;
    notifyAccessExpired(userId: string, groupName: string): Promise<void>;
    notifyAccessRevoked(userId: string, groupName: string, revokerName: string, reason?: string): Promise<void>;
    notifyAccessQueuedForSetup(requesterId: string, groupName: string, reviewerName: string): Promise<void>;
    private formatUserMention;
    notifyUserCreationSubmitted(requestId: string, userName: string, userEmail: string, justification: string | null): Promise<void>;
    notifyUserCreationApproved(requesterId: string, userEmail: string, reviewerName: string): Promise<void>;
    notifyUserCreationRejected(requesterId: string, reviewerName: string, note?: string): Promise<void>;
    notifyUserCreationCompleted(requesterId: string, userEmail: string): Promise<void>;
}
export declare const notificationService: NotificationService;
export default notificationService;
