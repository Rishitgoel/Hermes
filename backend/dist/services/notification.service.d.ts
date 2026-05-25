export declare class NotificationService {
    createNotification(userId: string, title: string, message: string, linkUrl?: string): Promise<void>;
    notifyRequestCreated(requestId: string, groupId: string, groupName: string, requesterName: string, justification: string, duration: string): Promise<void>;
    notifyRequestReviewed(requesterId: string, groupName: string, approved: boolean, reviewerName: string, note?: string): Promise<void>;
    notifyAccessExpired(userId: string, groupName: string): Promise<void>;
    notifyAccessRevoked(userId: string, groupName: string, revokerName: string, reason?: string): Promise<void>;
}
export declare const notificationService: NotificationService;
export default notificationService;
