export declare class SchedulerService {
    private cronJob;
    start(): void;
    stop(): void;
    checkAndRevokeExpiredAccess(): Promise<void>;
}
export declare const schedulerService: SchedulerService;
export default schedulerService;
