export declare class SchedulerService {
    private expiryJob;
    private redashSyncJob;
    start(): void;
    stop(): void;
    private startExpiryJob;
    private startRedashSyncJob;
    checkAndRevokeExpiredAccess(): Promise<void>;
}
export declare const schedulerService: SchedulerService;
export default schedulerService;
